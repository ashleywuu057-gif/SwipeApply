import {
  makeEnvelope, scanResultSchema, type ExecutionOutcome, type Reply, type ScanResult,
} from '../shared/protocol';
import { isInjectablePage } from '../shared/urls';
import type { FieldRef, FieldResult, FillAction, KnownSection, RememberedAnswer, RunPhase, RunReport } from '../shared/types';
import { NEVER_REMEMBER, readRemembered } from './remembered';
import { applicableRules, type RuleScope } from './rules';
import { planRun, recordSummaries, type PlanResult } from './planner';
import { isDemoProfile, isLoopbackOrigin } from './profiles';
import { getState, mutate, removeActiveRun, upsertActiveRun, getActiveRuns } from './storage';

/** 运行协调：绑定 tab/document/run，分派扫描与执行，汇总报告。 */

export class RunError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RunError';
  }
}

interface RunContext {
  runId: string;
  /** 用户为整组网页经历指定的履历记录：recordInstanceId -> recordId。 */
  userRecordBindings: Map<string, string>;
  nonce: string;
  tabId: number;
  documentId: string | null;
  origin: string;
  routeKey: string;
  profileVersionId: string;
  applicationId: string | null;
  scan: ScanResult;
  plan: PlanResult;
  planRevision: number;
  executionPass: number;
  /** 失败字段最多额外自动重试一次，避免动态补扫形成循环。 */
  automaticRetryKeys: Set<string>;
  report: RunReport;
  lastSeq: number;
  finished: boolean;
  /** 手动重试/整组绑定只执行用户指定的动作，完成后不触发全页自动补扫。 */
  skipNextAutomaticContinuation: boolean;
}

const runs = new Map<string, RunContext>();
const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
/** 超过这个时间没有任何进度，就查询一次目标页面，仍失联则标记中断。 */
const PROGRESS_WATCHDOG_MS = 10_000;
const runsByDocument = new Map<string, string>();
const PROGRESS_PERSIST_MS = 500;
/** 下拉选择可能继续展开新的条件字段；一键填写最多做三次稳定化扫描。 */
const MAX_EXECUTION_PASSES = 3;
const lastPersist = new Map<string, number>();

const documentKey = (tabId: number, documentId: string | null) => `${tabId}::${documentId ?? 'main'}`;

async function sendToContent<T>(tabId: number, type: string, payload: unknown): Promise<T> {
  const envelope = makeEnvelope(type, payload);
  let reply: Reply<T> | undefined;
  try {
    reply = (await chrome.tabs.sendMessage(tabId, envelope, { frameId: 0 })) as Reply<T>;
  } catch (error) {
    throw new RunError('CONTENT_UNREACHABLE', `无法与网页通信：${(error as Error).message}`);
  }
  if (!reply) throw new RunError('CONTENT_UNREACHABLE', '网页没有回应，请刷新页面后重试');
  if (!reply.ok) throw new RunError(reply.error.code, reply.error.message);
  return reply.data;
}

async function injectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ['content.js'],
  });
}

function newRunReport(input: {
  runId: string;
  profileVersionId: string;
  applicationId: string | null;
  origin: string;
  routeKey: string;
  phase: RunPhase;
}): RunReport {
  return {
    id: input.runId,
    profileVersionId: input.profileVersionId,
    applicationId: input.applicationId,
    origin: input.origin,
    routeKey: input.routeKey,
    phase: input.phase,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    modelCalls: 0,
    fields: [],
  };
}

async function persistReport(report: RunReport): Promise<void> {
  await mutate(
    {
      requestId: `run-${report.id}-${report.phase}-${report.fields.length}-${Date.now()}`,
      bumpRevision: false,
    },
    ({ state }) => {
      const others = state.recentRuns.filter((entry) => entry.id !== report.id);
      return { state: { ...state, recentRuns: [...others, report] }, data: null };
    },
  );
}

/**
 * 扫描预览也要覆盖所有字段：能生成动作的字段标为 ready，真正有阻塞的字段保留 pending。
 * 否则「6 个可填 + 45 个待处理」会被错误显示成「本轮共 45 个字段」。
 */
function reportFieldsForPlan(scan: ScanResult, plan: PlanResult): FieldResult[] {
  const blocked = new Map(plan.results.map((field) => [field.fieldId, field]));
  const ready = new Map(plan.actions.map((action) => [action.fieldId, action]));
  const fields: FieldResult[] = [];
  for (const descriptor of scan.descriptors) {
    const blockedField = blocked.get(descriptor.fieldId);
    if (blockedField) {
      fields.push(blockedField);
      continue;
    }
    const action = ready.get(descriptor.fieldId);
    if (!action) continue;
    fields.push({
      fieldId: descriptor.fieldId,
      section: descriptor.section,
      source: action.source,
      outcome: 'ready',
      reasonCode: 'READY_TO_FILL',
      label: descriptor.label,
      elapsedMs: 0,
    });
  }
  return fields;
}

export interface PrepareRunInput {
  targetTabId: number;
  profileVersionId: string;
  mode: 'scan' | 'fill';
  applicationId: string | null;
}

