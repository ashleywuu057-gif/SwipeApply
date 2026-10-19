/** 投递记录 CSV 合同：UTF-8 BOM、CRLF、标准双引号转义、公式保护。 */

export const CSV_COLUMNS = [
  'id', 'company', 'role', 'location', 'sourceUrl', 'externalJobId', 'profileVersionId',
  'status', 'blocker', 'createdAt', 'updatedAt', 'appliedAt', 'nextAction', 'notes',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];
export type CsvRow = Record<CsvColumn, string>;

const BOM = '﻿';
const FORMULA_LEAD = /^[=+\-@]/;
const PROTECT_PREFIX = "'";

/** 以 = + - @ 开头的单元格加保护前缀，防止表格软件当公式执行。 */
export function protectFormula(value: string): string {
  const trimmedStart = value.replace(/^[\s ]+/, '');
  if (trimmedStart.length > 0 && FORMULA_LEAD.test(trimmedStart)) return `${PROTECT_PREFIX}${value}`;
  return value;
}

/** 只反向处理 ApplyKit 自己加的前缀：单引号后必须紧跟 = + - @。 */
export function unprotectFormula(value: string): string {
  if (!value.startsWith(PROTECT_PREFIX)) return value;
  const rest = value.slice(PROTECT_PREFIX.length);
  const afterSpace = rest.replace(/^[\s ]+/, '');
  return FORMULA_LEAD.test(afterSpace) ? rest : value;
}

function escapeCell(value: string): string {
  const protectedValue = protectFormula(value);
  if (/[",\r\n]/.test(protectedValue)) return `"${protectedValue.replace(/"/g, '""')}"`;
  return protectedValue;
}

export function toCsv(rows: CsvRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => escapeCell(row[column] ?? '')).join(','));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

/** RFC4180 状态机解析；不使用 split(',')，正确处理引号、换行与中文。 */
export function parseCsvTable(input: string): string[][] {
  const text = input.startsWith(BOM) ? input.slice(BOM.length) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let index = 0;

  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      cell += char;
      index += 1;
      continue;
    }
    if (char === '"' && cell.length === 0) {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      endCell();
      index += 1;
      continue;
    }
    if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      endRow();
      index += 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }
    cell += char;
    index += 1;
  }
  if (cell.length > 0 || row.length > 0) endRow();
  return rows.filter((entry) => !(entry.length === 1 && entry[0] === ''));
}

export interface CsvParseResult {
  rows: CsvRow[];
  errors: Array<{ line: number; message: string }>;
}

export function parseCsvRows(input: string): CsvParseResult {
  const table = parseCsvTable(input);
  const errors: Array<{ line: number; message: string }> = [];
  if (table.length === 0) return { rows: [], errors: [{ line: 0, message: 'CSV 文件为空' }] };

  const header = table[0]!.map((cell) => cell.trim());
  const missing = CSV_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return { rows: [], errors: [{ line: 1, message: `缺少列：${missing.join('、')}` }] };
  }
  const indexOf = new Map(header.map((name, position) => [name, position]));

  const rows: CsvRow[] = [];
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i]!;
    const row = {} as CsvRow;
    for (const column of CSV_COLUMNS) {
      const position = indexOf.get(column)!;
      // 所有列按字符串处理，不把电话号码或岗位 ID 当数字。
      row[column] = unprotectFormula(cells[position] ?? '');
    }
    if (row.id.trim() === '' && row.company.trim() === '' && row.role.trim() === '') {
      errors.push({ line: i + 1, message: '空行已跳过' });
      continue;
    }
    rows.push(row);
  }
  return { rows, errors };
}
