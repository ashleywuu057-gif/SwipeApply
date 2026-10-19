import { fieldFingerprint } from '../shared/fingerprints';
import { normalizeLabel, valuesEqual } from '../shared/normalize';
import type { ExecutionOutcome } from '../shared/protocol';
import type { FillAction, ReasonCode, SectionKind } from '../shared/types';
import { fillCombobox } from './controls/combobox';
import { areaValuesEqual, readBeisenMultiAreaValues } from './controls/area-picker';
import { fillCheckbox, fillRadio } from './controls/choice';
import { fillDateInput } from './controls/date';
import { fillSelect } from './controls/select';
import { fillText } from './controls/text';
import { delay, readValidationError, waitFor } from './dom-utils';
import { highlight, hideProgress, showProgress } from './highlight';
import type { ControlEntry, ScanOutput } from './scanner';
import { failResult, okResult, readCurrentValue, revalidateTarget, type ControlResult } from './verify';

/** 有限顺序执行、停止、过期检查。所有动作都在目标页面按顺序进行。 */

export const DEFAULT_BUDGET_MS = 45_000;
const MAX_RETRIES = 1;
const RETRYABLE: ReasonCode[] = ['TIMEOUT', 'STALE_PAGE'];
/** 网页可能在写入之后才异步提示错误，结束前统一复查一次。 */
const ASYNC_VALIDATION_SETTLE_MS = 800;
const LATE_ROLLBACK_RETRY_KINDS = new Set<FillAction['kind']>(['text', 'textarea']);

export interface ExecutionContext {
  runId: string;
  actions: FillAction[];
  addRequests: Array<{ section: SectionKind; sectionInstanceId: string; count: number }>;
  budgetMs: number;
  getScan: () => ScanOutput;
  rescan: () => ScanOutput;
  onProgress: (completed: number, total: number, outcome: ExecutionOutcome | null) => void;
  isCancelled: () => boolean;
  isStale: () => boolean;
}

export interface ExecutionSummary {
  phase: 'completed' | 'cancelled' | 'interrupted';
  outcomes: ExecutionOutcome[];
  message: string | null;
}

/**
 * 自定义选择器会触发 React 重渲染。先完成所有结构化选择，最后再写普通文本，
 * 避免后续下拉拿旧表单快照把已经回读成功的单行输入回滚。
 */
function orderedActions(actions: FillAction[]): FillAction[] {
  const priority = (action: FillAction) => {
    // 邮箱常带异步账号校验；最后写入，避免后续字段更新用旧表单快照覆盖它。
    if (action.source.section === 'personal' && action.source.field === 'email') return 2;
    return action.kind === 'text' || action.kind === 'textarea' || action.kind === 'date' || action.kind === 'month' ? 1 : 0;
  };
  return actions
    .map((action, index) => ({ action, index }))
    .sort((a, b) => priority(a.action) - priority(b.action) || a.index - b.index)
    .map(({ action }) => action);
}

function actionValueStillPresent(entry: ControlEntry, action: FillAction): boolean {
  const current = readCurrentValue(entry).trim();
  if (action.kind === 'checkbox') return current === (action.value === true ? 'true' : 'false');
  const candidates = Array.isArray(action.value) ? action.value : [String(action.value)];
  if (entry.areaPickerKind === 'beisen-phoenix-area-multi') {
    const selected = readBeisenMultiAreaValues(entry.primary);
    return candidates.every((candidate) => selected.some((value) => areaValuesEqual(value, candidate)));
  }
  if (entry.areaPickerKind === 'beisen-phoenix-area' || entry.areaPickerKind === 'feishu-tree-area' ||
      (entry.kind === 'combobox' && /(?:城市|地点|现居|籍贯)/.test(entry.descriptor.normalizedLabel))) {
    return candidates.some((candidate) => areaValuesEqual(current, candidate));
  }
  if (action.kind === 'date-picker') {
    if (entry.descriptor.datePrecision === 'year') {
      return candidates.some((candidate) => current === candidate);
    }
    const actual = /(\d{4})\D{0,3}(\d{1,2})(?:\D{0,3}(\d{1,2}))?/.exec(current);
    return candidates.some((candidate) => {
      const wanted = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(candidate);
      return Boolean(actual && wanted && actual[1] === wanted[1] &&
        Number(actual[2]) === Number(wanted[2]) &&
        (wanted[3] === undefined || Number(actual[3]) === Number(wanted[3])));
    });
  }
  const normalized = normalizeLabel(current).toLowerCase();
  return candidates.some((candidate) =>
    valuesEqual(current, candidate) || normalized === normalizeLabel(candidate).toLowerCase());
}

