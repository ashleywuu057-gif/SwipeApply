import { normalizeLabel } from '../../shared/normalize';
import { delay, dispatchInputEvents, isVisible, nextFrames, setNativeValue, waitFor } from '../dom-utils';
import type { ControlEntry } from '../scanner';
import { failResult, okResult, readCurrentValue, type ControlResult } from '../verify';

/** 北森 Phoenix 的省市选择器：搜索唯一地区，点单选图标，再显式确认。 */

const OPEN_TIMEOUT_MS = 2_000;
const SEARCH_TIMEOUT_MS = 2_500;
const COMMIT_TIMEOUT_MS = 1_000;

function areaKey(value: string): string {
  return normalizeLabel(value)
    .toLowerCase()
    .replace(/(?:特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|地区|省|市)$/u, '');
}

const AREA_SEGMENT = /[^省市区县旗]+?(?:特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|地区|省|市|区|县|旗)/gu;

/**
 * 招聘站点的地区库经常只到城市，而用户资料可能精确到区县。
 * 先尝试最具体的区县；站点没有该层级时，只允许退到资料中明确包含的城市，
 * 不退到过宽的省级选项。
 */
export function areaSearchChoices(value: string): string[] {
  const normalized = normalizeLabel(value);
  const segments = normalized.match(AREA_SEGMENT) ?? [];
  if (segments.length === 0) return normalized ? [normalized] : [];
  let cityIndex = -1;
  segments.forEach((segment, index) => {
    if (/(?:特别行政区|市)$/u.test(segment)) cityIndex = index;
  });
  const lowerBound = cityIndex >= 0 ? cityIndex : Math.max(0, segments.length - 1);
  return segments
    .slice(lowerBound)
    .reverse()
    .filter((segment, index, all) => areaKey(segment).length > 0 && all.indexOf(segment) === index);
}

export function areaValuesEqual(a: string, b: string): boolean {
  const left = areaKey(a);
  const right = areaKey(b);
  if (!left || !right) return false;
  if (left === right) return true;

  const leftChoices = areaSearchChoices(a).map(areaKey);
  const rightChoices = areaSearchChoices(b).map(areaKey);
  // 只允许“网页只显示一个城市、资料更详细”这种粒度投影。
  // 两个不同的详细地址即使同属一市，也不能被判为相同。
  if (leftChoices.length > 1 && rightChoices.length > 1) return false;
  return leftChoices.some((choice) => rightChoices.includes(choice));
}

function visibleAreaPicker(document: Document): HTMLElement | null {
  const matches = [...document.querySelectorAll<HTMLElement>('.common-unmodeled-layer .area-selector-container')]
    .filter(isVisible);
  return matches.length === 1 ? matches[0]! : null;
}

function exactLeaf(root: Element, selector: string, label: string): HTMLElement[] {
  const wanted = normalizeLabel(label).toLowerCase();
  return [...root.querySelectorAll<HTMLElement>(selector)]
    .filter(isVisible)
    .filter((node) => normalizeLabel(node.textContent ?? '').toLowerCase() === wanted);
}

async function cancel(picker: HTMLElement): Promise<void> {
  const buttons = exactLeaf(picker, '.phoenix-button__content', '取消');
  if (buttons.length === 1) buttons[0]!.click();
  else picker.ownerDocument.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await nextFrames(1);
}

function matchingAreaItems(picker: HTMLElement, acceptable: string[]): HTMLElement[] {
  const wanted = acceptable.map(areaKey).filter(Boolean);
  return [...picker.querySelectorAll<HTMLElement>('.area-item-container')]
    .filter(isVisible)
    .filter((item) => {
      const label = item.querySelector<HTMLElement>('.area-text-label');
      return label !== null && wanted.includes(areaKey(label.textContent ?? ''));
    });
}

