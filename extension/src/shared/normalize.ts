/** 文本归一化。所有比较、别名匹配与去重都走这里，避免各处实现不一致。 */

const REQUIRED_MARKS = /[*＊✱]/g;
const TRAILING_PUNCT = /[:：\s]+$/;
const LEADING_PUNCT = /^[\s·•]+/;

/** NFKC + 去首尾空白 + 折叠空白。 */
export function normalizeText(input: string): string {
  return input.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** 只折叠空白，不做 NFKC。用于公司名等要按原样保存的文本。 */
export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** 网页标签归一化：额外移除必填星号与末尾冒号。不做同义词合并。 */
export function normalizeLabel(input: string): string {
  return normalizeText(input)
    .replace(REQUIRED_MARKS, '')
    .replace(LEADING_PUNCT, '')
    .replace(TRAILING_PUNCT, '')
    .trim();
}

/** 去重键使用的归一化：NFKC、trim、折叠空白、小写。null 视为空串。 */
export function normalizeKeyPart(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';
  return normalizeText(input).toLowerCase();
}

/** 值比较：判断网页现值与目标值是否已经相等。 */
export function valuesEqual(a: string, b: string): boolean {
  return normalizeText(a).toLowerCase() === normalizeText(b).toLowerCase();
}

/** 空值判定。注意 false 与 0 是有效值，不能当作缺失。 */
export function isMissing(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return normalizeText(value).length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
