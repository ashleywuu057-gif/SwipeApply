import { collapseWhitespace, normalizeLabel, normalizeText } from '../shared/normalize';

/** 内容脚本使用的 DOM 基础工具：可见性、标签解析、事件触发。 */

export const EXTENSION_MARK = 'data-applykit';

export function isOwnElement(element: Element): boolean {
  return element.closest(`[${EXTENSION_MARK}]`) !== null;
}

export function isVisible(element: Element): boolean {
  if (!element.isConnected) return false;
  const html = element as HTMLElement;
  if (typeof html.checkVisibility === 'function') {
    if (!html.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    // 某些原生控件（如视觉隐藏的 radio）仍然可用，检查其标签是否可见。
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const label = findLabelElement(element);
    if (!label) return false;
    const labelRect = label.getBoundingClientRect();
    return labelRect.width > 0 || labelRect.height > 0;
  }
  return true;
}

export function findLabelElement(element: Element): HTMLElement | null {
  const id = element.getAttribute('id');
  if (id) {
    const escaped = cssEscape(id);
    const explicit = element.ownerDocument.querySelector<HTMLElement>(`label[for="${escaped}"]`);
    if (explicit) return explicit;
  }
  const wrapping = element.closest('label');
  return wrapping as HTMLElement | null;
}

export function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

function textOf(element: Element | null): string {
  if (!element) return '';
  const selectDisplay = [
    '[class*="display-value"]',
    '[class*="Display-value"]',
    '[data-select-display]',
    '.phoenix-select__calcEle',
    '.phoenix-select__placeHolder',
    '.phoenix-select__tipEle',
    '.atsx-select-selection-selected-value',
    '.atsx-select-selection__choice',
    '.atsx-select-selection__placeholder',
  ].join(', ');
  if (element.matches(selectDisplay)) return '';
  const clone = element.cloneNode(true) as HTMLElement;
  // 标签内部的控件与说明按钮不计入标签文本。
  clone.querySelectorAll('input, select, textarea, button').forEach((node) => node.remove());
  // 下拉中的已选值是字段内容，不是标签；否则第二轮会把「软件工程」当成字段名。
  clone.querySelectorAll(selectDisplay).forEach((node) => node.remove());
  // 展示用文本保留页面原样（含全角字符），匹配时再单独做 NFKC 归一化。
  return collapseWhitespace(clone.textContent ?? '');
}

export interface LabelResolution {
  raw: string;
  normalized: string;
  source: 'label-for' | 'wrapping-label' | 'aria-labelledby' | 'aria-label' | 'nearby' | 'none';
}

/** 标签解析顺序：label[for] → 包裹 label → aria-labelledby → aria-label → 紧邻可见文本。 */
export function resolveLabel(element: Element): LabelResolution {
  const id = element.getAttribute('id');
  if (id) {
    const explicit = element.ownerDocument.querySelector<HTMLElement>(`label[for="${cssEscape(id)}"]`);
    const text = textOf(explicit);
    if (text) return { raw: text, normalized: normalizeLabel(text), source: 'label-for' };
  }
  const wrapping = element.closest('label');
  if (wrapping) {
    const text = textOf(wrapping);
    if (text) return { raw: text, normalized: normalizeLabel(text), source: 'wrapping-label' };
  }
  // 新版飞书招聘（ud-formily）：输入框包在一个空的 <label class="ud__input-input-wrap"> 里，
  // 真正的标题在同一个 .ud-formily-item 的 .ud-formily-item-label 分支（不含星号）。
  const udItem = element.closest('.ud-formily-item');
  const udLabel = textOf(udItem?.querySelector(':scope > .ud-formily-item-label label') ?? null);
  if (udLabel) return { raw: udLabel, normalized: normalizeLabel(udLabel), source: 'nearby' };
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((token) => element.ownerDocument.getElementById(token))
      .filter((node): node is HTMLElement => node !== null)
      .map((node) => textOf(node));
    const text = collapseWhitespace(parts.join(' '));
    if (text) return { raw: text, normalized: normalizeLabel(text), source: 'aria-labelledby' };
  }
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel && collapseWhitespace(ariaLabel)) {
    return { raw: collapseWhitespace(ariaLabel), normalized: normalizeLabel(ariaLabel), source: 'aria-label' };
  }
  // Phoenix checkbox 的可见文字是 input 所在 box 的兄弟节点，不使用原生 label。
  const phoenixChoiceLabel = textOf(
    element.closest('.phoenix-checkbox')?.querySelector(
      '.phoenix-checkbox__text, .phoenix-checkbox__label',
    ) ?? null,
  );
  if (phoenixChoiceLabel) {
    return { raw: phoenixChoiceLabel, normalized: normalizeLabel(phoenixChoiceLabel), source: 'nearby' };
  }
  // 北森 Phoenix 把标题和控件放在同一个 form-item 的两个分支，层级通常超过
  // 通用向上遍历上限；只读取结构化 title 中的明确文本标签。
  const formItem = element.closest('.form-item');
  const formItemText = textOf(formItem?.querySelector(':scope > .form-item__title .form-item__text') ?? null);
  if (formItemText) {
    return { raw: formItemText, normalized: normalizeLabel(formItemText), source: 'nearby' };
  }
  // 飞书招聘的标题和控件是 atsx-form-item 下的两个直属列。
  const atsxItem = element.closest('.atsx-form-item');
  const atsxItemText = textOf(atsxItem?.querySelector(':scope > .atsx-form-item-label') ?? null);
  if (atsxItemText) {
    return { raw: atsxItemText, normalized: normalizeLabel(atsxItemText), source: 'nearby' };
  }
  const nearby = findNearbyLabelText(element);
  if (nearby) return { raw: nearby, normalized: normalizeLabel(nearby), source: 'nearby' };
  return { raw: '', normalized: '', source: 'none' };
}

