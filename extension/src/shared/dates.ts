import type { EndDate, PartialDate } from './types';

/** 结构化日期投影。绝不做时区转换，也绝不补齐缺失的月或日。 */

export type DatePrecision = 'year' | 'month' | 'day';

export function isPresent(value: EndDate | null): value is { present: true } {
  return value !== null && typeof value === 'object' && 'present' in value;
}

export function asPartialDate(value: EndDate | null): PartialDate | null {
  if (value === null || isPresent(value)) return null;
  return value;
}

export function precisionOf(date: PartialDate): DatePrecision {
  if (date.day !== undefined) return 'day';
  if (date.month !== undefined) return 'month';
  return 'year';
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 只有精度足够时才返回 yyyy-mm-dd；精度不足返回 null，由调用方报告 PRECISION_MISMATCH。 */
export function toDateInputValue(date: PartialDate): string | null {
  if (date.month === undefined || date.day === undefined) return null;
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

/** month 控件需要 yyyy-mm；只有年份时精度不足。 */
export function toMonthInputValue(date: PartialDate): string | null {
  if (date.month === undefined) return null;
  return `${date.year}-${pad2(date.month)}`;
}

export function toYearValue(date: PartialDate): string {
  return String(date.year);
}

export function toMonthNumberValue(date: PartialDate): string | null {
  if (date.month === undefined) return null;
  return String(date.month);
}

/** 中文显示用；仅按已有精度渲染。 */
export function formatPartialDate(date: PartialDate): string {
  if (date.day !== undefined && date.month !== undefined) return `${date.year} 年 ${date.month} 月 ${date.day} 日`;
  if (date.month !== undefined) return `${date.year} 年 ${date.month} 月`;
  return `${date.year} 年`;
}

export function formatEndDate(value: EndDate | null): string {
  if (value === null) return '未填写';
  if (isPresent(value)) return '至今';
  return formatPartialDate(value);
}

/** 供文本控件使用的常见写法，按精度生成，不虚构缺失部分。 */
export function toTextValue(date: PartialDate, style: 'dash' | 'chinese' | 'slash' = 'dash'): string {
  const parts: string[] = [String(date.year)];
  if (date.month !== undefined) parts.push(pad2(date.month));
  if (date.day !== undefined) parts.push(pad2(date.day));
  if (style === 'chinese') return formatPartialDate(date);
  return parts.join(style === 'slash' ? '/' : '-');
}

/** 起止顺序检查：结束不得早于开始。用于编辑器保存前的格式检查。 */
export function compareDates(a: PartialDate, b: PartialDate): number {
  if (a.year !== b.year) return a.year - b.year;
  const am = a.month ?? 0;
  const bm = b.month ?? 0;
  if (am !== bm) return am - bm;
  return (a.day ?? 0) - (b.day ?? 0);
}

export function rangeIsValid(start: PartialDate | null, end: EndDate | null): boolean {
  if (start === null || end === null || isPresent(end)) return true;
  return compareDates(start, end) <= 0;
}

/** UTC ISO 存储值按指定时区显示。不用于履历中的结构化日期。 */
export function formatTimestamp(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
