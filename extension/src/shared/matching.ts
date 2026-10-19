import { ALIAS_INDEX, getCatalogField, getSection, isRepeatedSection } from './field-catalog';
import { normalizeLabel } from './normalize';
import type {
  DegreeLevel, FieldDescriptor, FieldRef, KnownSection, MatchCandidate, MatchReason,
  ProfileData, ReasonCode, SavedMapping,
} from './types';

/**
 * 纯函数字段匹配。分值是确定的规则分，不是模型概率。
 * 用户规则 100、专用适配器 95、分区内精确别名 90、唯一 placeholder 70、只有 name 提示 50。
 */

export const SCORE = {
  userRule: 100,
  adapter: 95,
  manual: 100,
  sectionAlias: 90,
  placeholderHint: 70,
  nameHint: 50,
} as const;

export const AUTO_FILL_MIN_SCORE = 90;
export const AUTO_FILL_MIN_GAP = 15;

export interface RecordSummary {
  id: string;
  primary?: boolean;
  /** 教育经历的学历层级，其他分区为 null。 */
  degreeLevel: DegreeLevel | null;
  /** 用于唯一身份匹配的名称（学校 / 公司 / 项目名 / 语种）。 */
  identity: string;
}

export interface RecordInstance {
  recordInstanceId: string;
  degreeHint: DegreeLevel | null;
  identityHint: string | null;
  /** 页面上的出现顺序，仅在明确允许时才作为依据。 */
  order: number;
}

export type RecordBindingResult =
  | { ok: true; recordId: string; reason: 'adapter' | 'degree' | 'identity' | 'user' | 'default' | 'unique' | 'order' }
  | { ok: false; reasonCode: Extract<ReasonCode, 'AMBIGUOUS_RECORD' | 'SOURCE_MISSING'>; message: string };

export interface BindRecordsOptions {
  adapterBindings?: Map<string, string>;
  userBindings?: Map<string, string>;
  /** 履历中明确标记的默认记录，用于页面槽位少于履历条数时做确定性选择。 */
  defaultRecordId?: string;
  /** 只有适配器或用户明确指定「按履历顺序」时才为 true。 */
  allowOrderFallback?: boolean;
}

/**
 * 绑定顺序：适配器 → 页面已填记录的唯一身份 → 用户本轮选择 → 可证明的固定顺序。
 * 同一履历记录不会被绑定到两个网页容器。
 */