function outcomeOf(action: FillAction, result: ControlResult, elapsedMs: number): ExecutionOutcome {
  if (result.ok) {
    return {
      fieldId: action.fieldId,
      outcome: result.reasonCode === 'VALUE_ALREADY_EQUAL' ? 'unchanged' : 'filled',
      reasonCode: result.reasonCode,
      message: result.message,
      elapsedMs,
    };
  }
  const preserved = result.reasonCode === 'EXISTING_VALUE';
  const pending: ReasonCode[] = [
    'AMBIGUOUS_OPTION', 'UNSUPPORTED_WIDGET', 'PRECISION_MISMATCH', 'TEXT_TOO_LONG',
    'REQUIRES_USER_ACTION', 'SOURCE_MISSING', 'AMBIGUOUS_FIELD', 'AMBIGUOUS_RECORD', 'NO_MATCH',
  ];
  return {
    fieldId: action.fieldId,
    outcome: preserved ? 'preserved' : pending.includes(result.reasonCode) ? 'pending' : 'failed',
    reasonCode: result.reasonCode,
    message: result.message,
    elapsedMs,
  };
}

/** 结构变化后按语义指纹重定位，绝不按 DOM 下标继续填写。 */
function relocate(entry: ControlEntry, scan: ScanOutput): ControlEntry | null {
  const candidates = [...scan.entries.values()].filter(
    (item) =>
      item.descriptor.semanticFingerprint === entry.descriptor.semanticFingerprint &&
      item.descriptor.recordInstanceId === entry.descriptor.recordInstanceId,
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * fieldId 只是一次扫描的 DOM 序号。React 重渲染后同一个 fieldId 可能已指向
 * 另一个字段，因此必须用计划时的语义指纹和记录身份重新定位。
 */
function resolveCurrentEntry(
  original: ControlEntry | null,
  action: FillAction,
  scan: ScanOutput,
): ControlEntry | null {
  if (original) {
    const relocated = relocate(original, scan);
    if (relocated && currentFingerprint(relocated) === action.expectedFingerprint) return relocated;
  }
  const direct = scan.entries.get(action.fieldId) ?? null;
  if (!direct || currentFingerprint(direct) !== action.expectedFingerprint) return null;
  if (original && direct.descriptor.recordInstanceId !== original.descriptor.recordInstanceId) return null;
  return direct;
}

/** 每项执行前重新检查节点身份、标签、分区与指纹。 */
function currentFingerprint(entry: ControlEntry): string {
  return fieldFingerprint({
    section: entry.descriptor.section,
    label: entry.descriptor.normalizedLabel,
    controlKind: entry.kind,
    options: entry.descriptor.options,
    nameHint: entry.descriptor.nameHint,
  });
}

async function applyAction(entry: ControlEntry, action: FillAction, replaceGeneratedDefault = false): Promise<ControlResult> {
  const overwrite = action.overwrite === 'user-approved' || replaceGeneratedDefault;
  if (entry.component) {
    if (entry.component.kind !== action.kind) return failResult('STALE_PAGE', '控件类型发生了变化');
    return entry.component.fill(entry, Array.isArray(action.value) ? action.value : [String(action.value)], overwrite);
  }
  switch (action.kind) {
    case 'text':
    case 'textarea':
      return fillText(entry, String(action.value), overwrite);
    case 'select':
      return fillSelect(entry, String(action.value), overwrite);
    case 'radio':
      return fillRadio(entry, String(action.value), overwrite);
    case 'checkbox':
      return fillCheckbox(entry, action.value === true, overwrite);
    case 'date':
    case 'month':
      return fillDateInput(entry, String(action.value), overwrite);
    case 'date-picker':
      return failResult('UNSUPPORTED_WIDGET', '没有可验证的日期组件驱动');
    case 'combobox':
      return fillCombobox(entry, Array.isArray(action.value) ? action.value : [String(action.value)], overwrite);
    case 'unsupported':
      return failResult('UNSUPPORTED_WIDGET', '这种控件需要手动处理');
  }
}

/**
 * 新增经历：只点击适配器提供的按钮，等待可见记录数恰好增加 1，
 * 每类最多 5 条；按钮无变化或出现弹窗即停止。
 */
async function runAddRequests(context: ExecutionContext): Promise<string[]> {
  const notes: string[] = [];
  for (const request of context.addRequests) {
    let added = 0;
    for (let i = 0; i < Math.min(request.count, 5); i += 1) {
      if (context.isCancelled() || context.isStale()) break;
      const action = context.getScan().addActionElements.get(request.sectionInstanceId);
      if (!action || !action.button.isConnected ||
          (action.button instanceof HTMLButtonElement && action.button.disabled) ||
          action.button.getAttribute('aria-disabled') === 'true') {
        notes.push(`${request.section}：新增按钮不可用，已停止新增`);
        break;
      }
      const countRecords = () => request.section === 'selfIntroduction'
        ? Number(context.getScan().result.descriptors.some((item) => item.section === request.section))
        : context.getScan().result.recordInstances.filter((item) => item.section === request.section).length;
      const countControls = () => action.root.querySelectorAll('input, select, textarea').length;

      const recordsBefore = countRecords();
      const controlsBefore = countControls();
      action.button.click();

      const grew = await waitFor(() => countControls() > controlsBefore, 2000);
      if (!grew) {
        notes.push(`${request.section}：点击新增后页面没有出现新字段，已停止新增`);
        break;
      }
      context.rescan();
      const recordsAfter = countRecords();
      if (recordsAfter !== recordsBefore + 1) {
        notes.push(`${request.section}：记录数从 ${recordsBefore} 变成 ${recordsAfter}，不是恰好增加 1，已停止新增`);
        break;
      }
      added += 1;
    }
    if (added > 0) notes.push(`${request.section}：新增了 ${added} 条空白记录`);
  }
  return notes;
}

export async function executePlan(context: ExecutionContext): Promise<ExecutionSummary> {
  const edits = new WeakMap<Element, number>();
  const trackUserEdit = (event: Event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const range = event.target.closest('[class*="month-range-select"]');
    if (range) edits.set(range, (edits.get(range) ?? 0) + 1);
  };
  const eventTypes = ['pointerdown', 'keydown', 'input', 'change'] as const;
  for (const type of eventTypes) document.addEventListener(type, trackUserEdit, true);
  try {
    return await executeActions(context, edits);
  } finally {
    // 任意站点控件抛出异常时也必须清掉进度条，不能留下看似仍在运行的 4/63。
    hideProgress(window.document);
    for (const type of eventTypes) document.removeEventListener(type, trackUserEdit, true);
  }
}

async function executeActions(context: ExecutionContext, edits: WeakMap<Element, number>): Promise<ExecutionSummary> {
  const outcomes: ExecutionOutcome[] = [];
  const actions = orderedActions(context.actions);
  // 保留计划时的语义身份。后续每次 rescan 都不再相信 fieldId 的位置含义。
  const plannedEntries = new Map(context.getScan().entries);
  const generatedDefaults = new Map<string, { value: string; range: Element; revision: number }>();
  const total = actions.length;
  const deadline = Date.now() + context.budgetMs;
  const document = window.document;

  showProgress(document, `投简助手：正在填写 0/${total}`);

  for (const [index, action] of actions.entries()) {
    if (context.isCancelled()) {
      hideProgress(document);
      return { phase: 'cancelled', outcomes, message: '已停止，保留已填内容' };
    }
    if (context.isStale()) {
      hideProgress(document);
      return { phase: 'interrupted', outcomes, message: '页面已跳转或刷新，已停止本轮填写' };
    }
    if (Date.now() > deadline) {
      for (const remaining of actions.slice(index)) {
        outcomes.push({
          fieldId: remaining.fieldId,
          outcome: 'pending',
          reasonCode: 'TIMEOUT',
          message: '本轮时间用尽，剩余字段未处理',
          elapsedMs: 0,
        });
      }
      break;
    }

    const started = Date.now();
    let result: ControlResult = failResult('STALE_PAGE', '找不到目标字段');
    const originalEntry = plannedEntries.get(action.fieldId) ?? null;
    let entry = resolveCurrentEntry(originalEntry, action, context.getScan());

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (!entry) {
        entry = resolveCurrentEntry(originalEntry, action, context.rescan());
        if (!entry) {
          result = failResult('STALE_PAGE', '网页结构已变化，找不到原字段');
          break;
        }
      }

      const revalidation = revalidateTarget(entry);
      if (!revalidation.ok) {
        result = revalidation;
        if (revalidation.reasonCode === 'STALE_PAGE' && attempt < MAX_RETRIES) {
          const relocated = resolveCurrentEntry(originalEntry, action, context.rescan());
          if (relocated) {
            entry = relocated;
            continue;
          }
        }
        break;
      }

      if (currentFingerprint(entry) !== action.expectedFingerprint) {
        const relocated = attempt < MAX_RETRIES
          ? resolveCurrentEntry(originalEntry, action, context.rescan())
          : null;
        if (relocated) {
          entry = relocated;
          continue;
        }
        result = failResult('STALE_PAGE', '字段结构在扫描后发生了变化');
        break;
      }

      // 一个年份点选会让 Moka 同步给空月份补一月。仅允许替换本轮亲自观察到的
      // 同一日期默认值；扫描前已有值、其它日期、期间用户编辑过的范围均不放行。
      const range = entry.primary.closest('[class*="month-range-select"]');
      const revision = range ? edits.get(range) ?? 0 : 0;
      const peers = range && entry.descriptor.datePart?.unit === 'year'
        ? actions.flatMap((peerAction) => {
          const peer = context.getScan().entries.get(peerAction.fieldId);
          if (!peer || peer.descriptor.datePart?.unit !== 'month' || !peer.descriptor.empty ||
              peer.primary.closest('[class*="month-range-select"]') !== range ||
              peerAction.source.section !== action.source.section ||
              peerAction.source.recordId !== action.source.recordId ||
              peerAction.source.field !== action.source.field || readCurrentValue(peer).trim() !== '') return [];
          return [peer];
        })
        : [];
      const generated = generatedDefaults.get(action.fieldId);
      const replaceGeneratedDefault = Boolean(generated && generated.range === range &&
        generated.revision === revision && readCurrentValue(entry) === generated.value);
      result = await applyAction(entry, action, replaceGeneratedDefault);
      if (result.ok && range && revision === (edits.get(range) ?? 0)) {
        for (const peer of peers) {
          const value = readCurrentValue(peer);
          if (peer.primary.isConnected && value.trim()) {
            generatedDefaults.set(peer.fieldId, { value, range, revision });
          }
        }
      }

      // 写入后节点被替换：重定位一次并确认结果。
      if (!result.ok && result.reasonCode === 'STALE_PAGE' && attempt < MAX_RETRIES) {
        await delay(50);
        const relocated = resolveCurrentEntry(originalEntry, action, context.rescan());
        if (relocated) {
          if (actionValueStillPresent(relocated, action)) {
            result = okResult('FILLED_VERIFIED', '网页替换了节点，已在新节点上确认结果');
            entry = relocated;
            break;
          }
          entry = relocated;
          continue;
        }
      }
      if (result.ok || !RETRYABLE.includes(result.reasonCode)) break;
    }

    const outcome = outcomeOf(action, result, Date.now() - started);
    outcomes.push(outcome);
    if (entry && outcome.outcome === 'filled') highlight(entry.primary, 800);
    context.onProgress(index + 1, total, outcome);
    showProgress(document, `投简助手：正在填写 ${index + 1}/${total}`);
  }

  await settleAsyncValidation(context, outcomes, actions, plannedEntries);
  hideProgress(document);
  return { phase: 'completed', outcomes, message: null };
}

/** 复查已填字段：网页异步校验报错时不谎报成功。 */
async function settleAsyncValidation(
  context: ExecutionContext,
  outcomes: ExecutionOutcome[],
  actions: FillAction[],
  plannedEntries: Map<string, ControlEntry>,
): Promise<void> {
  if (!outcomes.some((outcome) => outcome.outcome === 'filled')) return;
  await delay(ASYNC_VALIDATION_SETTLE_MS);
  const scan = context.rescan();
  const actionByField = new Map(actions.map((action) => [action.fieldId, action]));
  for (const outcome of outcomes) {
    if (outcome.outcome !== 'filled') continue;
    const action = actionByField.get(outcome.fieldId);
    const original = plannedEntries.get(outcome.fieldId) ?? null;
    const entry = action ? resolveCurrentEntry(original, action, scan) : null;
    if (!entry || !action || !entry.primary.isConnected) {
      outcome.outcome = 'failed';
      outcome.reasonCode = 'STALE_PAGE';
      outcome.message = '最终复查时找不到已填写字段';
      continue;
    }
    if (!actionValueStillPresent(entry, action)) {
      // 一些 React 表单会在其它字段更新后用旧快照清空先前的普通文本。
      // 只对本轮已经成功写过、如今变回空白的文本做一次延迟重提；若出现
      // 非空新值则视为网页或用户的新状态，绝不覆盖。
      if (LATE_ROLLBACK_RETRY_KINDS.has(action.kind) && readCurrentValue(entry).trim() === '') {
        const repair = await applyAction(entry, action);
        await delay(180);
        const repairedEntry = resolveCurrentEntry(original, action, context.rescan());
        if (repair.ok && repairedEntry && actionValueStillPresent(repairedEntry, action)) {
          outcome.message = '网页更新后曾清空该值，已自动重新提交并确认';
          continue;
        }
      }
      outcome.outcome = 'failed';
      outcome.reasonCode = 'VALIDATION_FAILED';
      outcome.message = '网页在后续更新后撤销了这个值';
      continue;
    }
    for (const element of entry.elements) {
      const error = readValidationError(element);
      if (!error) continue;
      outcome.outcome = 'failed';
      outcome.reasonCode = 'VALIDATION_FAILED';
      outcome.message = `网页提示：${error}`;
      break;
    }
  }
}

export { runAddRequests };
