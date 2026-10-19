import { collapseWhitespace, normalizeLabel } from '../../shared/normalize';
import {
  delay, dispatchInputEvents, isVisible, nextFrames, selectContainersOf, setNativeValue, waitFor,
} from '../dom-utils';
import { areaValuesEqual } from './area-picker';
import type { ControlEntry } from '../scanner';
import { failResult, okResult, readCurrentValue, type ControlResult } from '../verify';

/**
 * 自定义下拉（没有任何 ARIA 关系的那种，例如 Moka / 多数国内 ATS）。
 *
 * 做法与 ARIA combobox 完全一致，只是列表要靠结构而不是 aria-controls 找到：
 * 点开 → 等待选项出现在**这个控件自己的容器内** → 精确唯一匹配 → 点击 → 回读确认。
 *
 * 三条硬约束：
 * 1. 只在控件自己的下拉容器里找选项，绝不全页搜索。
 * 2. 只接受唯一的精确匹配；找不到或有歧义就原样退出并报告。
 * 3. 退出前把控件恢复原状（清掉为了过滤而输入的文字），不给页面留垃圾。
 */

const OPEN_TIMEOUT_MS = 500;
const FILTER_TIMEOUT_MS = 2500;
/**
 * 选项元素：优先语义 option，其次常见 option 类名；Moka 的年份菜单只有
 * `sd-Menu-content-item-*` 包装，没有 option 类名，也纳入同一控件容器内的严格查找。
 */
const OPTION_SELECTOR = [
  '[role="option"]',
  '[class*="Menu-content-item"]',
  '[class*="menu-content-item"]',
  '.phoenix-selectList__listItem',
  '[class*="auto-complete"][class*="item"]',
  // 新版飞书（ud-formily）的下拉 / 搜索候选，没有 role=option
  '.ud__select__list__item',
].join(', ');
const FALLBACK_OPTION_SELECTOR = '[class*="option"], [class*="Option"]';
/** 日历单元格等结构不能当作选项。 */
const CALENDAR_HINT = /(calendar|datepicker|day|week|month-cell)/i;

/** Moka 的学校/专业候选把副标题也放在整行里，匹配时只读主标题。 */
function optionText(option: HTMLElement): string {
  const explicit = option.querySelector<HTMLElement>([
    '[class*="option-label"]',
    '[class*="Option-label"]',
    '.phoenix-selectList__singleLabel',
    '[class*="auto-complete"][class*="label"]',
    '.ud__select__list__item__content',
  ].join(', '));
  const explicitText = collapseWhitespace(explicit?.textContent ?? '');
  if (explicitText) return explicitText;
  const first = option.firstElementChild;
  const firstText = collapseWhitespace(first?.textContent ?? '');
  return firstText || collapseWhitespace(option.textContent ?? '');
}

function optionsIn(container: Element): HTMLElement[] {
  const structural = [...container.querySelectorAll<HTMLElement>(OPTION_SELECTOR)];
  const candidates = structural.length > 0
    ? structural
    : [...container.querySelectorAll<HTMLElement>(FALLBACK_OPTION_SELECTOR)]
      .filter((option) => option.querySelector(FALLBACK_OPTION_SELECTOR) === null);
  return candidates
    .filter((option) => option.getAttribute('aria-disabled') !== 'true')
    .filter((option) => !CALENDAR_HINT.test(String(option.className || '')))
    .filter((option) => isVisible(option))
    .filter((option) => {
      const text = optionText(option);
      return text.length > 0 && text.length <= 60;
    });
}

function matchOptions(
  options: HTMLElement[],
  acceptable: string[],
  administrativeArea: boolean,
): HTMLElement[] {
  const wanted = new Set(acceptable.map((item) => normalizeLabel(item).toLowerCase()).filter(Boolean));
  const hits = options.filter((option) => {
    const text = optionText(option);
    const normalized = normalizeLabel(text).toLowerCase();
    return wanted.has(normalized) ||
      (administrativeArea && acceptable.some((candidate) => areaValuesEqual(text, candidate)));
  });
  // 同一个文本可能有嵌套包装，按文本去重。
  const byText = new Map<string, HTMLElement>();
  for (const hit of hits) {
    const key = normalizeLabel(optionText(hit)).toLowerCase();
    if (!byText.has(key)) byText.set(key, hit);
  }
  return [...byText.values()];
}