export interface PrepareRunOutput {
  runId: string;
  phase: RunPhase;
  scan: {
    origin: string;
    routeKey: string;
    pageTitle: string;
    fieldCount: number;
    adapterId: string | null;
    truncated: boolean;
    truncationReason: string | null;
    jobCandidate: ScanResult['jobCandidate'];
  };
  planned: number;
  pending: number;
  reused: boolean;
  notes: string[];
}

/** jobprep：你记住的补填内容，每次准备填写前重新读一遍（规划器是同步的纯函数，这里备一份给所有 planRun 用） */
let rememberedAnswers: RememberedAnswer[] = [];

export async function prepareRun(input: PrepareRunInput): Promise<PrepareRunOutput> {
  rememberedAnswers = await readRemembered().catch(() => []);
  const state = await getState();
  const profile = state.profiles.find((entry) => entry.profileVersionId === input.profileVersionId);
  if (!profile) throw new RunError('PROFILE_NOT_FOUND', '找不到选定的履历版本');

  const tab = await chrome.tabs.get(input.targetTabId);
  if (!tab.url) throw new RunError('NO_URL', '无法读取当前标签页地址');
  const injectable = isInjectablePage(tab.url);
  if (!injectable.ok) throw new RunError('PAGE_NOT_SUPPORTED', injectable.message);

  const origin = new URL(tab.url).origin;
  if (isDemoProfile(profile) && !isLoopbackOrigin(origin)) {
    throw new RunError(
      'DEMO_PROFILE_RESTRICTED',
      '当前履历标记为虚构演示资料，只能在本地演示页面（127.0.0.1 / localhost）填写。',
    );
  }

  // 同一 document 已有运行时返回现有 runId 与进度，不创建并行运行。
  const existingRunId = runsByDocument.get(documentKey(input.targetTabId, null));
  const existing = existingRunId ? runs.get(existingRunId) : undefined;
  if (existing && !existing.finished) {
    return {
      runId: existing.runId,
      phase: existing.report.phase,
      scan: summarizeScan(existing.scan),
      planned: existing.plan.actions.length,
      pending: existing.plan.results.length,
      reused: true,
      notes: ['这一页已有正在进行的填写，已返回原有进度'],
    };
  }

  await injectContentScript(input.targetTabId);

  const runId = `run-${crypto.randomUUID()}`;
  const nonce = crypto.randomUUID();
  const rawScan = await sendToContent<unknown>(input.targetTabId, 'SCAN_PAGE', { runId, nonce });
  const parsedScan = scanResultSchema.safeParse(rawScan);
  if (!parsedScan.success) throw new RunError('BAD_SCAN', '网页扫描结果格式不正确');
  let scan = parsedScan.data;

  const notes: string[] = [...(scan.diagnostics ?? [])];
  if (scan.truncated && scan.truncationReason) notes.push(scan.truncationReason);

  const scope: RuleScope = { origin: scan.origin, routeKey: scan.routeKey, formFingerprint: scan.formFingerprint };
  let rules = applicableRules(state, scope, scan.descriptors);
  let plan = planRun({ remembered: rememberedAnswers, scan, profile, rules });

  const report = newRunReport({
    runId,
    profileVersionId: profile.profileVersionId,
    applicationId: input.applicationId,
    origin: scan.origin,
    routeKey: scan.routeKey,
    phase: input.mode === 'scan' ? 'planned' : 'filling',
  });

  const context: RunContext = {
    runId,
    userRecordBindings: new Map(),
    nonce,
    tabId: input.targetTabId,
    documentId: null,
    origin: scan.origin,
    routeKey: scan.routeKey,
    profileVersionId: profile.profileVersionId,
    applicationId: input.applicationId,
    scan,
    plan,
    planRevision: 1,
    executionPass: 1,
    automaticRetryKeys: new Set(),
    report,
    lastSeq: 0,
    finished: false,
    skipNextAutomaticContinuation: false,
  };

  if (input.mode === 'scan') {
    report.fields = reportFieldsForPlan(scan, plan);
    report.phase = 'planned';
    report.finishedAt = new Date().toISOString();
    context.finished = true;
    runs.set(runId, context);
    runsByDocument.set(documentKey(input.targetTabId, null), runId);
    await persistReport(report);
    return {
      runId,
      phase: 'planned',
      scan: summarizeScan(scan),
      planned: plan.actions.length,
      pending: plan.results.length,
      reused: false,
      notes,
    };
  }

  // 需要新增经历时先新增、重新扫描并重新绑定，再生成最终动作。
  if (plan.addRequests.length > 0) {
    try {
      const added = await sendToContent<{ scan: unknown; notes: string[] }>(
        input.targetTabId,
        'ADD_RECORDS',
        { runId, nonce, requests: plan.addRequests },
      );
      notes.push(...added.notes);
      const rescanned = scanResultSchema.safeParse(added.scan);
      if (rescanned.success) {
        scan = rescanned.data;
        const newScope: RuleScope = {
          origin: scan.origin,
          routeKey: scan.routeKey,
          formFingerprint: scan.formFingerprint,
        };
        rules = applicableRules(state, newScope, scan.descriptors);
        plan = planRun({ remembered: rememberedAnswers, scan, profile, rules });
        context.scan = scan;
        context.plan = plan;
        context.planRevision += 1;
      }
    } catch (error) {
      notes.push(`新增经历失败：${(error as Error).message}`);
    }
  }

  report.fields = reportFieldsForPlan(scan, plan);
  runs.set(runId, context);
  runsByDocument.set(documentKey(input.targetTabId, null), runId);
  await persistReport(report);
  await upsertActiveRun({
    runId,
    tabId: input.targetTabId,
    documentId: context.documentId ?? '',
    nonce,
    lastSeq: 0,
    lastSeenAt: new Date().toISOString(),
    planRevision: context.planRevision,
  });

  await sendToContent(input.targetTabId, 'EXECUTE_PLAN', {
    runId,
    nonce,
    planRevision: context.planRevision,
    actions: plan.actions,
    addRecordActions: [],
    budgetMs: 45_000,
  });
  scheduleWatchdog(context);

  if (input.applicationId) {
    await markApplicationFilling(input.applicationId);
  }

  return {
    runId,
    phase: 'filling',
    scan: summarizeScan(scan),
    planned: plan.actions.length,
    pending: plan.results.length,
    reused: false,
    notes,
  };
}