function uniqueAreaValues(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = normalizeLabel(value);
    const key = normalized.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 北森多选 Phoenix 控件会把每个城市渲染成独立 tag；输入框本身始终为空。 */
export function readBeisenMultiAreaValues(element: Element): string[] {
  const input = element instanceof HTMLInputElement ? element : element.querySelector<HTMLInputElement>('input');
  const serialized = input?.dataset['selectedValues'];
  if (serialized) {
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (Array.isArray(parsed)) {
        return uniqueAreaValues(parsed.filter((item): item is string => typeof item === 'string'));
      }
    } catch {
      // 真实页面没有该测试辅助属性，继续读取可见 tag。
    }
  }

  const root = element.closest('.phoenix-select') ?? element;
  const explicit = [...root.querySelectorAll<HTMLElement>(
    '.phoenix-select__tipEle, [data-select-display], [class*="multiple"][class*="label"], '
      + '[class*="multi"][class*="label"], [class*="tag"][class*="label"]',
  )]
    .filter(isVisible)
    .map((node) => normalizeLabel(node.textContent ?? ''))
    .filter(Boolean);
  if (explicit.length > 0) return uniqueAreaValues(explicit);

  // Phoenix 版本间 tag 类名会变化。最后只读取控件内可见的叶子文本，排除占位
  // 与清除按钮，仍不跨到页面上的其他城市文字。
  return uniqueAreaValues(
    [...root.querySelectorAll<HTMLElement>('*')]
      .filter((node) => node.children.length === 0 && isVisible(node))
      .map((node) => normalizeLabel(node.textContent ?? ''))
      .filter((value) => value !== '' && value !== '请选择' && value !== '清除' && value !== '×'),
  );
}

export function readBeisenMultiAreaValue(element: Element): string {
  return readBeisenMultiAreaValues(element).join('、');
}