export function bindRecords(
  instances: RecordInstance[],
  records: RecordSummary[],
  options: BindRecordsOptions = {},
): Map<string, RecordBindingResult> {
  const result = new Map<string, RecordBindingResult>();
  const used = new Set<string>();
  const pending: RecordInstance[] = [];

  const claim = (
    instance: RecordInstance,
    recordId: string,
    reason: 'adapter' | 'degree' | 'identity' | 'user' | 'default' | 'unique' | 'order',
  ) => {
    if (used.has(recordId)) {
      result.set(instance.recordInstanceId, {
        ok: false,
        reasonCode: 'AMBIGUOUS_RECORD',
        message: '同一条履历经历被多个网页区块指向，需要人工确认',
      });
      return;
    }
    used.add(recordId);
    result.set(instance.recordInstanceId, { ok: true, recordId, reason });
  };

  // 1) 适配器与用户的明确指定优先，先占位避免被后续规则抢走。
  for (const instance of instances) {
    const explicit = options.adapterBindings?.get(instance.recordInstanceId);
    const chosen = options.userBindings?.get(instance.recordInstanceId);
    const target = explicit ?? chosen;
    if (target && records.some((record) => record.id === target)) {
      claim(instance, target, explicit ? 'adapter' : 'user');
    } else {
      pending.push(instance);
    }
  }

  // 2) 页面已有身份文本的唯一精确匹配。
  const stillPending: RecordInstance[] = [];
  for (const instance of pending) {
    if (!instance.identityHint) {
      stillPending.push(instance);
      continue;
    }
    const needle = normalizeLabel(instance.identityHint).toLowerCase();
    const matches = records.filter(
      (record) => !used.has(record.id) && normalizeLabel(record.identity).toLowerCase() === needle,
    );
    if (matches.length === 1) {
      claim(instance, matches[0]!.id, 'identity');
    } else if (matches.length > 1) {
      result.set(instance.recordInstanceId, {
        ok: false,
        reasonCode: 'AMBIGUOUS_RECORD',
        message: `履历中有 ${matches.length} 条同名记录，无法确定对应哪一条`,
      });
    } else if (records.some((record) => normalizeLabel(record.identity).toLowerCase() === needle)) {
      // 同名记录已经绑定给了另一个网页区块：这里不能改绑到别的经历。
      result.set(instance.recordInstanceId, {
        ok: false,
        reasonCode: 'AMBIGUOUS_RECORD',
        message: '网页上有两处指向履历中的同一条经历，需要人工确认',
      });
    } else {
      // 网页上已有名称但履历里没有同名记录：保留网页内容并报告，不改填成别的经历。
      result.set(instance.recordInstanceId, {
        ok: false,
        reasonCode: 'AMBIGUOUS_RECORD',
        message: '网页上的这条经历在履历中找不到同名记录，已保留原内容',
      });
    }
  }

  // 3) 页面明确标注的学历层级。
  const afterDegree: RecordInstance[] = [];
  for (const instance of stillPending) {
    if (!instance.degreeHint) {
      afterDegree.push(instance);
      continue;
    }
    const matches = records.filter((record) => !used.has(record.id) && record.degreeLevel === instance.degreeHint);
    if (matches.length === 1) claim(instance, matches[0]!.id, 'degree');
    else if (matches.length > 1) {
      result.set(instance.recordInstanceId, {
        ok: false,
        reasonCode: 'AMBIGUOUS_RECORD',
        message: `履历中有 ${matches.length} 段同层级学历，需要人工指定`,
      });
    } else {
      result.set(instance.recordInstanceId, {
        ok: false,
        reasonCode: 'SOURCE_MISSING',
        message: '履历中没有该学历层级的经历',
      });
    }
  }

  // 4) 明确默认记录占用第一个尚未绑定的页面槽位。
  // 这不是猜测：默认标记由用户在履历编辑器中维护。
  let afterDefault = afterDegree;
  if (options.defaultRecordId && afterDegree.length > 0 && !used.has(options.defaultRecordId)) {
    const exists = records.some((record) => record.id === options.defaultRecordId);
    if (exists) {
      const first = afterDegree.slice().sort((a, b) => a.order - b.order)[0]!;
      claim(first, options.defaultRecordId, 'default');
      afterDefault = afterDegree.filter((instance) => instance !== first);
    }
  }

  // 5) 唯一容器对唯一记录是可证明的对应，不需要顺序假设。
  const available = () => records.filter((record) => !used.has(record.id));
  if (afterDefault.length === 1 && available().length === 1) {
    claim(afterDefault[0]!, available()[0]!.id, 'unique');
    return result;
  }

  // 6) 仅在明确允许时按顺序绑定；通用模式不默认第一行就是硕士。
  const ordered = afterDefault.slice().sort((a, b) => a.order - b.order);
  for (const instance of ordered) {
    if (!options.allowOrderFallback) {
      result.set(instance.recordInstanceId, {
        ok: false,
        reasonCode: 'AMBIGUOUS_RECORD',
        message: '无法确定这一组网页字段对应哪一条经历，请手动指定',
      });
      continue;
    }
    const next = records.find((record) => !used.has(record.id));
    if (!next) {
      result.set(instance.recordInstanceId, {
        ok: false,
        reasonCode: 'SOURCE_MISSING',
        message: '履历中没有更多可填的经历',
      });
      continue;
    }
    claim(instance, next.id, 'order');
  }

  return result;
}

