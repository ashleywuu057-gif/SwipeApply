import type { ApplicationRecord, ApplicationStatus, AppState, Blocker, TimelineEvent } from '../shared/types';
import { computeDedupeKey, dedupeConfidence } from '../shared/urls';
import { normalizeKeyPart } from '../shared/normalize';
import { CSV_COLUMNS, type CsvRow, toCsv } from '../shared/csv';
import { applicationRecordSchema, formatIssues } from '../shared/schemas';

/** 投递记录状态机、去重与 CSV 映射。 */

export class ApplicationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  planned: '待投递',
  filling: '填写中',
  ready: '待确认提交',
  applied: '已投递',
  assessment: '笔试/测评',
  interview: '面试',
  offer: 'Offer',
  rejected: '未通过',
  closed: '已结束',
};

export const BLOCKER_LABELS: Record<Blocker, string> = {
  none: '无',
  missing_information: '缺少信息',
  site_restriction: '网站限制',
};

/** 需要提交证据的状态。 */
export const SUBMITTED_STATUSES: ApplicationStatus[] = ['applied', 'assessment', 'interview', 'offer', 'rejected'];
/** 新记录只能是这三种。 */
export const INITIAL_STATUSES: ApplicationStatus[] = ['planned', 'filling', 'ready'];

const FORWARD_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  planned: ['filling', 'ready', 'closed'],
  filling: ['planned', 'ready', 'closed'],
  ready: ['planned', 'filling', 'closed'],
  applied: ['assessment', 'interview', 'offer', 'rejected', 'closed'],
  assessment: ['interview', 'offer', 'rejected', 'closed'],
  interview: ['assessment', 'offer', 'rejected', 'closed'],
  offer: ['rejected', 'closed'],
  rejected: ['closed'],
  closed: ['planned'],
};

export function isSubmitted(status: ApplicationStatus): boolean {
  return SUBMITTED_STATUSES.includes(status);
}

export interface StatusChangeInput {
  record: ApplicationRecord;
  next: ApplicationStatus;
  blocker: Blocker;
  reason: string | null;
  now: string;
}

/**
 * 状态迁移：没有提交证据不能进入 applied 及后续阶段；
 * 从已投递回退属于显式纠正，必须给出理由并追加 timeline。
 */
export function changeStatus(input: StatusChangeInput): ApplicationRecord {
  const { record, next, now } = input;
  if (next === record.status) {
    return { ...record, blocker: input.blocker, updatedAt: now };
  }
  if (next === 'applied') {
    throw new ApplicationError(
      'NEEDS_CONFIRMATION',
      '「已投递」只能通过“我已手动提交并看到成功提示”确认入口设置。',
    );
  }
  if (isSubmitted(next) && !record.submissionEvidence) {
    throw new ApplicationError(
      'NO_SUBMISSION_EVIDENCE',
      `没有提交证据，不能把记录改为「${STATUS_LABELS[next]}」。请先确认已手动提交。`,
    );
  }

  const isCorrection = isSubmitted(record.status) && !isSubmitted(next) && next !== 'closed';
  if (isCorrection && (!input.reason || input.reason.trim().length === 0)) {
    throw new ApplicationError('NEEDS_REASON', '把已投递记录改回更早的状态属于纠正操作，必须填写理由。');
  }
  if (!isCorrection && !FORWARD_TRANSITIONS[record.status].includes(next)) {
    throw new ApplicationError(
      'INVALID_TRANSITION',
      `不能从「${STATUS_LABELS[record.status]}」直接改为「${STATUS_LABELS[next]}」。`,
    );
  }

  const event: TimelineEvent = {
    at: now,
    from: record.status,
    to: next,
    reason: input.reason,
  };
  return {
    ...record,
    status: next,
    blocker: input.blocker,
    updatedAt: now,
    appliedAt: isCorrection ? null : record.appliedAt,
    submissionEvidence: isCorrection ? null : record.submissionEvidence,
    timeline: [...record.timeline, event],
  };
}

export interface ConfirmSubmittedInput {
  record: ApplicationRecord;
  appliedAt: string;
  note: string | null;
  now: string;
}

/** 正常使用中唯一的提交确认入口。 */
export function confirmSubmitted(input: ConfirmSubmittedInput): ApplicationRecord {
  const { record, now } = input;
  if (isSubmitted(record.status)) {
    throw new ApplicationError('ALREADY_SUBMITTED', '这条记录已经标记为已投递。');
  }
  return {
    ...record,
    status: 'applied',
    appliedAt: input.appliedAt,
    updatedAt: now,
    submissionEvidence: {
      kind: 'user-confirmed',
      confirmedAt: now,
      successSeen: true,
      note: input.note,
    },
    timeline: [
      ...record.timeline,
      { at: now, from: record.status, to: 'applied', reason: '用户确认已手动提交并看到网站成功提示' },
    ],
  };
}

export interface DuplicateInfo {
  exact: ApplicationRecord | null;
  similar: ApplicationRecord[];
  confidence: 'strong' | 'weak';
}