function clickAreaIcon(item: HTMLElement, multi: boolean): void {
  const icon = [...item.querySelectorAll<HTMLElement>('.icon-container')].find(isVisible);
  if (!icon) throw new Error('missing-area-icon');
  const selector = multi
    ? '.area-icon-CheckboxUnchecked, .area-icon-CheckboxChecked, [class*="CheckboxUnchecked"], [class*="CheckboxChecked"]'
    : '.area-icon-RadioUnchecked, .area-icon-RadioChecked, [class*="RadioUnchecked"], [class*="RadioChecked"]';
  const target = icon.querySelector<Element>(selector) ?? icon;
  if (target instanceof HTMLElement) target.click();
  else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function selectedAreaLabels(picker: HTMLElement): string[] {
  return [...picker.querySelectorAll<HTMLElement>('.select-area-text-label')]
    .filter(isVisible)
    .map((node) => normalizeLabel(node.textContent ?? ''))
    .filter(Boolean);
}

export async function fillAreaPicker(
  entry: ControlEntry,
  acceptable: string[],
  overwrite: boolean,
): Promise<ControlResult> {
  const input = entry.primary as HTMLInputElement;
  const current = readCurrentValue(entry).trim();
  const searchChoices = acceptable.flatMap(areaSearchChoices);
  if (searchChoices.some((candidate) => areaValuesEqual(current, candidate))) {
    return okResult('VALUE_ALREADY_EQUAL', '网页上已经是这个地区');
  }
  if (current && !overwrite) return failResult('EXISTING_VALUE', '网页已有不同地区，已保留原值');
  if (searchChoices.length === 0) return failResult('AMBIGUOUS_OPTION', '履历中的地区无法用于搜索');

  input.focus({ preventScroll: true });
  input.click();
  const opened = await waitFor(() => visibleAreaPicker(input.ownerDocument) !== null, OPEN_TIMEOUT_MS);
  let picker = visibleAreaPicker(input.ownerDocument);
  if (!opened || !picker) return failResult('TIMEOUT', '地区选择器没有在 2 秒内打开');

  const searchInputs = [...picker.querySelectorAll<HTMLInputElement>('input[placeholder="搜索"]')]
    .filter(isVisible)
    .filter((candidate) => !candidate.disabled && !candidate.readOnly);
  if (searchInputs.length !== 1) {
    await cancel(picker);
    return failResult('AMBIGUOUS_OPTION', '无法唯一定位地区搜索框');
  }

  const currentMatches = (target: string): HTMLElement[] => {
    const current = visibleAreaPicker(input.ownerDocument);
    return current ? matchingAreaItems(current, [target]) : [];
  };
  let selectedTarget: string | null = null;
  let matches: HTMLElement[] = [];
  for (const target of searchChoices) {
    setNativeValue(searchInputs[0]!, areaKey(target));
    dispatchInputEvents(searchInputs[0]!);
    const found = await waitFor(() => currentMatches(target).length > 0, SEARCH_TIMEOUT_MS);
    matches = currentMatches(target);
    if (found && matches.length > 0) {
      selectedTarget = target;
      break;
    }
  }
  picker = visibleAreaPicker(input.ownerDocument);
  if (!selectedTarget || matches.length === 0) {
    if (picker) await cancel(picker);
    return failResult('AMBIGUOUS_OPTION', '地区搜索中没有对应的区县或城市选项，需要手动选择');
  }
  if (matches.length !== 1) {
    if (picker) await cancel(picker);
    return failResult('AMBIGUOUS_OPTION', `地区搜索中有 ${matches.length} 个对应项，需要手动选择`);
  }

  const optionLabel = normalizeLabel(matches[0]!.querySelector('.area-text-label')?.textContent ?? '');
  const icons = [...matches[0]!.querySelectorAll<HTMLElement>('.icon-container')].filter(isVisible);
  if (icons.length !== 1) {
    if (picker) await cancel(picker);
    return failResult('UNSUPPORTED_WIDGET', '地区选项缺少唯一的单选按钮');
  }
  // 真实 Phoenix 把 onClick 绑在图标子节点；对外层 icon-container 调用
  // HTMLElement.click() 不会把事件向子节点传递。浏览器人工点击外壳时实际
  // 命中的也是这个内层图标。
  // 真实页面的内层图标是 SVGElement，没有 HTMLElement.click()。通过统一入口给
  // SVG 派发冒泡 MouseEvent，触发与人工点击相同的 React 链路。
  clickAreaIcon(matches[0]!, false);
  // 真实 Phoenix 在选中地区后会替换整个 picker 子树。每次等待都从
  // document 重新取当前弹层，不在已断开的旧节点上误判失败。
  const selected = await waitFor(() => {
    const current = visibleAreaPicker(input.ownerDocument);
    return current !== null && exactLeaf(current, '.select-area-text-label', optionLabel).length === 1;
  }, COMMIT_TIMEOUT_MS);
  if (!selected) {
    const current = visibleAreaPicker(input.ownerDocument);
    if (current) await cancel(current);
    return failResult('VALIDATION_FAILED', '地区选项没有进入已选列表');
  }

  picker = visibleAreaPicker(input.ownerDocument);
  if (!picker) return failResult('STALE_PAGE', '选中地区后弹层结构已变化');
  const confirmButtons = exactLeaf(picker, '.phoenix-button__content', '确定');
  if (confirmButtons.length !== 1) {
    await cancel(picker);
    return failResult('AMBIGUOUS_OPTION', '无法唯一定位地区确认按钮');
  }
  confirmButtons[0]!.click();
  const closed = await waitFor(
    () => visibleAreaPicker(input.ownerDocument) === null,
    COMMIT_TIMEOUT_MS,
  );
  await nextFrames(2);
  await delay(60);
  if (!closed) {
    await cancel(picker);
    return failResult('TIMEOUT', '确认地区后弹窗没有关闭');
  }
  if (!input.isConnected) return failResult('STALE_PAGE', '选择地区后网页替换了节点');
  if (!areaValuesEqual(readCurrentValue(entry), optionLabel)) {
    return failResult('VALIDATION_FAILED', '确认地区后网页没有回显目标值');
  }
  return okResult('FILLED_VERIFIED', '');
}

/** 北森期望城市使用同一个地区弹窗，但通过复选框一次提交多个城市。 */
export async function fillBeisenMultiAreaPicker(
  entry: ControlEntry,
  acceptable: string[],
  overwrite: boolean,
): Promise<ControlResult> {
  const input = entry.primary as HTMLInputElement;
  const desired = uniqueAreaValues(acceptable.map((value) => normalizeLabel(value)).filter(Boolean));
  if (desired.length === 0) return failResult('AMBIGUOUS_OPTION', '履历中的意向城市列表为空');

  const current = readBeisenMultiAreaValues(input);
  const contains = (values: string[], target: string) => values.some((value) => areaValuesEqual(value, target));
  if (desired.every((target) => contains(current, target))) {
    return okResult('VALUE_ALREADY_EQUAL', '网页上已经包含全部意向城市');
  }
  const unrelated = current.filter((value) => !desired.some((target) => areaValuesEqual(value, target)));
  if (unrelated.length > 0 && !overwrite) {
    return failResult('EXISTING_VALUE', '网页已有履历以外的意向城市，已保留原值');
  }

  input.focus({ preventScroll: true });
  input.click();
  const opened = await waitFor(() => visibleAreaPicker(input.ownerDocument) !== null, OPEN_TIMEOUT_MS);
  let picker = visibleAreaPicker(input.ownerDocument);
  if (!opened || !picker) return failResult('TIMEOUT', '多选地区选择器没有在 2 秒内打开');

  const capacityMatch = /(\d+)\s*\/\s*(\d+)/.exec(normalizeLabel(picker.textContent ?? ''));
  const capacity = capacityMatch ? Number(capacityMatch[2]) : Number.POSITIVE_INFINITY;
  if (Number.isFinite(capacity) && desired.length > capacity) {
    await cancel(picker);
    return failResult('AMBIGUOUS_OPTION', `网页最多允许选择 ${capacity} 个城市，履历中有 ${desired.length} 个`);
  }

  for (const target of desired) {
    picker = visibleAreaPicker(input.ownerDocument);
    if (!picker) return failResult('STALE_PAGE', '选择意向城市时弹层结构已变化');
    if (selectedAreaLabels(picker).some((value) => areaValuesEqual(value, target))) continue;

    let selectedTarget: string | null = null;
    let matches: HTMLElement[] = [];
    for (const searchChoice of areaSearchChoices(target)) {
      picker = visibleAreaPicker(input.ownerDocument);
      if (!picker) return failResult('STALE_PAGE', '搜索意向城市时弹层结构已变化');
      const searchInputs = [...picker.querySelectorAll<HTMLInputElement>('input[placeholder="搜索"]')]
        .filter(isVisible)
        .filter((candidate) => !candidate.disabled && !candidate.readOnly);
      if (searchInputs.length !== 1) {
        await cancel(picker);
        return failResult('AMBIGUOUS_OPTION', '无法唯一定位多选地区搜索框');
      }
      setNativeValue(searchInputs[0]!, areaKey(searchChoice));
      dispatchInputEvents(searchInputs[0]!);
      const found = await waitFor(() => {
        const currentPicker = visibleAreaPicker(input.ownerDocument);
        return currentPicker !== null && matchingAreaItems(currentPicker, [searchChoice]).length > 0;
      }, SEARCH_TIMEOUT_MS);
      picker = visibleAreaPicker(input.ownerDocument);
      matches = picker ? matchingAreaItems(picker, [searchChoice]) : [];
      if (found && matches.length > 0) {
        selectedTarget = searchChoice;
        break;
      }
    }
    if (!picker || !selectedTarget || matches.length === 0) {
      if (picker) await cancel(picker);
      return failResult('AMBIGUOUS_OPTION', `地区搜索中没有“${target}”对应的城市选项，需要手动选择`);
    }
    if (matches.length !== 1) {
      await cancel(picker);
      return failResult('AMBIGUOUS_OPTION', `“${target}”搜索到 ${matches.length} 个对应项，需要手动选择`);
    }

    const optionLabel = normalizeLabel(matches[0]!.querySelector('.area-text-label')?.textContent ?? '');
    const icons = [...matches[0]!.querySelectorAll<HTMLElement>('.icon-container')].filter(isVisible);
    if (icons.length !== 1) {
      await cancel(picker);
      return failResult('UNSUPPORTED_WIDGET', '多选地区选项缺少唯一的复选按钮');
    }
    try {
      clickAreaIcon(matches[0]!, true);
    } catch {
      await cancel(picker);
      return failResult('UNSUPPORTED_WIDGET', '多选地区选项缺少可操作的复选按钮');
    }
    const selected = await waitFor(() => {
      const currentPicker = visibleAreaPicker(input.ownerDocument);
      return currentPicker !== null && selectedAreaLabels(currentPicker).some((value) => areaValuesEqual(value, optionLabel));
    }, COMMIT_TIMEOUT_MS);
    if (!selected) {
      const currentPicker = visibleAreaPicker(input.ownerDocument);
      if (currentPicker) await cancel(currentPicker);
      return failResult('VALIDATION_FAILED', `“${optionLabel}”没有进入已选城市列表`);
    }
  }

  picker = visibleAreaPicker(input.ownerDocument);
  if (!picker) return failResult('STALE_PAGE', '确认意向城市前弹层结构已变化');
  const confirmButtons = exactLeaf(picker, '.phoenix-button__content', '确定');
  if (confirmButtons.length !== 1) {
    await cancel(picker);
    return failResult('AMBIGUOUS_OPTION', '无法唯一定位多选地区确认按钮');
  }
  confirmButtons[0]!.click();
  const closed = await waitFor(() => visibleAreaPicker(input.ownerDocument) === null, COMMIT_TIMEOUT_MS);
  await nextFrames(2);
  await delay(60);
  if (!closed) {
    await cancel(picker);
    return failResult('TIMEOUT', '确认意向城市后弹窗没有关闭');
  }
  if (!input.isConnected) return failResult('STALE_PAGE', '选择意向城市后网页替换了节点');
  const after = readBeisenMultiAreaValues(input);
  if (!desired.every((target) => contains(after, target))) {
    return failResult('VALIDATION_FAILED', '确认意向城市后网页没有回显全部目标城市');
  }
  return okResult('FILLED_VERIFIED', '');
}

/** 飞书招聘的可搜索树形地区下拉。搜索后只接受唯一的城市/区县精确结果。 */
function visibleFeishuAreaPopup(entry: ControlEntry): HTMLElement | null {
  const explicit = entry.getSelectPopup?.();
  if (explicit && isVisible(explicit) && explicit.querySelector('.atsx-tree')) return explicit as HTMLElement;
  const matches = [...entry.primary.ownerDocument.querySelectorAll<HTMLElement>('.atsx-select-dropdown')]
    .filter(isVisible)
    .filter((popup) => popup.querySelector('.atsx-tree'));
  return matches.length === 1 ? matches[0]! : null;
}

function feishuAreaMatches(root: Element, target: string): HTMLElement[] {
  const matches = [...root.querySelectorAll<HTMLElement>('[data-cy-value]')]
    .filter(isVisible)
    .filter((item) => areaValuesEqual(item.getAttribute('data-cy-value') ?? item.textContent ?? '', target));
  const unique = new Map<string, HTMLElement>();
  for (const item of matches) {
    const value = normalizeLabel(item.getAttribute('data-cy-value') ?? item.textContent ?? '');
    if (value && !unique.has(value)) unique.set(value, item);
  }
  return [...unique.values()];
}

async function closeFeishuAreaPicker(entry: ControlEntry): Promise<void> {
  entry.primary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  entry.primary.ownerDocument.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await nextFrames(1);
}

export async function fillFeishuAreaPicker(
  entry: ControlEntry,
  acceptable: string[],
  overwrite: boolean,
): Promise<ControlResult> {
  const current = readCurrentValue(entry).trim();
  const choices = acceptable.flatMap(areaSearchChoices);
  if (choices.some((candidate) => areaValuesEqual(current, candidate))) {
    return okResult('VALUE_ALREADY_EQUAL', '网页上已经是这个地区');
  }
  if (current && !overwrite) return failResult('EXISTING_VALUE', '网页已有不同地区，已保留原值');
  if (choices.length === 0) return failResult('AMBIGUOUS_OPTION', '履历中的地区无法用于搜索');

  const selection = entry.primary.matches('[role="combobox"]')
    ? entry.primary
    : entry.primary.closest<HTMLElement>('[role="combobox"]') ?? entry.primary;
  selection.focus({ preventScroll: true });
  selection.click();
  const opened = await waitFor(() => visibleFeishuAreaPopup(entry) !== null, OPEN_TIMEOUT_MS);
  let popup = visibleFeishuAreaPopup(entry);
  if (!opened || !popup) return failResult('TIMEOUT', '地区树没有在 2 秒内打开');

  const selectRoot = entry.primary.closest('.atsx-select');
  const searchInputs = [...(selectRoot?.querySelectorAll<HTMLInputElement>('.atsx-select-search__field') ?? [])]
    .filter(isVisible)
    .filter((input) => !input.disabled && !input.readOnly);
  if (searchInputs.length !== 1) {
    await closeFeishuAreaPicker(entry);
    return failResult('AMBIGUOUS_OPTION', '无法唯一定位地区搜索框');
  }

  let target: HTMLElement | null = null;
  let expected = '';
  for (const choice of choices) {
    setNativeValue(searchInputs[0]!, areaKey(choice));
    dispatchInputEvents(searchInputs[0]!);
    const found = await waitFor(() => {
      const currentPopup = visibleFeishuAreaPopup(entry);
      return currentPopup !== null && feishuAreaMatches(currentPopup, choice).length > 0;
    }, SEARCH_TIMEOUT_MS);
    popup = visibleFeishuAreaPopup(entry);
    const matches = popup ? feishuAreaMatches(popup, choice) : [];
    if (!found || matches.length === 0) continue;
    if (matches.length > 1) {
      await closeFeishuAreaPicker(entry);
      return failResult('AMBIGUOUS_OPTION', `地区搜索中有 ${matches.length} 个对应项，需要手动选择`);
    }
    target = matches[0]!;
    expected = normalizeLabel(target.getAttribute('data-cy-value') ?? target.textContent ?? '');
    break;
  }
  if (!target) {
    await closeFeishuAreaPicker(entry);
    return failResult('AMBIGUOUS_OPTION', '地区搜索中没有对应的区县或城市选项，需要手动选择');
  }

  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  target.click();
  const committed = await waitFor(() => areaValuesEqual(readCurrentValue(entry), expected), COMMIT_TIMEOUT_MS);
  await nextFrames(2);
  await delay(60);
  if (!committed) {
    await closeFeishuAreaPicker(entry);
    return failResult('VALIDATION_FAILED', '选择地区后网页没有回显目标值');
  }
  return okResult('FILLED_VERIFIED', '');
}