function summarizeScan(scan: ScanResult): PrepareRunOutput['scan'] {
  return {
    origin: scan.origin,
    routeKey: scan.routeKey,
    pageTitle: scan.pageTitle,
    fieldCount: scan.descriptors.length,
    adapterId: scan.adapterId,
    truncated: scan.truncated,
    truncationReason: scan.truncationReason,
    jobCandidate: scan.jobCandidate,
  };
}

async function markApplicationFilling(applicationId: string): Promise<void> {
  await mutate({ requestId: `filling-${applicationId}-${Date.now()}` }, ({ state }) => {
    const record = state.applications.find((entry) => entry.id === applicationId);
    if (!record || record.status !== 'planned') return { state, data: null };
    const now = new Date().toISOString();
    const updated = {
      ...record,
      status: 'filling' as const,
      updatedAt: now,
      timeline: [...record.timeline, { at: now, from: record.status, to: 'filling' as const, reason: '开始填写表单' }],
    };
    return {
      state: { ...state, applications: state.applications.map((entry) => (entry.id === record.id ? updated : entry)) },
      data: null,
    };
  });
}

function mergeOutcome(report: RunReport, scan: ScanResult, outcome: ExecutionOutcome): void {
  const descriptor = scan.descriptors.find((item) => item.fieldId === outcome.fieldId);
  const index = report.fields.findIndex((field) => field.fieldId === outcome.fieldId);
  const merged: FieldResult = {
    fieldId: outcome.fieldId,
    section: descriptor?.section ?? report.fields[index]?.section ?? 'unknown',
    source: report.fields[index]?.source ?? null,
    outcome: outcome.outcome,
    reasonCode: outcome.reasonCode,
    label: descriptor?.label ?? report.fields[index]?.label ?? outcome.fieldId,
    elapsedMs: outcome.elapsedMs,
  };
  if (index >= 0) report.fields[index] = merged;
  else report.fields.push(merged);
}

type ScannedDescriptor = ScanResult['descriptors'][number];

/** fieldId 会随 React 插入条件字段而移动，跨扫描只用语义身份关联报告。 */
function descriptorIdentity(descriptor: ScannedDescriptor): string {
  return [
    descriptor.section,
    descriptor.recordInstanceId ?? '',
    descriptor.semanticFingerprint,
  ].join('::');
}

function uniquePreviousFields(scan: ScanResult, report: RunReport): Map<string, FieldResult> {
  const grouped = new Map<string, FieldResult[]>();
  for (const descriptor of scan.descriptors) {
    const field = report.fields.find((item) => item.fieldId === descriptor.fieldId);
    if (!field) continue;
    const key = descriptorIdentity(descriptor);
    const group = grouped.get(key) ?? [];
    group.push(field);
    grouped.set(key, group);
  }
  return new Map(
    [...grouped].flatMap(([key, fields]) => fields.length === 1 ? [[key, fields[0]!] as const] : []),
  );
}

function remapReportFields(
  previousScan: ScanResult,
  previousReport: RunReport,
  nextScan: ScanResult,
  nextPlan: PlanResult,
): FieldResult[] {
  const previous = uniquePreviousFields(previousScan, previousReport);
  const fresh = reportFieldsForPlan(nextScan, nextPlan);
  return fresh.map((field) => {
    const descriptor = nextScan.descriptors.find((item) => item.fieldId === field.fieldId);
    const prior = descriptor ? previous.get(descriptorIdentity(descriptor)) : null;
    if (!prior || prior.outcome === 'ready') return field;
    return {
      ...prior,
      fieldId: field.fieldId,
      section: field.section,
      source: field.source ?? prior.source,
      label: field.label,
    };
  });
}

const AUTOMATIC_RETRY_REASONS = new Set<FieldResult['reasonCode']>([
  'VALIDATION_FAILED', 'TIMEOUT', 'STALE_PAGE',
]);