const MAX_LABEL_HOPS = 6;
const MAX_LABEL_LENGTH = 30;

/** 元素自身或其内部是否含有表单控件。 */
function containsControl(element: Element): boolean {
  if (isControl(element)) return true;
  return element.querySelector('input, select, textarea, [role="combobox"]') !== null;
}

/**
 * 紧邻的可见标签。
 *
 * 很多国内 ATS（如 Moka）不用 <label for>，而是
 * `<div class="field"><div class="xxx-title">姓名</div><div>…<input></div></div>`，
 * 标签在控件的祖先的兄弟节点上。这里从控件开始逐层向上，在每一层查找**不含任何控件**的
 * 前置兄弟，取最近的一个。跳过含控件的兄弟，保证不会把隔壁字段的文字当成标签。
 */
function findNearbyLabelText(element: Element): string {
  let current: Element | null = element;
  for (let hop = 0; hop < MAX_LABEL_HOPS && current; hop += 1) {
    let previous = current.previousElementSibling;
    while (previous) {
      if (!containsControl(previous) && !isOwnElement(previous)) {
        const text = textOf(previous);
        if (text && text.length <= MAX_LABEL_LENGTH) return text;
      }
      previous = previous.previousElementSibling;
    }
    current = current.parentElement;
  }
  return '';
}

/** 「请选择」这类提示文字，说明这个输入框其实是一个选择器的壳。 */
const SELECT_LIKE_PLACEHOLDER = /^(请选择|请选取|请选|选择|please\s*select|select\b)/i;
/** 容器类名里出现 select / dropdown 等，说明它是自定义下拉。 */
const SELECT_LIKE_CONTAINER = /(^|[-_ ])(select|dropdown|cascader|combobox|auto-?complete)([-_ ]|$)/i;
/** 日期/时间选择器：结构是日历而不是选项列表，不能按下拉处理。 */
const DATE_LIKE_CONTAINER = /(^|[-_ ])(date-?picker|date-?input|calendar|time-?picker|month-?picker|date-?range)([-_ ]|$)/i;
// “到岗时间”“可工作时间”等也常是普通枚举下拉。只有明确的日期词或
// 开始/结束端点才按日期控件处理；日期组件类名仍具有最高优先级。
const DATE_LIKE_TEXT = /(日期|年月|开始时间|结束时间|起始时间|入学时间|毕业时间|获奖时间|发布时间|获得时间|考试时间)/;

