import { getCatalogField, getSection, isRepeatedSection, readFieldValue, type CatalogField } from '../shared/field-catalog';
import { bindRecords, matchField, type MatchContext, type RecordInstance, type RecordSummary } from '../shared/matching';
import { projectValue } from '../shared/projection';
import type { ScanResult } from '../shared/protocol';
import type {
  ControlKind, FieldDescriptor, FieldRef, FieldResult, FillAction, KnownSection, ProfileData, ProfileFile,
  RememberedAnswer, SavedMapping, SectionKind,
} from '../shared/types';
import { findRemembered, NEVER_REMEMBER } from './remembered';

/** 由扫描结果与履历生成有依据的填写计划。纯函数，便于单元测试。 */

export interface PlanOptions {
  scan: ScanResult;
  profile: ProfileFile;
  rules: SavedMapping[];
  /** 用户本轮手动绑定：fieldId -> FieldRef（不含 recordId）。 */
  manualBindings?: Map<string, Omit<FieldRef, 'recordId'>>;
  /** 允许覆盖已有不同值的字段（必须由用户针对该项发起）。 */
  overwriteFieldIds?: Set<string>;
  /** 只为这些 fieldId 生成动作；为空表示全部。 */
  onlyFieldIds?: Set<string>;
  /** 用户为整组网页经历指定的履历记录：recordInstanceId -> recordId。 */
  userRecordBindings?: Map<string, string>;
  /** jobprep：你上次手动补填并勾选记住的内容，履历里没有的字段用它 */
  remembered?: RememberedAnswer[];
}

/** 记住的内容的来源标记（报告里显示为「你上次手动填的」） */
export const REMEMBERED_FIELD = 'remembered';
const REMEMBERABLE: ControlKind[] = ['text', 'textarea', 'select', 'radio', 'combobox'];
const REMEMBERED_CATALOG: CatalogField = { field: REMEMBERED_FIELD, label: '你上次手动填的', valueKind: 'text', aliases: [] };

export interface PlanResult {
  actions: FillAction[];
  results: FieldResult[];
  addRequests: Array<{ section: SectionKind; sectionInstanceId: string; count: number }>;
  recordBindingNotes: string[];
  /** 网页记录数超过履历且整条记录仍为空；详情页会按记录折叠展示。 */
  excessEmptyRecordInstanceIds: string[];
}

const REPEATED_SECTIONS: KnownSection[] = [
  'education', 'workExperiences', 'internships', 'projects', 'languages', 'awards', 'publications', 'certificates',
];

function identityOf(section: KnownSection, record: Record<string, unknown>): string {
  const value = record['school'] ?? record['company'] ?? record['name'] ?? record['language'] ?? '';
  return typeof value === 'string' ? value : '';
}

export function recordSummaries(data: ProfileData, section: KnownSection): RecordSummary[] {
  const list = (data as unknown as Record<string, unknown>)[section];
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>).map((record) => ({
    id: String(record['id']),
    primary: record['primary'] === true,
    degreeLevel: section === 'education' ? ((record['degreeLevel'] as RecordSummary['degreeLevel']) ?? null) : null,
    identity: identityOf(section, record),
  }));
}

function resultFor(
  descriptor: FieldDescriptor,
  outcome: FieldResult['outcome'],
  reasonCode: FieldResult['reasonCode'],
  source: FieldRef | null = null,
): FieldResult {
  return {
    fieldId: descriptor.fieldId,
    section: descriptor.section,
    source,
    outcome,
    reasonCode,
    label: descriptor.label,
    elapsedMs: 0,
  };
}