/**
 * 选择学历、国家等结构化值后，很多 ATS 才把后续字段挂进 DOM。
 * 补扫后仅填写新出现的空字段，并把暂态失败项额外重试一次。
 */
async function continueWithRevealedFields(context: RunContext): Promise<boolean> {
  if (context.executionPass >= MAX_EXECUTION_PASSES) return false;

  const state = await getState();
  const profile = state.profiles.find((entry) => entry.profileVersionId === context.profileVersionId);
  if (!profile) return false;

  const rescannedReply = await sendToContent<{ scan: unknown; notes: string[] }>(
    context.tabId,
    'ADD_RECORDS',
    { runId: context.runId, nonce: context.nonce, requests: [] },
  );
  const parsed = scanResultSchema.safeParse(rescannedReply.scan);
  if (!parsed.success) return false;

  const nextScan = parsed.data;
  const rules = applicableRules(state, {
    origin: nextScan.origin,
    routeKey: nextScan.routeKey,
    formFingerprint: nextScan.formFingerprint,
  }, nextScan.descriptors);
  const nextPlan = planRun({ remembered: rememberedAnswers,
    scan: nextScan,
    profile,
    rules,
    userRecordBindings: context.userRecordBindings,
  });

  const previousScan = context.scan;
  const previousFields = uniquePreviousFields(previousScan, context.report);
  const previousKeys = new Set(previousScan.descriptors.map(descriptorIdentity));
  const descriptorById = new Map(nextScan.descriptors.map((descriptor) => [descriptor.fieldId, descriptor]));
  const actions = nextPlan.actions.filter((action) => {
    const descriptor = descriptorById.get(action.fieldId);
    if (!descriptor || !descriptor.empty) return false;
    const key = descriptorIdentity(descriptor);
    if (!previousKeys.has(key)) return true;
    const prior = previousFields.get(key);
    if (!prior || prior.outcome !== 'failed' || !AUTOMATIC_RETRY_REASONS.has(prior.reasonCode) ||
        context.automaticRetryKeys.has(key)) return false;
    context.automaticRetryKeys.add(key);
    return true;
  });

  context.report.fields = remapReportFields(previousScan, context.report, nextScan, nextPlan);
  context.scan = nextScan;
  context.plan = nextPlan;
  if (actions.length === 0) return false;

  context.executionPass += 1;
  context.planRevision += 1;
  context.report.phase = 'filling';
  context.report.finishedAt = null;
  context.finished = false;
  await persistReport(context.report);
  await upsertActiveRun({
    runId: context.runId,
    tabId: context.tabId,
    documentId: context.documentId ?? '',
    nonce: context.nonce,
    lastSeq: context.lastSeq,
    lastSeenAt: new Date().toISOString(),
    planRevision: context.planRevision,
  });
  await sendToContent(context.tabId, 'EXECUTE_PLAN', {
    runId: context.runId,
    nonce: context.nonce,
    planRevision: context.planRevision,
    actions,
    addRecordActions: [],
    budgetMs: 20_000,
  });
  scheduleWatchdog(context);
  return true;
}

export async function handleProgress(payload: {
  runId: string;
  nonce: string;
  seq: number;
  completed: number;
  total: number;
  outcome: ExecutionOutcome | null;
}): Promise<void> {
  const context = runs.get(payload.runId);
  if (!context || context.nonce !== payload.nonce) return;
  if (payload.seq <= context.lastSeq) return;
  context.lastSeq = payload.seq;

  if (payload.outcome) {
    // 计划阶段这些字段记录为动作，执行结果回来后覆盖为真实结果。
    const known = context.plan.actions.find((action) => action.fieldId === payload.outcome!.fieldId);
    if (known && !context.report.fields.some((field) => field.fieldId === known.fieldId)) {
      context.report.fields.push({
        fieldId: known.fieldId,
        section: context.scan.descriptors.find((d) => d.fieldId === known.fieldId)?.section ?? 'unknown',
        source: known.source,
        outcome: 'pending',
        reasonCode: 'TIMEOUT',
        label: context.scan.descriptors.find((d) => d.fieldId === known.fieldId)?.label ?? known.fieldId,
        elapsedMs: 0,
      });
    }
    mergeOutcome(context.report, context.scan, payload.outcome);
  }

  scheduleWatchdog(context);
  const now = Date.now();
  if (now - (lastPersist.get(payload.runId) ?? 0) > PROGRESS_PERSIST_MS) {
    lastPersist.set(payload.runId, now);
    await persistReport(context.report);
  }
  await upsertActiveRun({
    runId: context.runId,
    tabId: context.tabId,
    documentId: context.documentId ?? '',
    nonce: context.nonce,
    lastSeq: context.lastSeq,
    lastSeenAt: new Date().toISOString(),
    planRevision: context.planRevision,
  });
}

