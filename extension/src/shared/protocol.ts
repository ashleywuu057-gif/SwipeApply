import { z } from 'zod';
import {
  applicationRecordBaseSchema, applicationRecordSchema, backupFileSchema, blockerSchema, idSchema,
  controlKindSchema, degreeLevelSchema, fieldRefSchema, profileFileSchema, recordSelectorSchema,
  sectionKindSchema, applicationStatusSchema,
} from './schemas';

/** 消息协议。每个端只接受本文件允许的消息类型，来源以 sender 实际值判断。 */

export const PROTOCOL_VERSION = 1;
export const REQUEST_TIMEOUT_MS = 10_000;

export const fieldOptionSchema = z.object({ label: z.string().max(300), value: z.string().max(300) }).strict();

export const datePartSchema = z
  .object({ edge: z.enum(['start', 'end', 'single']), unit: z.enum(['year', 'month']) })
  .strict();

export const fieldDescriptorSchema = z
  .object({
    fieldId: z.string().min(1).max(120),
    section: sectionKindSchema,
    sectionInstanceId: z.string().max(120),
    recordInstanceId: z.string().max(120).nullable(),
    label: z.string().max(300),
    normalizedLabel: z.string().max(300),
    nameHint: z.string().max(200).nullable(),
    placeholderHint: z.string().max(300).nullable(),
    controlKind: controlKindSchema,
    required: z.boolean(),
    disabled: z.boolean(),
    readOnly: z.boolean(),
    visible: z.boolean(),
    empty: z.boolean(),
    maxLength: z.number().int().min(0).nullable(),
    options: z.array(fieldOptionSchema).max(400),
    semanticFingerprint: z.string().max(120),
    datePart: datePartSchema.nullable(),
    datePrecision: z.enum(['year', 'month', 'day']).nullable(),
    datePresentValue: z.string().max(40).nullable(),
    degreeHint: degreeLevelSchema.nullable(),
    recordIdentityHint: z.string().max(300).nullable(),
    unsupportedReason: z.string().max(200).nullable(),
    sensitive: z.boolean(),
  })
  .strict();

export const recordInstanceInfoSchema = z
  .object({
    section: sectionKindSchema,
    sectionInstanceId: z.string().max(120),
    recordInstanceId: z.string().max(120),
    degreeHint: degreeLevelSchema.nullable(),
    identityHint: z.string().max(300).nullable(),
    order: z.number().int().min(0),
  })
  .strict();

export const jobCandidateSchema = z
  .object({
    company: z.string().max(200).nullable(),
    role: z.string().max(200).nullable(),
    location: z.string().max(200).nullable(),
    externalJobId: z.string().max(200).nullable(),
    sourceUrl: z.string().max(2048).nullable(),
    evidence: z.enum(['json-ld', 'adapter', 'heuristic']),
  })
  .strict();

export const scanResultSchema = z
  .object({
    routeKey: z.string().max(500),
    origin: z.string().max(300),
    pageTitle: z.string().max(300),
    descriptors: z.array(fieldDescriptorSchema).max(300),
    recordInstances: z.array(recordInstanceInfoSchema).max(120),
    addActions: z
      .array(z.object({ section: sectionKindSchema, sectionInstanceId: z.string().max(120), label: z.string().max(200) }).strict())
      .max(20),
    adapterBindings: z
      .array(z.object({ fieldId: z.string().max(120), section: sectionKindSchema, field: z.string().max(60) }).strict())
      .max(300),
    orderFallbackSections: z.array(sectionKindSchema).max(12),
    jobCandidate: jobCandidateSchema.nullable(),
    adapterId: z.string().max(80).nullable(),
    truncated: z.boolean(),
    truncationReason: z.string().max(200).nullable(),
    formFingerprint: z.string().max(120),
    diagnostics: z.array(z.string().max(200)).max(30).optional(),
  })
  .strict();

