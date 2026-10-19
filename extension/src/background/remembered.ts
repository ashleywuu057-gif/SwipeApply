import { normalizeLabel } from '../shared/normalize';
import type { KnownSection, RememberedAnswer } from '../shared/types';

/**
 * jobprep：记住你手动补填的内容。单独存一个 storage 键（和 active-runs 一样），不进 AppState、不进备份，
 * 只在本机插件里；可以在「规则」页查看和删除。
 */

const KEY = 'applykit.remembered-answers.v1';

/**
 * 永远不记：证件号、银行卡、社保公积金、密码这类泄露了会造成实际损失的。
 * 其他敏感信息（婚姻状况、政治面貌、民族…）只有你在清单里主动勾选才记，默认不勾。
 */
export const NEVER_REMEMBER = /身份证|证件号|护照|台胞证|港澳|社保|公积金|银行|开户行|密码/;
const MAX = 200;

export async function readRemembered(): Promise<RememberedAnswer[]> {
  const got = await chrome.storage.local.get(KEY);
  const list = got[KEY];
  return Array.isArray(list) ? (list as RememberedAnswer[]) : [];
}

async function write(list: RememberedAnswer[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: list.slice(-MAX) });
}

export const recordKeyOf = (identity: string | null | undefined): string | null =>
  identity && identity.trim() ? normalizeLabel(identity).toLowerCase() : null;

const sameSlot = (a: Pick<RememberedAnswer, 'section' | 'label' | 'recordKey'>, b: Pick<RememberedAnswer, 'section' | 'label' | 'recordKey'>) =>
  a.section === b.section && a.label === b.label && a.recordKey === b.recordKey;

export interface RememberInput {
  section: KnownSection;
  label: string;
  recordKey: string | null;
  value: string;
  origin: string;
}

/** 同一个字段（分区 + 字段名 + 所属经历）只留最新的一条 */
export async function saveRemembered(items: RememberInput[]): Promise<RememberedAnswer[]> {
  const list = await readRemembered();
  const now = new Date().toISOString();
  for (const item of items) {
    const next: RememberedAnswer = {
      id: crypto.randomUUID(),
      section: item.section,
      label: normalizeLabel(item.label),
      displayLabel: item.label.slice(0, 100),
      recordKey: recordKeyOf(item.recordKey),
      value: item.value.slice(0, 2000),
      savedAt: now,
      origin: item.origin.slice(0, 200),
    };
    const i = list.findIndex((x) => sameSlot(x, next));
    if (i >= 0) list.splice(i, 1);
    list.push(next);
  }
  await write(list);
  return list;
}

export async function deleteRemembered(id: string): Promise<RememberedAnswer[]> {
  const list = (await readRemembered()).filter((x) => x.id !== id);
  await write(list);
  return list;
}

/** 找这个字段记住的值：先找同一段经历的，个人字段直接按分区 + 字段名 */
export function findRemembered(
  list: RememberedAnswer[],
  section: KnownSection,
  label: string,
  recordKey: string | null,
): RememberedAnswer | null {
  const normalized = normalizeLabel(label);
  return list.find((x) => x.section === section && x.label === normalized && x.recordKey === recordKeyOf(recordKey)) ?? null;
}
