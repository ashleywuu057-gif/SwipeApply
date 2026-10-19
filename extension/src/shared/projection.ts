import type { CatalogField, CatalogValue } from './field-catalog';
import { formatEndDate, isPresent, toDateInputValue, toMonthInputValue, toTextValue } from './dates';
import { normalizeLabel } from './normalize';
import type { FieldDescriptor, PartialDate, ReasonCode } from './types';

/**
 * 值投影：把履历中的结构化值转换成某个控件可以接受的表示。
 * 只做 trim、单/多值选择、年月格式、用户明确授权的日期默认值与有限等价枚举。
 */

export type Projection =
  | { ok: true; value: string | boolean | string[] }
  | { ok: false; reasonCode: ReasonCode; message: string };

const BOOLEAN_WORDS: Record<'true' | 'false', string[]> = {
  true: ['是', '接受', '愿意', '可以', 'yes', 'true'],
  false: ['否', '不接受', '不愿意', '不可以', 'no', 'false'],
};

const PRESENT_WORDS = ['至今', '在职', '在读', 'present', 'now'];

function availabilityRepresentations(value: string): string[] {
  const raw = value.trim();
  const normalized = normalizeLabel(raw).toLowerCase();
  if (/^(?:随时|随时到岗|立即到岗|即刻到岗)$/.test(normalized)) {
    // “立即/随时”是“一周内”的更严格承诺，北森常只提供后者。
    return [raw, '随时', '随时到岗', '立即到岗', '一周内'];
  }
  return [raw];
}

/** 一个值在网页上可以接受的写法集合；集合为空表示无法表示。 */
export function acceptableRepresentations(value: CatalogValue): string[] {
  switch (value.kind) {
    case 'text':
    case 'longText':
      return [value.value.trim()];
    case 'number': {
      const n = String(value.value);
      return [n, `${n}个月`, `${n} 个月`, `${n}天`, `${n} 天`];
    }
    case 'boolean':
      return BOOLEAN_WORDS[value.value ? 'true' : 'false'];
    case 'enum':
      return value.equivalents.length > 0 ? [...value.equivalents] : [];
    case 'date':
      return [
        toTextValue(value.value, 'dash'),
        toTextValue(value.value, 'slash'),
        toTextValue(value.value, 'chinese'),
      ];
    case 'endDate':
      return isPresent(value.value)
        ? [...PRESENT_WORDS]
        : [
            toTextValue(value.value, 'dash'),
            toTextValue(value.value, 'slash'),
            toTextValue(value.value, 'chinese'),
          ];
    case 'stringList':
    case 'missing':
      return [];
  }
}

function matchOption(
  descriptor: FieldDescriptor,
  candidates: string[],
): { ok: true; value: string } | { ok: false; reasonCode: ReasonCode; message: string } {
  if (candidates.length === 0) {
    return { ok: false, reasonCode: 'AMBIGUOUS_OPTION', message: '履历中的值无法对应到这个控件的选项' };
  }
  const wanted = new Set(candidates.map((item) => normalizeLabel(item).toLowerCase()).filter(Boolean));
  const hits = descriptor.options.filter((option) => {
    const label = normalizeLabel(option.label).toLowerCase();
    const raw = normalizeLabel(option.value).toLowerCase();
    return (label.length > 0 && wanted.has(label)) || (raw.length > 0 && wanted.has(raw));
  });
  // 同一个选项 value 出现多次视为一个。
  const distinct = new Map(hits.map((option) => [option.value, option]));
  if (distinct.size === 1) return { ok: true, value: [...distinct.values()][0]!.value };
  if (distinct.size === 0) {
    return { ok: false, reasonCode: 'AMBIGUOUS_OPTION', message: '没有找到完全对应的选项，需要手动选择' };
  }
  return { ok: false, reasonCode: 'AMBIGUOUS_OPTION', message: `有 ${distinct.size} 个选项都能对应，需要手动选择` };
}

function dateWithDefaultMonth(date: PartialDate, catalogField: CatalogField): PartialDate {
  if (date.month !== undefined || catalogField.dateDefault === undefined) return date;
  return { ...date, month: catalogField.dateDefault.month };
}

function dateWithDefaultDay(
  date: PartialDate,
  catalogField: CatalogField,
): { year: number; month: number; day: number } | null {
  const withMonth = dateWithDefaultMonth(date, catalogField);
  if (withMonth.month === undefined) return null;
  if (withMonth.day !== undefined) {
    return { year: withMonth.year, month: withMonth.month, day: withMonth.day };
  }
  const configured = catalogField.dateDefault;
  return {
    year: withMonth.year,
    month: withMonth.month,
    // 教育起止日期使用用户指定的 9 月 1 日和 6 月 30 日；其他月精度
    // 日期在网页强制要求“日”时补为当月 1 日。
    day: configured && withMonth.month === configured.month ? configured.day : 1,
  };
}