export const fillActionSchema = z
  .object({
    fieldId: z.string().min(1).max(120),
    source: fieldRefSchema,
    expectedFingerprint: z.string().max(120),
    kind: controlKindSchema,
    value: z.union([z.string().max(20_000), z.boolean(), z.array(z.string().max(300)).max(50)]),
    overwrite: z.union([z.literal(false), z.literal('user-approved')]),
  })
  .strict();

export const fieldOutcomeSchema = z.enum(['ready', 'filled', 'unchanged', 'preserved', 'pending', 'failed']);
export const reasonCodeSchema = z.enum([
  'READY_TO_FILL', 'FILLED_VERIFIED', 'VALUE_ALREADY_EQUAL', 'EXISTING_VALUE', 'SOURCE_MISSING',
  'AMBIGUOUS_FIELD', 'AMBIGUOUS_RECORD', 'AMBIGUOUS_OPTION', 'UNSUPPORTED_WIDGET',
  'PRECISION_MISMATCH', 'TEXT_TOO_LONG', 'REQUIRES_USER_ACTION', 'STALE_PAGE',
  'VALIDATION_FAILED', 'TIMEOUT', 'USER_CANCELLED', 'NO_MATCH', 'RULE_STALE',
]);

/** 进度与结果不携带字段值，只有 fieldId、结果与原因。 */
export const executionOutcomeSchema = z
  .object({
    fieldId: z.string().max(120),
    outcome: fieldOutcomeSchema,
    reasonCode: reasonCodeSchema,
    message: z.string().max(300),
    elapsedMs: z.number().int().min(0),
  })
  .strict();

const expectedRevision = z.number().int().min(0);
const requestIdSchema = z.string().min(1).max(120);