export type SelectLikeKind = 'custom-select' | 'date-picker';

/**
 * 判断一个文本输入框其实是自定义下拉或日期选择器的壳。
 *
 * 对这种控件直接写文本，视觉上会变，但网站自己的状态不会更新——那是「假成功」。
 * 自定义下拉可以按「点开 → 精确匹配 → 点击 → 回读」的方式操作；
 * 日期选择器是日历结构，P0 一律交给用户手动处理。
 */
export function classifySelectLikeInput(element: Element, label: string): SelectLikeKind | null {
  const placeholder = (element.getAttribute('placeholder') ?? '').trim();
  let container: Element | null = null;
  let dateContainer = false;
  let node: Element | null = element.parentElement;
  // 北森的学校搜索框在 auto-complete 容器内还包了 input / content /
  // protect / inner / layer 等多层包装。限定在近邻 8 层内查找，避免把普通
  // “请输入”文本框当作自定义下拉直接写入。
  for (let hop = 0; hop < 8 && node; hop += 1) {
    const className = String(node.className || '');
    if (DATE_LIKE_CONTAINER.test(className)) dateContainer = true;
    if (!container && SELECT_LIKE_CONTAINER.test(className)) container = node;
    node = node.parentElement;
  }
  const looksSelectable = container !== null || dateContainer || SELECT_LIKE_PLACEHOLDER.test(placeholder);
  if (!looksSelectable) return null;
  // 标签或容器指向日期，就按日期选择器处理，不去点它的日历。
  if (dateContainer || DATE_LIKE_TEXT.test(label) || DATE_LIKE_TEXT.test(placeholder)) return 'date-picker';
  return 'custom-select';
}

/**
 * 这个下拉可能的容器，由近及远。
 *
 * 菜单不一定渲染在最近的那层：Moka 的输入框在 `label.sd-Select-container` 里，
 * 而菜单挂在它的父级 `div.sd-Dropdown-container` 上。所以返回一条候选链，
 * 由调用方在展开后取第一个真正含有选项的容器——始终限定在这个字段自己的子树内，
 * 不做全页搜索。
 */
export function selectContainersOf(element: Element): Element[] {
  const containers: Element[] = [];
  let node: Element | null = element.parentElement;
  for (let hop = 0; hop < 5 && node; hop += 1) {
    if (SELECT_LIKE_CONTAINER.test(String(node.className || ''))) containers.push(node);
    node = node.parentElement;
  }
  return containers;
}

/**
 * 自定义下拉的已选值。Moka 的 input 在选择后保持空值，真正内容位于相邻的
 * `display-value` 节点；只读取输入框同一个 label 内的可见展示节点。
 */
export function displayedSelectValue(element: Element): string {
  const localRoot = element.closest('.phoenix-select, .atsx-select, .ud__select') ?? element.parentElement;
  // 飞书多选项会在可见文案前放一个序号 tag（例如 DOM 文本是“1上海”）。
  // 优先读取真正的 label，避免把序号误当作字段值并在最终复查时误报失败。
  const atsxChoiceLabels = localRoot?.querySelectorAll<HTMLElement>(
    '.atsx-select-selection__choice .select-item-label',
  ) ?? [];
  for (const label of atsxChoiceLabels) {
    if (!isVisible(label)) continue;
    const value = normalizeText(label.textContent ?? '');
    if (value) return value;
  }
  const displays = localRoot?.querySelectorAll<HTMLElement>(
    '[class*="display-value"], [class*="Display-value"], [data-select-display], .phoenix-select__tipEle, '
      + '.atsx-select-selection-selected-value, .atsx-select-selection__choice, '
      // 新版飞书（ud-formily）：已选项显示在 selector 里的 selectItem 节点
      + '.ud__select__selector__selectItem',
  ) ?? [];
  for (const display of displays) {
    if (!isVisible(display)) continue;
    const value = normalizeText(display.textContent ?? '');
    if (value) return value;
  }
  return '';
}