function projectDatePart(descriptor: FieldDescriptor, value: CatalogValue, catalogField: CatalogField): Projection {
  const part = descriptor.datePart;
  if (!part) return { ok: false, reasonCode: 'UNSUPPORTED_WIDGET', message: '控件没有明确的年/月角色' };
  if (value.kind === 'endDate' && isPresent(value.value) && descriptor.datePresentValue) {
    return { ok: true, value: descriptor.datePresentValue };
  }
  const rawDate = value.kind === 'date' ? value.value : value.kind === 'endDate' && !isPresent(value.value) ? value.value : null;
  const date = rawDate ? dateWithDefaultMonth(rawDate, catalogField) : null;
  if (!date) {
    if (value.kind === 'endDate' && isPresent(value.value)) {
      return { ok: false, reasonCode: 'REQUIRES_USER_ACTION', message: '「至今」需要手动选择对应写法' };
    }
    return { ok: false, reasonCode: 'SOURCE_MISSING', message: '缺少日期' };
  }
  // 飞书起止区间的一个端点由单个“年+月”面板表示；datePart 只说明起止端，
  // 执行器仍需要完整的 YYYY-MM，而不是拆开的单月数字。
  if (descriptor.controlKind === 'date-picker' && descriptor.datePrecision === 'month') {
    if (date.month === undefined) {
      return { ok: false, reasonCode: 'PRECISION_MISMATCH', message: '履历只记录到年份，缺少月份' };
    }
    return { ok: true, value: `${date.year}-${String(date.month).padStart(2, '0')}` };
  }
  if (part.unit === 'year') {
    const text = String(date.year);
    return descriptor.controlKind === 'select' || descriptor.controlKind === 'combobox' || descriptor.controlKind === 'radio'
      ? optionProjection(descriptor, [text, `${text}年`, `${text} 年`])
      : { ok: true, value: text };
  }
  if (date.month === undefined) {
    return { ok: false, reasonCode: 'PRECISION_MISMATCH', message: '履历只记录到年份，缺少月份' };
  }
  const month = String(date.month);
  const padded = String(date.month).padStart(2, '0');
  return descriptor.controlKind === 'select' || descriptor.controlKind === 'combobox' || descriptor.controlKind === 'radio'
    ? optionProjection(descriptor, [month, padded, `${month}月`, `${month} 月`, `${padded}月`])
    : { ok: true, value: month };
}

function optionProjection(descriptor: FieldDescriptor, candidates: string[]): Projection {
  if (descriptor.controlKind === 'combobox') {
    // combobox 的选项在展开后才可见，把可接受写法交给执行器精确匹配。
    const usable = candidates.map((item) => item.trim()).filter(Boolean);
    if (usable.length === 0) {
      return { ok: false, reasonCode: 'AMBIGUOUS_OPTION', message: '履历中的值无法对应到这个控件的选项' };
    }
    return { ok: true, value: usable };
  }
  const matched = matchOption(descriptor, candidates);
  return matched.ok ? { ok: true, value: matched.value } : matched;
}