/** UI（popup.html / app.html）可以发给后台的消息。 */
export const uiMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('GET_STATE'), payload: z.object({}).strict() }).strict(),
  z.object({ type: z.literal('GET_TARGET_TAB'), payload: z.object({}).strict() }).strict(),
  z.object({ type: z.literal('LIST_TARGET_TABS'), payload: z.object({}).strict() }).strict(),
  z.object({
    type: z.literal('IMPORT_PROFILE'),
    payload: z.object({ file: profileFileSchema, expectedRevision, onConflict: z.enum(['reject', 'save-as-new']).default('reject') }).strict(),
  }).strict(),
  // jobprep：从本机的SwipeApply同步履历
  z.object({
    type: z.literal('SYNC_JOBPREP'),
    payload: z.object({ targetUrl: z.string().max(2048).nullable(), expectedRevision }).strict(),
  }).strict(),
  z.object({
    type: z.literal('SAVE_PROFILE'),
    payload: z.object({ profileId: z.string().max(120), name: z.string().max(200), data: profileFileSchema.shape.data, expectedRevision }).strict(),
  }).strict(),
  z.object({
    type: z.literal('SET_ACTIVE_PROFILE'),
    payload: z.object({ profileVersionId: z.string().max(120), expectedRevision }).strict(),
  }).strict(),
  z.object({
    type: z.literal('PREPARE_RUN'),
    payload: z.object({
      targetTabId: z.number().int(),
      profileVersionId: z.string().max(120),
      mode: z.enum(['scan', 'fill']),
      applicationId: z.string().max(120).nullable().default(null),
    }).strict(),
  }).strict(),
  z.object({ type: z.literal('GET_RUN'), payload: z.object({ runId: z.string().max(120) }).strict() }).strict(),
  z.object({ type: z.literal('CANCEL_RUN'), payload: z.object({ runId: z.string().max(120) }).strict() }).strict(),
  z.object({
    type: z.literal('RETRY_FIELD'),
    payload: z.object({
      runId: z.string().max(120),
      fieldId: z.string().max(120),
      source: fieldRefSchema,
      remember: z.boolean(),
      overwriteExisting: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('BIND_RECORD'),
    payload: z.object({
      runId: z.string().max(120),
      recordInstanceId: z.string().max(120),
      recordId: idSchema,
      remember: z.boolean().default(false),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('LOCATE_FIELD'),
    payload: z.object({ runId: z.string().max(120), fieldId: z.string().max(120) }).strict(),
  }).strict(),
  z.object({
    type: z.literal('DELETE_MAPPING'),
    payload: z.object({ mappingId: z.string().max(120), expectedRevision }).strict(),
  }).strict(),
  z.object({
    type: z.literal('UPSERT_APPLICATION'),
    payload: z.object({
      // 界面只提交用户可编辑的字段；dedupeKey、时间戳、证据与 timeline 由后台生成。
      record: applicationRecordBaseSchema
        .omit({ dedupeKey: true, timeline: true, createdAt: true, updatedAt: true, appliedAt: true, submissionEvidence: true })
        .extend({
          id: z.string().max(120).nullable(),
          appliedAt: z.null().default(null),
          submissionEvidence: z.null().default(null),
        })
        .strict(),
      expectedRevision,
      allowDuplicate: z.boolean().default(false),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('CONFIRM_SUBMITTED'),
    payload: z.object({
      recordId: z.string().max(120),
      successSeen: z.literal(true),
      appliedAt: z.string().max(40),
      note: z.string().max(500).nullable().default(null),
      expectedRevision,
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('SET_APPLICATION_STATUS'),
    payload: z.object({
      recordId: z.string().max(120),
      status: applicationStatusSchema,
      blocker: blockerSchema.default('none'),
      reason: z.string().max(300).nullable().default(null),
      expectedRevision,
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('IMPORT_APPLICATIONS'),
    payload: z.object({
      records: z.array(applicationRecordSchema).max(5000),
      strategy: z.enum(['skip-identical', 'append-as-new', 'replace-by-id']),
      expectedRevision,
    }).strict(),
  }).strict(),
  z.object({ type: z.literal('EXPORT_BACKUP'), payload: z.object({}).strict() }).strict(),
  z.object({
    type: z.literal('IMPORT_BACKUP'),
    payload: z.object({ file: backupFileSchema, expectedRevision }).strict(),
  }).strict(),
  // jobprep：记住你手动补填的内容
  z.object({ type: z.literal('CAPTURE_MANUAL'), payload: z.object({ runId: z.string().max(120) }).strict() }).strict(),
  z.object({
    type: z.literal('SAVE_REMEMBERED'),
    payload: z.object({
      origin: z.string().max(200),
      items: z.array(z.object({
        section: sectionKindSchema,
        label: z.string().min(1).max(200),
        recordKey: z.string().max(300).nullable(),
        value: z.string().min(1).max(2000),
      }).strict()).max(100),
    }).strict(),
  }).strict(),
  z.object({ type: z.literal('LIST_REMEMBERED'), payload: z.object({}).strict() }).strict(),
  z.object({ type: z.literal('DELETE_REMEMBERED'), payload: z.object({ id: z.string().max(120) }).strict() }).strict(),
  z.object({
    type: z.literal('SAVE_MAPPING'),
    payload: z.object({
      runId: z.string().max(120),
      fieldId: z.string().max(120),
      source: fieldRefSchema,
      recordSelector: recordSelectorSchema,
      expectedRevision,
    }).strict(),
  }).strict(),
]);

/** 内容脚本只能回传已登记运行的扫描与进度，不能调用任何管理接口。 */
export const contentMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('REGISTER_DOCUMENT'),
    payload: z.object({ url: z.string().max(2048), title: z.string().max(300), contentVersion: z.string().max(40) }).strict(),
  }).strict(),
  z.object({
    type: z.literal('RUN_PROGRESS'),
    payload: z.object({
      runId: z.string().max(120),
      nonce: z.string().max(120),
      seq: z.number().int().min(0),
      completed: z.number().int().min(0),
      total: z.number().int().min(0),
      outcome: executionOutcomeSchema.nullable(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('RUN_FINISHED'),
    payload: z.object({
      runId: z.string().max(120),
      nonce: z.string().max(120),
      seq: z.number().int().min(0),
      phase: z.enum(['completed', 'cancelled', 'interrupted', 'failed']),
      outcomes: z.array(executionOutcomeSchema).max(400),
      message: z.string().max(300).nullable(),
    }).strict(),
  }).strict(),
]);

/** 后台发给内容脚本的命令。 */
export const backgroundCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SCAN_PAGE'),
    payload: z.object({ runId: z.string().max(120), nonce: z.string().max(120) }).strict(),
  }).strict(),
  z.object({
    type: z.literal('EXECUTE_PLAN'),
    payload: z.object({
      runId: z.string().max(120),
      nonce: z.string().max(120),
      planRevision: z.number().int().min(0),
      actions: z.array(fillActionSchema).max(300),
      addRecordActions: z
        .array(z.object({ section: sectionKindSchema, sectionInstanceId: z.string().max(120), count: z.number().int().min(1).max(5) }).strict())
        .max(10),
      budgetMs: z.number().int().min(1000).max(120_000),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('ADD_RECORDS'),
    payload: z.object({
      runId: z.string().max(120),
      nonce: z.string().max(120),
      requests: z
        .array(z.object({ section: sectionKindSchema, sectionInstanceId: z.string().max(120), count: z.number().int().min(1).max(5) }).strict())
        .max(10),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('CANCEL_EXECUTION'),
    payload: z.object({ runId: z.string().max(120), nonce: z.string().max(120) }).strict(),
  }).strict(),
  z.object({
    type: z.literal('HIGHLIGHT_FIELD'),
    payload: z.object({ runId: z.string().max(120), nonce: z.string().max(120), fieldId: z.string().max(120) }).strict(),
  }).strict(),
  z.object({
    type: z.literal('PING_RUN'),
    payload: z.object({ runId: z.string().max(120), nonce: z.string().max(120) }).strict(),
  }).strict(),
  // jobprep：你点「记住我补填的内容」后，读这一轮待处理字段现在网页上的值（只读，不写）。
  // 这是唯一会把字段值带回后台的命令，只在你主动点按钮时发送。
  z.object({
    type: z.literal('READ_FIELD_VALUES'),
    payload: z.object({
      runId: z.string().max(120),
      nonce: z.string().max(120),
      fields: z.array(z.object({ fingerprint: z.string().max(120), recordInstanceId: z.string().max(120).nullable() }).strict()).max(200),
    }).strict(),
  }).strict(),
]);

export type UiMessage = z.infer<typeof uiMessageSchema>;
export type ContentMessage = z.infer<typeof contentMessageSchema>;
export type BackgroundCommand = z.infer<typeof backgroundCommandSchema>;
export type ScanResult = z.infer<typeof scanResultSchema>;
export type ExecutionOutcome = z.infer<typeof executionOutcomeSchema>;
export type RecordInstanceInfo = z.infer<typeof recordInstanceInfoSchema>;

export interface Envelope<T> {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  type: string;
  payload: T;
}

export type Reply<T> =
  | { ok: true; requestId: string; data: T }
  | { ok: false; requestId: string; error: { code: string; message: string } };

export const envelopeShellSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.string().min(1).max(60),
    payload: z.unknown(),
  })
  .strict();

export function makeEnvelope<T>(type: string, payload: T, requestId?: string): Envelope<T> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId ?? newRequestId(),
    type,
    payload,
  };
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function failure(requestId: string, code: string, message: string): Reply<never> {
  return { ok: false, requestId, error: { code, message } };
}

export function success<T>(requestId: string, data: T): Reply<T> {
  return { ok: true, requestId, data };
}

/** 管理接口只接受扩展自己的 popup.html / app.html。 */
export function isTrustedUiSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId) return false;
  if (sender.tab !== undefined && sender.frameId !== undefined && sender.frameId !== 0) return false;
  const url = sender.url ?? '';
  if (!url.startsWith(`chrome-extension://${extensionId}/`)) return false;
  const path = url.slice(`chrome-extension://${extensionId}/`.length).split(/[?#]/)[0];
  return path === 'popup.html' || path === 'app.html';
}

/** 内容脚本必须来自真实标签页的主框架。 */
export function isContentSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId) return false;
  if (!sender.tab || sender.tab.id === undefined) return false;
  if (sender.frameId !== 0) return false;
  const url = sender.url ?? '';
  return url.startsWith('http://') || url.startsWith('https://');
}