/** 原生 radio 与 Phoenix 视觉 radio 共用的稳定选项值。 */
export function choiceOptionValue(element: HTMLElement): string {
  if (element instanceof HTMLInputElement) return element.value;
  const explicit = element.querySelector<HTMLElement>('.phoenix-radio__radio-text, [data-choice-label]');
  return normalizeText(explicit?.textContent ?? element.textContent ?? '');
}

export function isChoiceChecked(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement) return element.checked;
  if (element.getAttribute('aria-checked') === 'true') return true;
  const selfAndDescendants = [element, ...element.querySelectorAll<HTMLElement>('*')];
  if (selfAndDescendants.some((node) => {
    const name = String(node.className || '');
    return /(^|\s)(is-)?(checked|selected|active)(\s|$)/i.test(name) ||
      /phoenix-radio--(?:checked|selected)/i.test(name);
  })) return true;
  // 新版 Phoenix 不改 class，仅用 dot 的 opacity 表示已选。未选时实测为 0。
  const dot = element.querySelector<HTMLElement>('.phoenix-radio__dot');
  if (!dot) return false;
  const opacity = Number.parseFloat(getComputedStyle(dot).opacity);
  return Number.isFinite(opacity) && opacity > 0.5;
}

export function isControl(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'select' || tag === 'textarea' || element.getAttribute('role') === 'combobox';
}

/** 分组标签：fieldset/legend 或最近的带标题的分组容器。 */
export function groupLabelFor(element: Element, stopAt: Element | null): string {
  const ownLabel = findLabelElement(element);
  let node: Element | null = element.parentElement;
  let hops = 0;
  while (node && node !== stopAt && hops < 6) {
    if (node.tagName.toLowerCase() === 'fieldset') {
      const legend = node.querySelector(':scope > legend');
      const text = textOf(legend);
      if (text) return text;
    }
    for (const candidate of node.querySelectorAll(':scope > .group-label, :scope > label, :scope > .field-label')) {
      // 跳过控件自己的标签，只取更外层的分组标题。
      if (candidate === ownLabel || candidate.contains(element)) continue;
      const elementId = element.getAttribute('id');
      if (elementId && candidate.getAttribute('for') === elementId) continue;
      const text = textOf(candidate);
      if (text) return text;
    }
    node = node.parentElement;
    hops += 1;
  }
  return '';
}

/** 使用原生 prototype 的 value setter，保证框架能收到状态变化。 */
export function setNativeValue(element: HTMLElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) descriptor.set.call(element, value);
  else (element as unknown as { value: string }).value = value;
}

export function dispatchInputEvents(element: HTMLElement, options: { blur?: boolean } = {}): void {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  if (options.blur) element.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
}

export function nextFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    let remaining = count;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等待条件成立，最长 timeoutMs；用于异步下拉与动态记录。 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  if (predicate()) return true;
  while (Date.now() < deadline) {
    await delay(intervalMs);
    if (predicate()) return true;
  }
  return false;
}

/** 控件当前的可见错误：aria-invalid、原生 validity 或关联的错误文本。 */
export function readValidationError(element: Element): string | null {
  if (element.getAttribute('aria-invalid') === 'true') {
    const describedBy = element.getAttribute('aria-describedby');
    if (describedBy) {
      const message = describedBy
        .split(/\s+/)
        .map((token) => element.ownerDocument.getElementById(token))
        .filter((node): node is HTMLElement => node !== null && isVisible(node))
        .map((node) => collapseWhitespace(node.textContent ?? ''))
        .filter(Boolean)
        .join(' ');
      if (message) return message;
    }
    return '网页把这个字段标记为无效';
  }
  const candidate = element as HTMLInputElement;
  if (typeof candidate.checkValidity === 'function' && !candidate.checkValidity()) {
    return candidate.validationMessage || '未通过网页自身的格式校验';
  }
  return null;
}