/** 把履历值投影到具体控件。失败时给出 reasonCode，由报告呈现给用户。 */
export function projectValue(
  value: CatalogValue,
  descriptor: FieldDescriptor,
  catalogField: CatalogField,
): Projection {
  if (value.kind === 'missing') {
    return { ok: false, reasonCode: 'SOURCE_MISSING', message: '履历中没有这一项内容' };
  }
  if (catalogField.requiresConfirmation) {
    return { ok: false, reasonCode: 'REQUIRES_USER_ACTION', message: '这类信息需要你逐项确认后手动填写' };
  }
  if (value.kind === 'stringList') {
    // combobox 执行器会读取网页当时真正提供的选项，并且只点击唯一的精确交集。
    // 因而可以把整个候选列表交给它，既不擅自取第一项，也不模糊匹配。
    if (descriptor.controlKind === 'combobox') {
      const candidates = value.value.map((item) => item.trim()).filter(Boolean);
      return candidates.length > 0
        ? { ok: true, value: candidates }
        : { ok: false, reasonCode: 'SOURCE_MISSING', message: '履历中的候选列表为空' };
    }
    if (descriptor.controlKind === 'textarea') {
      return { ok: true, value: value.value.join('、') };
    }
    return {
      ok: false,
      reasonCode: 'REQUIRES_USER_ACTION',
      message: `履历中有 ${value.value.length} 个选项，需要你决定填哪一个`,
    };
  }

  if (descriptor.datePart) return projectDatePart(descriptor, value, catalogField);

  switch (descriptor.controlKind) {
    case 'text':
    case 'textarea': {
      let text: string;
      if (value.kind === 'date') text = toTextValue(value.value, 'dash');
      else if (value.kind === 'endDate') text = isPresent(value.value) ? '至今' : toTextValue(value.value, 'dash');
      else if (value.kind === 'number') text = String(value.value);
      else if (value.kind === 'boolean') {
        return { ok: false, reasonCode: 'REQUIRES_USER_ACTION', message: '是否类信息需要你选择具体写法' };
      } else if (value.kind === 'enum') {
        const first = value.equivalents[0];
        if (!first) return { ok: false, reasonCode: 'REQUIRES_USER_ACTION', message: '这个枚举没有对应的中文写法' };
        text = first;
      } else text = value.value.trim();

      if (text.length === 0) return { ok: false, reasonCode: 'SOURCE_MISSING', message: '履历中这一项为空' };
      if (descriptor.maxLength !== null && text.length > descriptor.maxLength) {
        return {
          ok: false,
          reasonCode: 'TEXT_TOO_LONG',
          message: `内容 ${text.length} 字，超过网页限制的 ${descriptor.maxLength} 字，请先在履历中缩写`,
        };
      }
      return { ok: true, value: text };
    }
    case 'select':
    case 'radio':
    case 'combobox':
      return optionProjection(
        descriptor,
        catalogField.field === 'availabilityText' && value.kind === 'text'
          ? availabilityRepresentations(value.value)
          : acceptableRepresentations(value),
      );
    case 'checkbox': {
      if (value.kind === 'endDate') {
        return { ok: true, value: isPresent(value.value) };
      }
      if (value.kind !== 'boolean') {
        return { ok: false, reasonCode: 'REQUIRES_USER_ACTION', message: '这个勾选项需要你自己判断' };
      }
      return { ok: true, value: value.value };
    }
    case 'date-picker': {
      if (value.kind === 'endDate' && isPresent(value.value)) {
        return { ok: false, reasonCode: 'REQUIRES_USER_ACTION', message: '「至今」不是一个年月日期' };
      }
      const rawDate = value.kind === 'date' ? value.value : value.kind === 'endDate' ? value.value : null;
      if (!rawDate || !('year' in rawDate)) return { ok: false, reasonCode: 'SOURCE_MISSING', message: '缺少日期' };
      const date = dateWithDefaultMonth(rawDate, catalogField);
      if (descriptor.datePrecision === 'year') {
        return { ok: true, value: String(date.year) };
      }
      if (date.month === undefined) {
        return { ok: false, reasonCode: 'PRECISION_MISMATCH', message: '网页要求精确到月，履历只记录到年' };
      }
      if (descriptor.datePrecision === 'day') {
        const complete = dateWithDefaultDay(date, catalogField);
        if (!complete) return { ok: false, reasonCode: 'PRECISION_MISMATCH', message: '网页要求精确到日，但履历缺少月份' };
        return {
          ok: true,
          value: `${complete.year}-${String(complete.month).padStart(2, '0')}-${String(complete.day).padStart(2, '0')}`,
        };
      }
      return { ok: true, value: `${date.year}-${String(date.month).padStart(2, '0')}` };
    }
    case 'date': {
      if (value.kind === 'endDate' && isPresent(value.value)) {
        return { ok: false, reasonCode: 'REQUIRES_USER_ACTION', message: `「${formatEndDate(value.value)}」无法写入日期控件` };
      }
      const rawDate = value.kind === 'date' ? value.value : value.kind === 'endDate' ? value.value : null;
      if (!rawDate || !('year' in rawDate)) return { ok: false, reasonCode: 'SOURCE_MISSING', message: '缺少日期' };
      const complete = dateWithDefaultDay(rawDate, catalogField);
      const text = complete ? toDateInputValue(complete) : null;
      if (text === null) {
        return {
          ok: false,
          reasonCode: 'PRECISION_MISMATCH',
          message: '网页要求精确到日，但履历缺少月份',
        };
      }
      return { ok: true, value: text };
    }
    case 'month': {
      if (value.kind === 'endDate' && isPresent(value.value)) {
        return { ok: false, reasonCode: 'REQUIRES_USER_ACTION', message: '「至今」无法写入月份控件' };
      }
      const rawDate = value.kind === 'date' ? value.value : value.kind === 'endDate' ? value.value : null;
      if (!rawDate || !('year' in rawDate)) return { ok: false, reasonCode: 'SOURCE_MISSING', message: '缺少日期' };
      const date = dateWithDefaultMonth(rawDate, catalogField);
      const text = toMonthInputValue(date);
      if (text === null) {
        return { ok: false, reasonCode: 'PRECISION_MISMATCH', message: '履历只记录到年份，缺少月份' };
      }
      return { ok: true, value: text };
    }
    case 'unsupported':
      return { ok: false, reasonCode: 'UNSUPPORTED_WIDGET', message: '这种控件需要手动处理' };
  }
}