export async function handleFinished(payload: {
  runId: string;
  nonce: string;
  seq: number;
  phase: 'completed' | 'cancelled' | 'interrupted' | 'failed';
  outcomes: ExecutionOutcome[];
  message: string | null;
}): Promise<void> {
  const context = runs.get(payload.runId);
  if (!context || context.nonce !== payload.nonce) return;

  if (payload.seq <= context.lastSeq) return;
  context.lastSeq = payload.seq;
  for (const outcome of payload.outcomes) mergeOutcome(context.report, context.scan, outcome);
  clearWatchdog(payload.runId);

  const skipAutomaticContinuation = context.skipNextAutomaticContinuation;
  context.skipNextAutomaticContinuation = false;
  if (payload.phase === 'completed' && !skipAutomaticContinuation) {
    try {
      if (await continueWithRevealedFields(context)) return;
    } catch {
      // 补扫失败不抹掉已完成的第一轮；报告仍按实际执行结果结束。
    }
  }

  context.report.phase = payload.phase;
  context.report.finishedAt = new Date().toISOString();
  context.finished = true;
  lastPersist.delete(payload.runId);
  await persistReport(context.report);
  await removeActiveRun(payload.runId);
}

function clearWatchdog(runId: string): void {
  const timer = watchdogs.get(runId);
  if (timer) clearTimeout(timer);
  watchdogs.delete(runId);
}

/** 页面导航、刷新或脚本失联后，本轮不会永远停在「填写中」。 */
function scheduleWatchdog(context: RunContext): void {
  clearWatchdog(context.runId);
  const timer = setTimeout(() => {
    void (async () => {
      if (context.finished) return;
      let alive = false;
      try {
        const reply = await sendToContent<{ alive: boolean; running: boolean; stale: boolean }>(
          context.tabId,
          'PING_RUN',
          { runId: context.runId, nonce: context.nonce },
        );
        alive = reply.alive && reply.running && !reply.stale;
      } catch {
        alive = false;
      }
      if (alive) {
        scheduleWatchdog(context);
        return;
      }
      context.report.phase = 'interrupted';
      context.report.finishedAt = new Date().toISOString();
      context.report.fields = context.report.fields.map((field) =>
        field.outcome === 'pending' && field.reasonCode === 'TIMEOUT'
          ? { ...field, reasonCode: 'STALE_PAGE' as const }
          : field,
      );
      context.finished = true;
      await persistReport(context.report);
      await removeActiveRun(context.runId);
      clearWatchdog(context.runId);
    })();
  }, PROGRESS_WATCHDOG_MS);
  watchdogs.set(context.runId, timer);
}

export interface RunSnapshot {
  report: RunReport;
  planned: number;
  summary: Record<string, number>;
  descriptors: Array<{
    fieldId: string;
    label: string;
    section: string;
    controlKind: string;
    datePrecision: 'year' | 'month' | 'day' | null;
    required: boolean;
    empty: boolean;
    options: number;
    unsupportedReason: string | null;
    recordInstanceId: string | null;
  }>;
  jobCandidate: ScanResult['jobCandidate'];
  notes: string[];
  excessEmptyRecordInstanceIds: string[];
}

export async function getRun(runId: string): Promise<RunSnapshot> {
  const context = runs.get(runId);
  if (context) {
    return {
      report: context.report,
      planned: context.plan.actions.length,
      summary: summarizeResults(context.report.fields),
      descriptors: context.scan.descriptors.map((descriptor) => ({
        fieldId: descriptor.fieldId,
        label: descriptor.label,
        section: descriptor.section,
        controlKind: descriptor.controlKind,
        datePrecision: descriptor.datePrecision,
        required: descriptor.required,
        empty: descriptor.empty,
        options: descriptor.options.length,
        unsupportedReason: descriptor.unsupportedReason,
        recordInstanceId: descriptor.recordInstanceId,
      })),
      jobCandidate: context.scan.jobCandidate,
      notes: context.plan.recordBindingNotes,
      excessEmptyRecordInstanceIds: context.plan.excessEmptyRecordInstanceIds,
    };
  }
  // worker 重启后从持久化报告恢复摘要；动作不从磁盘重放。
  const state = await getState();
  const report = state.recentRuns.find((entry) => entry.id === runId);
  if (!report) throw new RunError('RUN_NOT_FOUND', '找不到这一轮运行记录');
  return {
    report,
    planned: report.fields.filter((field) => field.outcome === 'ready').length,
    summary: summarizeResults(report.fields),
    descriptors: [],
    jobCandidate: null,
    notes: ['扩展后台重启过，字段定位信息需要重新扫描'],
    excessEmptyRecordInstanceIds: [],
  };
}

export function summarizeResults(fields: FieldResult[]): Record<string, number> {
  const summary: Record<string, number> = { ready: 0, filled: 0, unchanged: 0, preserved: 0, pending: 0, failed: 0 };
  for (const field of fields) summary[field.outcome] = (summary[field.outcome] ?? 0) + 1;
  return summary;
}

export async function cancelRun(runId: string): Promise<void> {
  const context = runs.get(runId);
  if (!context) throw new RunError('RUN_NOT_FOUND', '找不到这一轮运行');
  try {
    await sendToContent(context.tabId, 'CANCEL_EXECUTION', { runId, nonce: context.nonce });
  } catch (error) {
    context.report.phase = 'interrupted';
    context.finished = true;
    await persistReport(context.report);
    await removeActiveRun(runId);
    throw new RunError('CANCEL_FAILED', `已在本地标记为中断：${(error as Error).message}`);
  }
}