export interface MatchContext {
  data: ProfileData;
  profileId: string;
  /** 已按站点、路由与表单结构过滤，并通过页面校验的规则。 */
  rules: SavedMapping[];
  /** 适配器给出的明确绑定：fieldId -> FieldRef（不含 recordId）。 */
  adapterBindings?: Map<string, Omit<FieldRef, 'recordId'>>;
  /** 用户本轮手动绑定：fieldId -> FieldRef（不含 recordId）。 */
  manualBindings?: Map<string, Omit<FieldRef, 'recordId'>>;
  /** recordInstanceId -> 绑定结果。 */
  recordBindings: Map<string, RecordBindingResult>;
}

export type MatchDecision =
  | { kind: 'matched'; source: FieldRef; score: number; reasons: MatchReason[] }
  | { kind: 'rejected'; reasonCode: ReasonCode; message: string; candidates: MatchCandidate[] };

const refKey = (ref: Omit<FieldRef, 'recordId'>) => `${ref.section}.${ref.field}`;

function aliasCandidates(descriptor: FieldDescriptor): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  // 已可靠识别的年月分片直接绑定到本分区的开始/结束日期，不再依赖页面标签文字。
  if (descriptor.datePart && descriptor.section !== 'unknown') {
    const singleDateField: Partial<Record<KnownSection, string>> = {
      awards: 'date',
      languages: 'examDate',
      publications: 'publishedAt',
      certificates: 'obtainedAt',
    };
    const field = descriptor.datePart.edge === 'start'
      ? 'startDate'
      : descriptor.datePart.edge === 'end'
        ? 'endDate'
        : singleDateField[descriptor.section as KnownSection] ?? 'date';
    if (getCatalogField(descriptor.section, field)) {
      out.push({
        source: { section: descriptor.section, field },
        score: SCORE.sectionAlias,
        reasons: ['section-alias'],
      });
    }
  }
  const label = descriptor.normalizedLabel.toLowerCase();
  const entries = ALIAS_INDEX.get(label) ?? [];
  if (entries.length > 0) {
    const inSection = entries.filter((entry) => entry.section === descriptor.section);
    const usable = inSection.length > 0 ? inSection : descriptor.section === 'unknown' ? entries : [];
    // 分区未知且别名跨多个分区时不给分，交由用户处理，避免学校/公司/个人姓名交叉。
    const distinct = new Set(usable.map((entry) => `${entry.section}.${entry.field}`));
    if (usable.length > 0 && distinct.size === 1) {
      const entry = usable[0]!;
      out.push({ source: { section: entry.section, field: entry.field }, score: SCORE.sectionAlias, reasons: ['section-alias'] });
    } else if (distinct.size > 1) {
      for (const entry of usable) {
        out.push({ source: { section: entry.section, field: entry.field }, score: SCORE.sectionAlias, reasons: ['section-alias'] });
      }
    }
  }
  return out;
}

function hintCandidates(descriptor: FieldDescriptor): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  const addFromText = (raw: string | null, score: number, reason: MatchReason) => {
    if (!raw) return;
    const key = normalizeLabel(raw).toLowerCase();
    const entries = ALIAS_INDEX.get(key) ?? [];
    const usable = descriptor.section === 'unknown'
      ? entries
      : entries.filter((entry) => entry.section === descriptor.section);
    const distinct = new Set(usable.map((entry) => `${entry.section}.${entry.field}`));
    if (distinct.size !== 1) return;
    const entry = usable[0]!;
    out.push({ source: { section: entry.section, field: entry.field }, score, reasons: [reason] });
  };
  addFromText(descriptor.placeholderHint, SCORE.placeholderHint, 'placeholder-hint');
  addFromText(descriptor.nameHint, SCORE.nameHint, 'name-hint');
  return out;
}