export function planRun(options: PlanOptions): PlanResult {
  const { scan, profile } = options;
  const data = profile.data;

  // 1) 重复经历绑定。
  const recordBindings = new Map<string, ReturnType<typeof bindRecords> extends Map<string, infer V> ? V : never>();
  const recordBindingNotes: string[] = [...(scan.diagnostics ?? [])];
  const excessEmptyRecordInstanceIds = new Set<string>();
  const excessCounts = new Map<KnownSection, number>();
  for (const section of REPEATED_SECTIONS) {
    const instances: RecordInstance[] = scan.recordInstances
      .filter((instance) => instance.section === section)
      .map((instance) => ({
        recordInstanceId: instance.recordInstanceId,
        degreeHint: instance.degreeHint,
        identityHint: instance.identityHint,
        order: instance.order,
      }));
    if (instances.length === 0) continue;
    const summaries = recordSummaries(data, section);
    const defaultRecordId = summaries.find((record) => record.primary)?.id;
    const bound = bindRecords(instances, summaries, {
      allowOrderFallback: scan.orderFallbackSections.includes(section),
      ...(defaultRecordId ? { defaultRecordId } : {}),
      ...(options.userRecordBindings ? { userBindings: options.userRecordBindings } : {}),
    });
    for (const [key, value] of bound) {
      recordBindings.set(key, value);
      if (!value.ok) {
        const fields = scan.descriptors.filter((descriptor) => descriptor.recordInstanceId === key);
        const excessEmpty = value.reasonCode === 'SOURCE_MISSING' && fields.length > 0 && fields.every((field) => field.empty);
        if (excessEmpty) {
          excessEmptyRecordInstanceIds.add(key);
          excessCounts.set(section, (excessCounts.get(section) ?? 0) + 1);
        } else {
          recordBindingNotes.push(`${getSection(section)?.label ?? section}：${value.message}`);
        }
      }
    }
  }
  for (const [section, count] of excessCounts) {
    recordBindingNotes.push(
      `${getSection(section)?.label ?? section}：网页多出 ${count} 条完全空白的记录，履历中没有对应经历；详情已按记录折叠，请在网页删除空记录或手动补充。`,
    );
  }

  // 2) 适配器绑定（仍需通过白名单校验）。
  const adapterBindings = new Map<string, Omit<FieldRef, 'recordId'>>();
  for (const binding of scan.adapterBindings) {
    if (binding.section === 'unknown') continue;
    const section = binding.section as KnownSection;
    if (!getCatalogField(section, binding.field)) continue;
    adapterBindings.set(binding.fieldId, { section, field: binding.field });
  }

  const context: MatchContext = {
    data,
    profileId: profile.profileId,
    rules: options.rules,
    adapterBindings,
    manualBindings: options.manualBindings ?? new Map(),
    recordBindings,
  };

  const actions: FillAction[] = [];
  const results: FieldResult[] = [];

  /** 履历里没有、但你上次手动补填并记住了的字段：同名字段（经历类还要同一段经历）直接用记住的值 */
  const rememberedAction = (descriptor: FieldDescriptor): FillAction | null => {
    // 敏感字段（婚姻状况等）只有你主动勾选记住过才会在这里命中；证件号、银行卡这类永远不记
    if (!options.remembered?.length || descriptor.section === 'unknown' || descriptor.datePart || NEVER_REMEMBER.test(descriptor.normalizedLabel)) return null;
    if (!REMEMBERABLE.includes(descriptor.controlKind)) return null;
    const section = descriptor.section as KnownSection;
    let recordKey: string | null = null;
    let recordId: string | undefined;
    if (descriptor.recordInstanceId) {
      const binding = recordBindings.get(descriptor.recordInstanceId);
      if (!binding?.ok) return null;
      recordId = binding.recordId;
      recordKey = recordSummaries(data, section).find((record) => record.id === recordId)?.identity || null;
      if (!recordKey) return null;
    }
    const hit = findRemembered(options.remembered, section, descriptor.normalizedLabel || descriptor.label, recordKey);
    if (!hit) return null;
    const projection = projectValue({ kind: 'text', value: hit.value }, descriptor, REMEMBERED_CATALOG);
    if (!projection.ok) return null;
    return {
      fieldId: descriptor.fieldId,
      source: { section, field: REMEMBERED_FIELD, ...(recordId ? { recordId } : {}) },
      expectedFingerprint: descriptor.semanticFingerprint,
      kind: descriptor.controlKind,
      value: projection.value,
      overwrite: false,
    };
  };

  for (const descriptor of scan.descriptors) {
    if (options.onlyFieldIds && !options.onlyFieldIds.has(descriptor.fieldId)) continue;

    if (descriptor.controlKind === 'unsupported') {
      results.push(resultFor(descriptor, 'pending', 'UNSUPPORTED_WIDGET'));
      continue;
    }
    if (descriptor.sensitive) {
      // 默认仍不碰敏感字段。只有用户主动保存在履历中的少数白名单字段，且
      // 当前站点适配器给出明确绑定时才继续；通用别名和手动规则都不能放宽。
      const explicit = adapterBindings.get(descriptor.fieldId);
      const allowed = explicit ? getCatalogField(explicit.section, explicit.field)?.sensitiveAutofill === true : false;
      if (!allowed) {
        // 你手动补填过、并在清单里主动勾选记住的敏感字段（例如婚姻状况）：按你的选择填
        const remembered = rememberedAction(descriptor);
        if (remembered) actions.push(remembered);
        else results.push(resultFor(descriptor, 'pending', 'REQUIRES_USER_ACTION'));
        continue;
      }
    }
    if (descriptor.disabled || descriptor.readOnly || !descriptor.visible) {
      results.push(resultFor(descriptor, 'pending', 'REQUIRES_USER_ACTION'));
      continue;
    }

    const decision = matchField(descriptor, context);
    if (decision.kind === 'rejected') {
      const remembered = decision.reasonCode === 'NO_MATCH' || decision.reasonCode === 'SOURCE_MISSING' ? rememberedAction(descriptor) : null;
      if (remembered) actions.push(remembered);
      else results.push(resultFor(descriptor, 'pending', decision.reasonCode));
      continue;
    }
    if (descriptor.sensitive) {
      const explicit = adapterBindings.get(descriptor.fieldId);
      if (!explicit || decision.source.section !== explicit.section || decision.source.field !== explicit.field) {
        results.push(resultFor(descriptor, 'pending', 'REQUIRES_USER_ACTION'));
        continue;
      }
    }

    const catalogField = getCatalogField(decision.source.section, decision.source.field);
    if (!catalogField) {
      results.push(resultFor(descriptor, 'pending', 'NO_MATCH', decision.source));
      continue;
    }

    const value = readFieldValue(data, decision.source);
    const projection = projectValue(value, descriptor, catalogField);
    if (!projection.ok) {
      // 履历里这一项是空的：看看你有没有手动补填并记住过
      const remembered = projection.reasonCode === 'SOURCE_MISSING' ? rememberedAction(descriptor) : null;
      if (remembered) actions.push(remembered);
      else results.push(resultFor(descriptor, 'pending', projection.reasonCode, decision.source));
      continue;
    }

    actions.push({
      fieldId: descriptor.fieldId,
      source: decision.source,
      expectedFingerprint: descriptor.semanticFingerprint,
      kind: descriptor.controlKind,
      value: projection.value,
      overwrite: options.overwriteFieldIds?.has(descriptor.fieldId) ? 'user-approved' : false,
    });
  }

  // “至今”常同时呈现为一个不可填写的结束日期框和一个复选框。复选框已经能
  // 完整表达履历中的 present=true 时，不再把同一来源的空日期框重复列为待处理。
  const presentCheckboxSources = new Set(
    actions
      .filter((action) => action.kind === 'checkbox' && action.value === true)
      .map((action) => `${action.source.section}::${action.source.recordId ?? ''}::${action.source.field}`),
  );
  const checkedPresentRecordInstances = new Set(
    scan.descriptors
      .filter((descriptor) => descriptor.controlKind === 'checkbox' && !descriptor.empty && /至今$/.test(descriptor.normalizedLabel))
      .map((descriptor) => descriptor.recordInstanceId)
      .filter((id): id is string => Boolean(id)),
  );
  // 真实 Phoenix 会先把结束日期框标成 disabled/readOnly，再把同记录的“至今”
  // 复选框作为唯一可写控件。前者因此在字段匹配前就产生 source=null，不能只靠
  // 来源字段去重；只要本轮已经计划勾选同记录的“至今”，结构上也已完整表达结束状态。
  for (const action of actions) {
    if (action.kind !== 'checkbox' || action.value !== true) continue;
    const descriptor = scan.descriptors.find((item) => item.fieldId === action.fieldId);
    if (descriptor?.recordInstanceId && /至今$/.test(descriptor.normalizedLabel)) {
      checkedPresentRecordInstances.add(descriptor.recordInstanceId);
    }
  }
  const representedResults = results.filter((result) => {
    if (result.reasonCode !== 'REQUIRES_USER_ACTION') return true;
    const descriptor = scan.descriptors.find((item) => item.fieldId === result.fieldId);
    if (!descriptor || (descriptor.controlKind !== 'date-picker' && descriptor.controlKind !== 'date' && descriptor.controlKind !== 'month')) {
      return true;
    }
    const endDateDescriptor = descriptor.datePart?.edge === 'end' || /(?:结束|截止|终止|离职)时间/.test(descriptor.normalizedLabel);
    if (endDateDescriptor && descriptor.recordInstanceId !== null && checkedPresentRecordInstances.has(descriptor.recordInstanceId)) {
      return false;
    }
    if (!result.source) return true;
    const key = `${result.source.section}::${result.source.recordId ?? ''}::${result.source.field}`;
    return !presentCheckboxSources.has(key) && !(
      result.source.field === 'endDate' &&
      descriptor.recordInstanceId !== null &&
      checkedPresentRecordInstances.has(descriptor.recordInstanceId)
    );
  });

  // 3) 新增经历：只有适配器提供按钮的分区才请求，且不超过履历实际条数。
  const addRequests: PlanResult['addRequests'] = [];
  for (const action of scan.addActions) {
    if (action.section === 'unknown') continue;
    const section = action.section as KnownSection;
    if (!getSection(section)) continue;
    const selfIntroduction = section === 'selfIntroduction';
    if (!selfIntroduction && !isRepeatedSection(section)) continue;
    const pageCount = selfIntroduction
      ? Number(scan.descriptors.some((descriptor) => descriptor.section === section))
      : scan.recordInstances.filter((instance) => instance.section === section).length;
    const profileCount = selfIntroduction
      ? Number(Boolean(data.selfIntroduction?.trim()))
      : recordSummaries(data, section).length;
    const missing = profileCount - pageCount;
    if (missing > 0) {
      addRequests.push({ section, sectionInstanceId: action.sectionInstanceId, count: selfIntroduction ? 1 : Math.min(missing, 5) });
    }
  }

  return {
    actions,
    results: representedResults,
    addRequests,
    recordBindingNotes,
    excessEmptyRecordInstanceIds: [...excessEmptyRecordInstanceIds],
  };
}