export async function locateField(runId: string, fieldId: string): Promise<void> {
  const context = runs.get(runId);
  if (!context) throw new RunError('RUN_NOT_FOUND', '这一轮运行已经结束，请重新扫描');
  await sendToContent(context.tabId, 'HIGHLIGHT_FIELD', { runId, nonce: context.nonce, fieldId });
}

export interface RetryFieldInput {
  runId: string;
  fieldId: string;
  source: FieldRef;
  overwriteExisting: boolean;
}

export interface RetryFieldOutput {
  outcome: ExecutionOutcome;
  verified: boolean;
  descriptor: { label: string; section: string; controlKind: string; fingerprint: string } | null;
}

/** 单项重试：使用用户指定的源字段，只影响这一个字段。 */
export async function retryField(input: RetryFieldInput): Promise<RetryFieldOutput> {
  const context = runs.get(input.runId);
  if (!context) throw new RunError('RUN_NOT_FOUND', '这一轮运行已经结束，请重新扫描');
  const state = await getState();
  const profile = state.profiles.find((entry) => entry.profileVersionId === context.profileVersionId);
  if (!profile) throw new RunError('PROFILE_NOT_FOUND', '找不到本轮使用的履历版本');

  const descriptor = context.scan.descriptors.find((item) => item.fieldId === input.fieldId);
  if (!descriptor) throw new RunError('FIELD_NOT_FOUND', '找不到这个字段，请重新扫描');

  const manualBindings = new Map<string, Omit<FieldRef, 'recordId'>>([
    [input.fieldId, { section: input.source.section, field: input.source.field }],
  ]);
  const recordOverride = new Map<string, string>();
  if (descriptor.recordInstanceId && input.source.recordId) {
    recordOverride.set(descriptor.recordInstanceId, input.source.recordId);
  }

  const plan = planRun({ remembered: rememberedAnswers,
    scan: {
      ...context.scan,
      recordInstances: context.scan.recordInstances.map((instance) =>
        recordOverride.has(instance.recordInstanceId)
          ? { ...instance, identityHint: null, degreeHint: null }
          : instance,
      ),
    },
    profile,
    rules: [],
    manualBindings,
    onlyFieldIds: new Set([input.fieldId]),
    overwriteFieldIds: input.overwriteExisting ? new Set([input.fieldId]) : new Set(),
  });

  // 用户明确指定了记录时直接改写动作的 source，避免再次经过绑定推断。
  const actions: FillAction[] = plan.actions.map((action) =>
    action.fieldId === input.fieldId ? { ...action, source: input.source } : action,
  );

  if (actions.length === 0) {
    const failedResult = plan.results.find((result) => result.fieldId === input.fieldId);
    const outcome: ExecutionOutcome = {
      fieldId: input.fieldId,
      outcome: 'pending',
      reasonCode: failedResult?.reasonCode ?? 'NO_MATCH',
      message: '这个源字段无法写入该控件',
      elapsedMs: 0,
    };
    mergeOutcome(context.report, context.scan, outcome);
    await persistReport(context.report);
    return { outcome, verified: false, descriptor: null };
  }

  context.plan = { ...plan, actions };
  context.planRevision += 1;
  await beginManualExecution(context, actions);

  try {
    await sendToContent(context.tabId, 'EXECUTE_PLAN', {
      runId: context.runId,
      nonce: context.nonce,
      planRevision: context.planRevision,
      actions,
      addRecordActions: [],
      budgetMs: 10_000,
    });
  } catch (error) {
    await failManualExecution(context);
    throw error;
  }

  const outcome = await waitForFieldOutcome(context, input.fieldId, 12_000);
  return {
    outcome,
    verified: outcome.outcome === 'filled',
    descriptor: {
      label: descriptor.label,
      section: descriptor.section,
      controlKind: descriptor.controlKind,
      fingerprint: descriptor.semanticFingerprint,
    },
  };
}