function visibleButtons(containers: Element[], label: string): HTMLButtonElement[] {
  const wanted = normalizeLabel(label).toLowerCase();
  const seen = new Set<HTMLButtonElement>();
  const buttons: HTMLButtonElement[] = [];
  for (const container of containers) {
    for (const button of container.querySelectorAll<HTMLButtonElement>('button[type="button"]')) {
      if (seen.has(button) || !isVisible(button) || button.disabled) continue;
      if (normalizeLabel(button.textContent ?? '').toLowerCase() !== wanted) continue;
      seen.add(button);
      buttons.push(button);
    }
  }
  return buttons;
}

function dispatchEscape(target: HTMLElement): void {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
  });
  // 旧版 rc-select 仍读取 keyCode/which，而构造出的 KeyboardEvent 默认都是 0。
  Object.defineProperty(event, 'keyCode', { value: 27 });
  Object.defineProperty(event, 'which', { value: 27 });
  target.dispatchEvent(event);
}

/** Moka 未收录学校/专业时的明确两步流程：「添加…全称」→ 输入全称 →「添加」。 */
async function commitMokaFreeText(
  entry: ControlEntry,
  containers: Element[],
  value: string,
): Promise<ControlResult | null> {
  if (!entry.customSelectFallback) return null;
  const isSchool = entry.customSelectFallback === 'moka-school';
  const firstLabel = isSchool ? '添加学校全称' : '添加专业全称';
  const inputPlaceholder = isSchool ? '请输入就读学校全称' : '请输入专业全称';
  const firstButtons = visibleButtons(containers, firstLabel);
  if (firstButtons.length !== 1) return null;

  firstButtons[0]!.click();
  const customInputReady = await waitFor(
    () => containers.some((container) => [...container.querySelectorAll<HTMLInputElement>('input')]
      .some((input) => isVisible(input) && normalizeLabel(input.placeholder) === inputPlaceholder)),
    FILTER_TIMEOUT_MS,
  );
  if (!customInputReady) return failResult('TIMEOUT', `点击“${firstLabel}”后没有出现全称输入框`);

  const customInputs = containers.flatMap((container) => [...container.querySelectorAll<HTMLInputElement>('input')])
    .filter((input) => isVisible(input) && normalizeLabel(input.placeholder) === inputPlaceholder);
  if (customInputs.length !== 1) return failResult('AMBIGUOUS_OPTION', '无法唯一定位全称输入框');
  const customInput = customInputs[0]!;
  setNativeValue(customInput, value);
  dispatchInputEvents(customInput);
  await nextFrames(1);

  const commitButtons = visibleButtons(containers, '添加');
  if (commitButtons.length !== 1) return failResult('AMBIGUOUS_OPTION', '无法唯一定位全称确认按钮');
  commitButtons[0]!.click();
  await nextFrames(2);
  await delay(120);

  if (!entry.primary.isConnected) return failResult('STALE_PAGE', '添加全称后网页替换了节点');
  const after = normalizeLabel(readCurrentValue(entry)).toLowerCase();
  if (after !== normalizeLabel(value).toLowerCase()) {
    return failResult('VALIDATION_FAILED', '添加全称后网页没有保留该值');
  }
  return okResult('FILLED_VERIFIED', '已通过网页的全称添加入口确认');
}

