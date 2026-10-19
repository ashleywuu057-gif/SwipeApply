import { normalizeLabel, normalizeText } from '../../shared/normalize';
import { isVisible, nextFrames, waitFor } from '../dom-utils';
import { fillCustomSelect } from './custom-select';
import type { ControlEntry } from '../scanner';
import { failResult, okResult, readCurrentValue, type ControlResult } from '../verify';

/**
 * ARIA combobox：只处理有 aria-controls/aria-owns 明确关系、非虚拟化的列表。
 * 找不到唯一精确匹配时返回 AMBIGUOUS_OPTION，不反复点击碰运气。
 */

const OPEN_TIMEOUT_MS = 2000;

function listboxOf(element: HTMLElement): HTMLElement | null {
  const id = element.getAttribute('aria-controls') ?? element.getAttribute('aria-owns');
  if (!id) return null;
  const ids = id.split(/\s+/).filter(Boolean);
  if (ids.length !== 1) return null;
  const target = element.ownerDocument.getElementById(ids[0]!);
  if (!target) return null;
  const role = target.getAttribute('role');
  if (role !== 'listbox' && !target.querySelector('[role="option"]')) return null;
  return target;
}

function visibleOptions(listbox: HTMLElement): HTMLElement[] {
  return [...listbox.querySelectorAll<HTMLElement>('[role="option"]')].filter(
    (option) => isVisible(option) && option.getAttribute('aria-disabled') !== 'true',
  );
}

export async function fillCombobox(
  entry: ControlEntry,
  acceptable: string[],
  overwrite: boolean,
): Promise<ControlResult> {
  const element = entry.primary;
  const current = readCurrentValue(entry);
  const wanted = new Set(acceptable.map((item) => normalizeLabel(item).toLowerCase()).filter(Boolean));

  if (wanted.has(normalizeLabel(current).toLowerCase())) {
    return okResult('VALUE_ALREADY_EQUAL', '网页上已经是这个选项');
  }
  if (current.trim().length > 0 && !overwrite) {
    return failResult('EXISTING_VALUE', '网页已有不同选项，已保留原值');
  }

  if (!element.hasAttribute('aria-controls') && !element.hasAttribute('aria-owns')) {
    return element instanceof HTMLInputElement
      ? fillCustomSelect(entry, acceptable, overwrite)
      : failResult('UNSUPPORTED_WIDGET', '找不到这个下拉自己的选项列表');
  }

  element.focus({ preventScroll: true });
  if (element.getAttribute('aria-expanded') !== 'true') element.click();

  // 有些 React 下拉在首次点击前还没有创建 aria-controls 指向的 portal。
  // 先展开再重取关系，避免把语义完整的非 input combobox 错送进文本输入通道。
  await waitFor(() => listboxOf(element) !== null || entry.getSelectPopup?.() !== null, 250);
  const explicit = listboxOf(element);
  const popup = entry.getSelectPopup?.() ?? null;
  const listbox = explicit ?? (popup && (popup.getAttribute('role') === 'listbox' || popup.querySelector('[role="option"]'))
    ? popup as HTMLElement
    : null);
  if (!listbox) {
    // 没有 ARIA 关系的可搜索 input 下拉：改用控件自身容器的结构化通道。
    if (element instanceof HTMLInputElement) return fillCustomSelect(entry, acceptable, overwrite);
    return failResult('UNSUPPORTED_WIDGET', '找不到这个下拉自己的选项列表');
  }

  const opened = await waitFor(
    () => isVisible(listbox) && visibleOptions(listbox).length > 0,
    OPEN_TIMEOUT_MS,
  );
  if (!opened) {
    return failResult('TIMEOUT', '下拉选项没有在 2 秒内出现');
  }

  const options = visibleOptions(listbox);
  const declaredSize = Number(listbox.getAttribute('aria-setsize') ?? options[0]?.getAttribute('aria-setsize') ?? '0');
  if (declaredSize > 0 && declaredSize > options.length) {
    return failResult('UNSUPPORTED_WIDGET', '这个下拉是虚拟滚动列表，暂不支持自动选择');
  }

  const matched = options.filter((option) => {
    const text = normalizeLabel(option.textContent ?? '').toLowerCase();
    const value = normalizeLabel(option.getAttribute('data-value') ?? '').toLowerCase();
    return (text.length > 0 && wanted.has(text)) || (value.length > 0 && wanted.has(value));
  });

  if (matched.length === 0) {
    return failResult('AMBIGUOUS_OPTION', '下拉里没有完全对应的选项，需要手动选择');
  }
  if (matched.length > 1) {
    return failResult('AMBIGUOUS_OPTION', `有 ${matched.length} 个选项都能对应，需要手动选择`);
  }

  const target = matched[0]!;
  const expectedText = normalizeText(target.textContent ?? '');
  target.click();
  await nextFrames(2);

  if (!element.isConnected) {
    return failResult('STALE_PAGE', '写入后网页替换了这个节点，无法确认结果');
  }
  const after = normalizeLabel(readCurrentValue(entry)).toLowerCase();
  if (after !== normalizeLabel(expectedText).toLowerCase()) {
    return failResult('VALIDATION_FAILED', '点击选项后网页没有回显该值');
  }
  return okResult('FILLED_VERIFIED', '');
}