function ruleCandidate(descriptor: FieldDescriptor, rules: SavedMapping[]): MatchCandidate | null {
  const applicable = rules.filter(
    (rule) => rule.fieldFingerprint === descriptor.semanticFingerprint && rule.controlKind === descriptor.controlKind,
  );
  if (applicable.length !== 1) return null;
  const rule = applicable[0]!;
  const section = rule.section;
  if (section === 'unknown') return null;
  if (!getCatalogField(section, rule.sourceField)) return null;
  return {
    source: { section, field: rule.sourceField },
    score: SCORE.userRule,
    reasons: ['user-rule'],
  };
}

/** 对单个描述符给出匹配结论；不读取网页值，也不产生副作用。 */
export function matchField(descriptor: FieldDescriptor, context: MatchContext): MatchDecision {
  if (descriptor.controlKind === 'unsupported') {
    return { kind: 'rejected', reasonCode: 'UNSUPPORTED_WIDGET', message: '这种控件需要手动处理', candidates: [] };
  }

  const manual = context.manualBindings?.get(descriptor.fieldId);
  const candidates: MatchCandidate[] = [];
  if (manual) {
    candidates.push({ source: manual, score: SCORE.manual, reasons: ['manual-binding'] });
  } else {
    const rule = ruleCandidate(descriptor, context.rules);
    if (rule) {
      candidates.push(rule);
    } else {
      const adapter = context.adapterBindings?.get(descriptor.fieldId);
      if (adapter) candidates.push({ source: adapter, score: SCORE.adapter, reasons: ['site-adapter'] });
      else candidates.push(...aliasCandidates(descriptor), ...hintCandidates(descriptor));
    }
  }

  if (candidates.length === 0) {
    return { kind: 'rejected', reasonCode: 'NO_MATCH', message: '没有找到对应的履历字段', candidates: [] };
  }

  // 同一源字段的多个证据合并取最大值。
  const merged = new Map<string, MatchCandidate>();
  for (const candidate of candidates) {
    const key = refKey(candidate.source);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...candidate, reasons: [...candidate.reasons] });
    } else {
      existing.score = Math.max(existing.score, candidate.score);
      for (const reason of candidate.reasons) if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    }
  }
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0]!;
  const runnerUp = ranked[1];

  if (best.score < AUTO_FILL_MIN_SCORE) {
    return {
      kind: 'rejected',
      reasonCode: 'NO_MATCH',
      message: '只有较弱的提示，不足以自动填写',
      candidates: ranked,
    };
  }
  if (runnerUp && best.score - runnerUp.score < AUTO_FILL_MIN_GAP) {
    return {
      kind: 'rejected',
      reasonCode: 'AMBIGUOUS_FIELD',
      message: '有两个同样有力的候选字段，需要人工确认',
      candidates: ranked,
    };
  }

  const section = best.source.section as KnownSection;
  if (!getSection(section)) {
    return { kind: 'rejected', reasonCode: 'NO_MATCH', message: '候选字段不在白名单中', candidates: ranked };
  }

  if (isRepeatedSection(section)) {
    if (!descriptor.recordInstanceId) {
      return {
        kind: 'rejected',
        reasonCode: 'AMBIGUOUS_RECORD',
        message: '这个字段没有归属到具体的一段经历',
        candidates: ranked,
      };
    }
    const binding = context.recordBindings.get(descriptor.recordInstanceId);
    if (!binding) {
      return {
        kind: 'rejected',
        reasonCode: 'AMBIGUOUS_RECORD',
        message: '无法确定这段网页经历对应履历中的哪一条',
        candidates: ranked,
      };
    }
    if (!binding.ok) {
      return { kind: 'rejected', reasonCode: binding.reasonCode, message: binding.message, candidates: ranked };
    }
    return {
      kind: 'matched',
      source: { section, recordId: binding.recordId, field: best.source.field },
      score: best.score,
      reasons: best.reasons,
    };
  }

  return { kind: 'matched', source: { section, field: best.source.field }, score: best.score, reasons: best.reasons };
}