function waitForFieldOutcome(context: RunContext, fieldId: string, timeoutMs: number): Promise<ExecutionOutcome> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      const field = context.report.fields.find((entry) => entry.fieldId === fieldId);
      // RUN_PROGRESS 只是即时结果；内容脚本随后还会检查异步校验和网页回滚。
      // 必须等 RUN_FINISHED 合并最终结果，否则调用方可能在旧执行仍运行时开始下一轮。
      if (context.finished && field && field.outcome !== 'pending') {
        resolve({
          fieldId,
          outcome: field.outcome,
          reasonCode: field.reasonCode,
          message: '',
          elapsedMs: field.elapsedMs,
        });
        return;
      }
      if (Date.now() > deadline) {
        resolve({ fieldId, outcome: 'failed', reasonCode: 'TIMEOUT', message: '重试超时', elapsedMs: 0 });
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function beginManualExecution(context: RunContext, actions: FillAction[]): Promise<void> {
  const actionByField = new Map(actions.map((action) => [action.fieldId, action]));
  context.report.fields = context.report.fields.map((field) => {
    const action = actionByField.get(field.fieldId);
    return action
      ? { ...field, source: action.source, outcome: 'pending' as const, reasonCode: 'TIMEOUT' as const, elapsedMs: 0 }
      : field;
  });
  context.report.phase = 'filling';
  context.report.finishedAt = null;
  context.finished = false;
  context.skipNextAutomaticContinuation = true;
  await persistReport(context.report);
  await upsertActiveRun({
    runId: context.runId,
    tabId: context.tabId,
    documentId: context.documentId ?? '',
    nonce: context.nonce,
    lastSeq: context.lastSeq,
    lastSeenAt: new Date().toISOString(),
    planRevision: context.planRevision,
  });
}

async function failManualExecution(context: RunContext): Promise<void> {
  context.skipNextAutomaticContinuation = false;
  context.finished = true;
  context.report.phase = 'failed';
  context.report.finishedAt = new Date().toISOString();
  await persistReport(context.report);
  await removeActiveRun(context.runId);
}

export interface BindRecordInput {
  runId: string;
  recordInstanceId: string;
  recordId: string;
}

export interface BindRecordOutput {
  section: string;
  filled: number;
  pending: number;
  outcomes: ExecutionOutcome[];
}

/**
 * 用户为「这一组网页经历」指定对应的履历记录，一次生效整组字段。
 *
 * 页面上的经历位置少于履历条数时（例如只有一段教育位置、履历里有本科和硕士），
 * 扩展不会猜；这里让用户明确指定后再按正常流程生成动作、执行并回读校验。
 */
export async function bindRecord(input: BindRecordInput): Promise<BindRecordOutput> {
  const context = runs.get(input.runId);
  if (!context) throw new RunError('RUN_NOT_FOUND', '这一轮运行已经结束，请重新扫描');
  const state = await getState();
  const profile = state.profiles.find((entry) => entry.profileVersionId === context.profileVersionId);
  if (!profile) throw new RunError('PROFILE_NOT_FOUND', '找不到本轮使用的履历版本');

  const instance = context.scan.recordInstances.find((item) => item.recordInstanceId === input.recordInstanceId);
  if (!instance) throw new RunError('RECORD_NOT_FOUND', '找不到这一组网页经历，请重新扫描');
  if (instance.section === 'unknown') throw new RunError('RECORD_NOT_FOUND', '这一组字段没有归属到可识别的分区');

  const summaries = recordSummaries(profile.data, instance.section as KnownSection);
  if (!summaries.some((record) => record.id === input.recordId)) {
    throw new RunError('RECORD_NOT_FOUND', '履历中找不到这条经历');
  }

  context.userRecordBindings.set(input.recordInstanceId, input.recordId);
  const rules = applicableRules(state, {
    origin: context.scan.origin,
    routeKey: context.scan.routeKey,
    formFingerprint: context.scan.formFingerprint,
  }, context.scan.descriptors);

  const plan = planRun({ remembered: rememberedAnswers,
    scan: context.scan,
    profile,
    rules,
    userRecordBindings: context.userRecordBindings,
  });
  context.plan = plan;
  context.planRevision += 1;

  const fieldIds = new Set(
    context.scan.descriptors
      .filter((descriptor) => descriptor.recordInstanceId === input.recordInstanceId)
      .map((descriptor) => descriptor.fieldId),
  );
  const actions = plan.actions.filter((action) => fieldIds.has(action.fieldId));

  // 这一组里没有动作时，把重新计算出的原因写回报告，让用户看到新的说明。
  for (const result of plan.results) {
    if (!fieldIds.has(result.fieldId)) continue;
    const index = context.report.fields.findIndex((field) => field.fieldId === result.fieldId);
    if (index >= 0) context.report.fields[index] = result;
    else context.report.fields.push(result);
  }

  if (actions.length === 0) {
    await persistReport(context.report);
    return { section: instance.section, filled: 0, pending: fieldIds.size, outcomes: [] };
  }

  await beginManualExecution(context, actions);

  try {
    await sendToContent(context.tabId, 'EXECUTE_PLAN', {
      runId: context.runId,
      nonce: context.nonce,
      planRevision: context.planRevision,
      actions,
      addRecordActions: [],
      budgetMs: 20_000,
    });
  } catch (error) {
    await failManualExecution(context);
    throw error;
  }

  const outcomes: ExecutionOutcome[] = [];
  for (const action of actions) {
    outcomes.push(await waitForFieldOutcome(context, action.fieldId, 25_000));
  }
  await persistReport(context.report);

  return {
    section: instance.section,
    filled: outcomes.filter((outcome) => outcome.outcome === 'filled' || outcome.outcome === 'unchanged').length,
    pending: outcomes.filter((outcome) => outcome.outcome !== 'filled' && outcome.outcome !== 'unchanged').length,
    outcomes,
  };
}

export interface RuleScopeForRun {
  scope: RuleScope;
  descriptor: { label: string; section: string; controlKind: string; fingerprint: string };
}

export function ruleScopeForField(runId: string, fieldId: string): RuleScopeForRun {
  const context = runs.get(runId);
  if (!context) throw new RunError('RUN_NOT_FOUND', '这一轮运行已经结束，请重新扫描');
  const descriptor = context.scan.descriptors.find((item) => item.fieldId === fieldId);
  if (!descriptor) throw new RunError('FIELD_NOT_FOUND', '找不到这个字段');
  return {
    scope: {
      origin: context.scan.origin,
      routeKey: context.scan.routeKey,
      formFingerprint: context.scan.formFingerprint,
    },
    descriptor: {
      label: descriptor.label,
      section: descriptor.section,
      controlKind: descriptor.controlKind,
      fingerprint: descriptor.semanticFingerprint,
    },
  };
}

export function fieldResultOf(runId: string, fieldId: string): FieldResult | null {
  const context = runs.get(runId);
  if (!context) return null;
  return context.report.fields.find((field) => field.fieldId === fieldId) ?? null;
}

/** 后台重启后检查失联的运行；超过 10 秒没有进度则查询一次，仍失联标为中断。 */
export async function reconcileActiveRuns(): Promise<void> {
  const metas = await getActiveRuns();
  for (const meta of metas) {
    if (runs.has(meta.runId)) continue;
    let alive = false;
    try {
      const reply = await sendToContent<{ alive: boolean }>(meta.tabId, 'PING_RUN', {
        runId: meta.runId,
        nonce: meta.nonce,
      });
      alive = reply.alive;
    } catch {
      alive = false;
    }
    if (alive) continue;
    await mutate({ requestId: `interrupt-${meta.runId}`, bumpRevision: false }, ({ state }) => {
      const report = state.recentRuns.find((entry) => entry.id === meta.runId);
      if (!report || report.finishedAt) return { state, data: null };
      const updated: RunReport = {
        ...report,
        phase: 'interrupted',
        finishedAt: new Date().toISOString(),
        fields: report.fields.map((field) =>
          field.outcome === 'pending' && field.reasonCode === 'TIMEOUT'
            ? { ...field, reasonCode: 'STALE_PAGE' as const }
            : field,
        ),
      };
      return {
        state: { ...state, recentRuns: state.recentRuns.map((entry) => (entry.id === report.id ? updated : entry)) },
        data: null,
      };
    });
    await removeActiveRun(meta.runId);
  }
}

/* ---------------- jobprep：记住你手动补填的内容 ---------------- */

/** 每个网站都不一样、不该跨岗位复用的内容：默认不勾选 */
const JOB_SPECIFIC = /推荐|内推|意向|期望|城市|地点|职位|岗位|渠道|来源|附件|备注|自我|说明|评价|简介|作品|链接|薪资|到岗|实习时间|每周/;
const REMEMBERABLE_KINDS = new Set(['text', 'textarea', 'select', 'radio', 'combobox']);

export interface ManualCandidate {
  section: KnownSection;
  label: string;
  recordKey: string | null;
  value: string;
  suggested: boolean; // 默认勾选
  sensitive: boolean; // 敏感信息（婚姻状况等）：默认不勾，要你主动选
}

/** 读出这一轮没填上、你现在已经手动填好的字段，给弹窗列成清单让你勾选 */
export async function captureManual(runId: string): Promise<{ items: ManualCandidate[]; origin: string }> {
  const context = runs.get(runId);
  if (!context) throw new RunError('RUN_NOT_FOUND', '这一轮运行已经结束（插件后台重启过），请重新扫描页面后再记');
  const byId = new Map(context.scan.descriptors.map((d) => [d.fieldId, d]));
  const candidates = context.report.fields
    .filter((f) => f.outcome === 'pending' || f.outcome === 'failed')
    .map((f) => byId.get(f.fieldId))
    .filter((d): d is NonNullable<typeof d> =>
      Boolean(d) && d!.section !== 'unknown' && !NEVER_REMEMBER.test(d!.normalizedLabel) && !d!.datePart &&
      REMEMBERABLE_KINDS.has(d!.controlKind) && d!.label !== '(未命名字段)');
  if (candidates.length === 0) return { items: [], origin: context.origin };
  const reply = await sendToContent<{ values: Array<{ fingerprint: string; recordInstanceId: string | null; value: string; recordIdentity: string | null }> }>(
    context.tabId,
    'READ_FIELD_VALUES',
    {
      runId,
      nonce: context.nonce,
      fields: candidates.map((d) => ({ fingerprint: d.semanticFingerprint, recordInstanceId: d.recordInstanceId })),
    },
  );
  const seen = new Set<string>();
  const items: ManualCandidate[] = [];
  for (const v of reply.values) {
    const d = candidates.find((c) => c.semanticFingerprint === v.fingerprint && c.recordInstanceId === v.recordInstanceId);
    if (!d) continue;
    // 经历类字段必须知道属于哪段经历，否则下次没法对上
    if (d.recordInstanceId && !v.recordIdentity) continue;
    const key = `${d.section}|${d.normalizedLabel}|${v.recordIdentity ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      section: d.section as KnownSection,
      label: d.label,
      recordKey: v.recordIdentity,
      value: v.value,
      suggested: !d.sensitive && !JOB_SPECIFIC.test(d.normalizedLabel),
      sensitive: d.sensitive,
    });
  }
  return { items, origin: context.origin };
}