/** 完全同 key 提示打开已有记录；仅公司与岗位相似时提示可能重复。 */
export function findDuplicates(state: AppState, candidate: ApplicationRecord): DuplicateInfo {
  const exact = state.applications.find(
    (record) => record.dedupeKey === candidate.dedupeKey && record.id !== candidate.id,
  ) ?? null;
  const company = normalizeKeyPart(candidate.company);
  const role = normalizeKeyPart(candidate.role);
  const similar = state.applications.filter(
    (record) =>
      record.id !== candidate.id &&
      record.dedupeKey !== candidate.dedupeKey &&
      normalizeKeyPart(record.company) === company &&
      normalizeKeyPart(record.role) === role,
  );
  return {
    exact,
    similar,
    confidence: dedupeConfidence({
      company: candidate.company,
      role: candidate.role,
      location: candidate.location,
      canonicalUrl: candidate.canonicalUrl,
      externalJobId: candidate.externalJobId,
    }),
  };
}

export interface UpsertInput {
  id: string | null;
  company: string;
  role: string;
  location: string | null;
  sourceUrl: string | null;
  canonicalUrl: string | null;
  externalJobId: string | null;
  profileVersionId: string | null;
  status: ApplicationStatus;
  blocker: Blocker;
  nextAction: string | null;
  notes: string | null;
}

export async function buildRecord(
  state: AppState,
  input: UpsertInput,
  now: string,
): Promise<{ record: ApplicationRecord; existing: ApplicationRecord | null }> {
  const existing = input.id ? state.applications.find((record) => record.id === input.id) ?? null : null;
  if (input.id && !existing) throw new ApplicationError('NOT_FOUND', `找不到投递记录 ${input.id}`);

  if (!existing && !INITIAL_STATUSES.includes(input.status)) {
    throw new ApplicationError(
      'INVALID_INITIAL_STATUS',
      `新记录只能是「${INITIAL_STATUSES.map((s) => STATUS_LABELS[s]).join('」「')}」。`,
    );
  }

  const dedupeKey = await computeDedupeKey({
    company: input.company,
    role: input.role,
    location: input.location,
    canonicalUrl: input.canonicalUrl,
    externalJobId: input.externalJobId,
  });

  if (!existing) {
    const record: ApplicationRecord = {
      id: `application-${crypto.randomUUID()}`,
      company: input.company,
      role: input.role,
      location: input.location,
      sourceUrl: input.sourceUrl,
      canonicalUrl: input.canonicalUrl,
      externalJobId: input.externalJobId,
      dedupeKey,
      profileVersionId: input.profileVersionId,
      status: input.status,
      blocker: input.blocker,
      createdAt: now,
      updatedAt: now,
      appliedAt: null,
      nextAction: input.nextAction,
      notes: input.notes,
      submissionEvidence: null,
      timeline: [{ at: now, from: null, to: input.status, reason: '创建投递记录' }],
    };
    return { record, existing: null };
  }

  // 普通编辑不改写 appliedAt、证据与旧 timeline。
  let updated: ApplicationRecord = {
    ...existing,
    company: input.company,
    role: input.role,
    location: input.location,
    sourceUrl: input.sourceUrl,
    canonicalUrl: input.canonicalUrl,
    externalJobId: input.externalJobId,
    dedupeKey,
    profileVersionId: input.profileVersionId,
    nextAction: input.nextAction,
    notes: input.notes,
    updatedAt: now,
  };
  if (input.status !== existing.status || input.blocker !== existing.blocker) {
    updated = changeStatus({ record: updated, next: input.status, blocker: input.blocker, reason: null, now });
  }
  return { record: updated, existing };
}

export function putRecord(state: AppState, record: ApplicationRecord): AppState {
  const exists = state.applications.some((entry) => entry.id === record.id);
  return {
    ...state,
    applications: exists
      ? state.applications.map((entry) => (entry.id === record.id ? record : entry))
      : [...state.applications, record],
  };
}

/* ------------------------------- CSV 映射 ------------------------------- */

export function recordToCsvRow(record: ApplicationRecord): CsvRow {
  return {
    id: record.id,
    company: record.company,
    role: record.role,
    location: record.location ?? '',
    sourceUrl: record.sourceUrl ?? '',
    externalJobId: record.externalJobId ?? '',
    profileVersionId: record.profileVersionId ?? '',
    status: record.status,
    blocker: record.blocker,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    appliedAt: record.appliedAt ?? '',
    nextAction: record.nextAction ?? '',
    notes: record.notes ?? '',
  };
}

export function exportCsv(records: ApplicationRecord[]): string {
  return toCsv(records.map(recordToCsvRow));
}

export interface CsvImportIssue {
  line: number;
  message: string;
}

export interface CsvImportResult {
  records: ApplicationRecord[];
  issues: CsvImportIssue[];
}

const emptyToNull = (value: string) => (value.trim().length === 0 ? null : value.trim());