export async function fillCustomSelect(
  entry: ControlEntry,
  acceptable: string[],
  overwrite: boolean,
): Promise<ControlResult> {
  if (!(entry.primary instanceof HTMLInputElement)) {
    return failResult('UNSUPPORTED_WIDGET', '这个自定义下拉没有可搜索的输入框');
  }
  const element = entry.primary;
  const original = readCurrentValue(entry);
  const originalInputValue = element.value;
  const wanted = new Set(acceptable.map((item) => normalizeLabel(item).toLowerCase()).filter(Boolean));
  const administrativeArea = /(?:城市|地点|现居|籍贯)/.test(entry.descriptor.normalizedLabel);
  if (wanted.size === 0) {
    return failResult('AMBIGUOUS_OPTION', '履历中的值无法对应到这个控件的选项');
  }

  if (wanted.has(normalizeLabel(original).toLowerCase()) ||
      (administrativeArea && acceptable.some((candidate) => areaValuesEqual(original, candidate)))) {
    return okResult('VALUE_ALREADY_EQUAL', '网页上已经是这个选项');
  }
  if (original.trim().length > 0 && !overwrite) {
    return failResult('EXISTING_VALUE', '网页已有不同选项，已保留原值');
  }

  const localContainers = selectContainersOf(element);
  if (localContainers.length === 0 && !entry.getSelectPopup) {
    return failResult('UNSUPPORTED_WIDGET', '找不到这个下拉自己的容器，需要手动选择');
  }
  const activeContainers = (): Element[] => {
    const popup = entry.getSelectPopup?.() ?? null;
    return popup ? [...localContainers, popup] : localContainers;
  };
  /** 展开后，取由近及远第一个真正含有选项的容器。 */
  const currentOptions = (): HTMLElement[] => {
    for (const container of activeContainers()) {
      const options = optionsIn(container);
      if (options.length > 0) return options;
    }
    return [];
  };

  /** 恢复原状：清掉过滤文字并关闭菜单。 */
  const restore = async () => {
    if (element.value !== originalInputValue) {
      setNativeValue(element, originalInputValue);
      dispatchInputEvents(element);
    }
    dispatchEscape(element);
    element.ownerDocument.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await nextFrames(1);
  };

  element.focus({ preventScroll: true });
  // 新版飞书（ud-formily）的下拉在 mousedown 时展开，只发 click 打不开
  const udSelector = element.closest('.ud__select')?.querySelector<HTMLElement>('.ud__select__selector');
  if (udSelector) udSelector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  element.click();
  // 普通菜单通常立即出现；可搜索的远程菜单可能要先输入关键字。
  // 不在空菜单上白等 2 秒，尽早进入过滤流程。
  await waitFor(() => currentOptions().length > 0, OPEN_TIMEOUT_MS);

  let matched = matchOptions(currentOptions(), acceptable, administrativeArea);

  // 可搜索下拉：选项要先输入关键字才出现。输入的是我们要选的值本身，不是别的内容。
  if (matched.length === 0 && !element.readOnly && !element.disabled) {
    const keyword = acceptable[0] ?? '';
    if (keyword) {
      setNativeValue(element, keyword);
      dispatchInputEvents(element);
      await waitFor(
        () => matchOptions(currentOptions(), acceptable, administrativeArea).length > 0,
        FILTER_TIMEOUT_MS,
      );
      matched = matchOptions(currentOptions(), acceptable, administrativeArea);
    }
  }

  if (matched.length === 0) {
    const fallback = await commitMokaFreeText(entry, activeContainers(), acceptable[0] ?? '');
    if (fallback) return fallback;
    await restore();
    return failResult('AMBIGUOUS_OPTION', '下拉里没有完全对应的选项，需要手动选择');
  }
  if (matched.length > 1) {
    await restore();
    return failResult('AMBIGUOUS_OPTION', `有 ${matched.length} 个选项都能对应，需要手动选择`);
  }

  const target = matched[0]!;
  const expected = optionText(target);
  // 很多自定义下拉在 mousedown 就完成选择，两个事件都发出去更稳。
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  target.click();
  await nextFrames(2);
  await delay(60);

  if (!element.isConnected) {
    return failResult('STALE_PAGE', '写入后网页替换了这个节点，无法确认结果');
  }
  let after = normalizeLabel(readCurrentValue(entry)).toLowerCase();
  const selected = after === normalizeLabel(expected).toLowerCase() ||
    (administrativeArea && acceptable.some((candidate) => areaValuesEqual(after, candidate)));
  if (!selected) {
    await restore();
    return failResult('VALIDATION_FAILED', '点击选项后网页没有回显该值');
  }

  // 飞书多选选择成功后会继续保持搜索菜单展开。主动失焦并关闭，避免菜单
  // 遮住后续控件，也让回读从搜索关键字切换到已选项的真实文案。
  dispatchEscape(element);
  if (element.ownerDocument.activeElement instanceof HTMLElement &&
      element.ownerDocument.activeElement !== element) {
    dispatchEscape(element.ownerDocument.activeElement);
  }
  element.blur();
  const outside = element.ownerDocument.querySelector<HTMLElement>('.resumeEditForm-header, .createFormSection-title')
    ?? element.ownerDocument.body;
  outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  outside.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  outside.click();
  await nextFrames(1);
  await delay(40);
  after = normalizeLabel(readCurrentValue(entry)).toLowerCase();
  if (after !== normalizeLabel(expected).toLowerCase() &&
      !(administrativeArea && acceptable.some((candidate) => areaValuesEqual(after, candidate)))) {
    return failResult('VALIDATION_FAILED', '关闭下拉后网页没有保留已选项');
  }
  return okResult('FILLED_VERIFIED', '');
}