/** CSV 行转记录。已投递及后续阶段必须有 appliedAt，并生成 imported 证据。 */
export async function csvRowsToRecords(rows: CsvRow[], now: string): Promise<CsvImportResult> {
  const records: ApplicationRecord[] = [];
  const issues: CsvImportIssue[] = [];

  for (const [index, row] of rows.entries()) {
    const line = index + 2;
    const status = row.status.trim() as ApplicationStatus;
    const blocker = (emptyToNull(row.blocker) ?? 'none') as Blocker;
    const appliedAt = emptyToNull(row.appliedAt);
    const createdAt = emptyToNull(row.createdAt) ?? now;

    if (isSubmitted(status) && !appliedAt) {
      issues.push({ line, message: `状态 ${status} 缺少 appliedAt，已跳过该行` });
      continue;
    }

    const canonicalUrl = emptyToNull(row.sourceUrl);
    const dedupeKey = await computeDedupeKey({
      company: row.company.trim(),
      role: row.role.trim(),
      location: emptyToNull(row.location),
      canonicalUrl,
      externalJobId: emptyToNull(row.externalJobId),
    });

    const candidate: ApplicationRecord = {
      id: emptyToNull(row.id) ?? `application-${crypto.randomUUID()}`,
      company: row.company.trim(),
      role: row.role.trim(),
      location: emptyToNull(row.location),
      sourceUrl: canonicalUrl,
      canonicalUrl,
      externalJobId: emptyToNull(row.externalJobId),
      dedupeKey,
      profileVersionId: emptyToNull(row.profileVersionId),
      status,
      blocker,
      createdAt,
      updatedAt: emptyToNull(row.updatedAt) ?? now,
      appliedAt,
      nextAction: emptyToNull(row.nextAction),
      notes: emptyToNull(row.notes),
      submissionEvidence: appliedAt
        ? { kind: 'imported', confirmedAt: appliedAt, successSeen: true, note: '历史导入声明，未由扩展亲自验证' }
        : null,
      timeline: [{ at: now, from: null, to: status, reason: '历史导入' }],
    };

    const parsed = applicationRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      const detail = formatIssues(parsed.error).map((issue) => `${issue.path} ${issue.message}`).join('；');
      issues.push({ line, message: `校验失败：${detail}` });
      continue;
    }
    records.push(parsed.data as ApplicationRecord);
  }

  return { records, issues };
}

export interface ImportPlan {
  identical: ApplicationRecord[];
  conflictsById: Array<{ incoming: ApplicationRecord; existing: ApplicationRecord }>;
  conflictsByKey: Array<{ incoming: ApplicationRecord; existing: ApplicationRecord }>;
  fresh: ApplicationRecord[];
}

function sameSummary(a: ApplicationRecord, b: ApplicationRecord): boolean {
  const rowA = recordToCsvRow(a);
  const rowB = recordToCsvRow(b);
  return CSV_COLUMNS.every((column) => rowA[column] === rowB[column]);
}

export function planImport(state: AppState, incoming: ApplicationRecord[]): ImportPlan {
  const plan: ImportPlan = { identical: [], conflictsById: [], conflictsByKey: [], fresh: [] };
  for (const record of incoming) {
    const byId = state.applications.find((entry) => entry.id === record.id);
    if (byId) {
      if (sameSummary(byId, record)) plan.identical.push(record);
      else plan.conflictsById.push({ incoming: record, existing: byId });
      continue;
    }
    const byKey = state.applications.find((entry) => entry.dedupeKey === record.dedupeKey);
    if (byKey) {
      plan.conflictsByKey.push({ incoming: record, existing: byKey });
      continue;
    }
    plan.fresh.push(record);
  }
  return plan;
}

export type ImportStrategy = 'skip-identical' | 'append-as-new' | 'replace-by-id';

/** 普通导入不静默覆盖 timeline；覆盖整库只走完整备份恢复。 */
export function applyImport(state: AppState, incoming: ApplicationRecord[], strategy: ImportStrategy): {
  state: AppState;
  added: number;
  skipped: number;
  replaced: number;
} {
  const plan = planImport(state, incoming);
  const applications = [...state.applications];
  let added = 0;
  let skipped = plan.identical.length;
  let replaced = 0;

  for (const record of plan.fresh) {
    applications.push(record);
    added += 1;
  }

  const conflicts = [...plan.conflictsById, ...plan.conflictsByKey];
  for (const conflict of conflicts) {
    if (strategy === 'skip-identical') {
      skipped += 1;
      continue;
    }
    if (strategy === 'replace-by-id') {
      const index = applications.findIndex((entry) => entry.id === conflict.existing.id);
      if (index >= 0) {
        applications[index] = { ...conflict.incoming, id: conflict.existing.id };
        replaced += 1;
      }
      continue;
    }
    // append-as-new：以新 ID 与日期保存，不覆盖历史。
    applications.push({ ...conflict.incoming, id: `application-${crypto.randomUUID()}` });
    added += 1;
  }

  return { state: { ...state, applications }, added, skipped, replaced };
}
