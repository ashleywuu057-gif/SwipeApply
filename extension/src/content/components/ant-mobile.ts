import { normalizeLabel, normalizeText } from '../../shared/normalize';
import { delay, isVisible, nextFrames, waitFor } from '../dom-utils';
import type { ControlEntry } from '../scanner';
import { failResult, okResult, type ControlResult } from '../verify';
import { areaValuesEqual } from '../controls/area-picker';
import type { ComponentDriver } from './types';

/** Ant Design Mobile 2.x List.Item + Picker。只使用公开 DOM 和事件，不访问 React 私有状态。 */
const POPUP = '.am-picker-popup';
const COLUMN = '.am-picker-col';
const ITEM = '.am-picker-col-item';
const SELECTED = '.am-picker-col-item-selected';
const DATE_LABEL = /(?:出生日期|生日|入学日期|毕业日期|开始时间|结束时间|获奖时间|发表时间|获取日期)$/;
const AREA_LABEL = /(?:城市|现居地|现居住地|籍贯)$/;
const key = (value: string) => normalizeLabel(value).toLowerCase();

function readValue(element: HTMLElement): string {
  const value = normalizeText(element.querySelector('.am-list-extra')?.textContent ?? '');
  return /^(?:请选择|选择|please select)$/i.test(value) ? '' : value;
}

function isDisabled(element: HTMLElement): boolean {
  // 有些包装器把 disabled 放在 List.Item 的直属父容器上（CSS Modules 后缀也允许）。
  return getComputedStyle(element).pointerEvents === 'none' || [element, element.parentElement].some((node) => node && (
    node.getAttribute('aria-disabled') === 'true' ||
    [...node.classList].some((name) => /^(?:am-list-item-disabled|disabled(?:___.*)?)$/.test(name))
  ));
}

function popups(document: Document): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(POPUP)].filter(isVisible);
}

function headerButton(popup: HTMLElement, text: '确定' | '取消'): HTMLElement | null {
  const buttons = [...popup.querySelectorAll<HTMLElement>('.am-picker-popup-header .am-picker-popup-item')]
    .filter(isVisible).filter((node) => key(node.textContent ?? '') === text);
  return buttons.length === 1 ? buttons[0]! : null;
}

function columns(popup: HTMLElement): HTMLElement[] {
  return [...popup.querySelectorAll<HTMLElement>(COLUMN)].filter(isVisible);
}

function options(column: HTMLElement): HTMLElement[] {
  // 滚轮在裁切区外的选项仍在 DOM 中；不得用 viewport 可见性过滤它们。
  return [...column.querySelectorAll<HTMLElement>(`:scope > .am-picker-col-content > ${ITEM}`)];
}

/** 用滚轮实际监听的鼠标拖动链路选值，等待惯性停止并校验 selected 状态。 */
async function choose(column: HTMLElement, target: HTMLElement): Promise<boolean> {
  const selected = [...column.querySelectorAll<HTMLElement>(SELECTED)];
  if (selected.length !== 1) return false;
  if (selected[0] === target) return true;
  const items = options(column);
  const index = items.indexOf(target);
  const current = items.indexOf(selected[0]!);
  const height = column.querySelector('.am-picker-col-indicator')?.getBoundingClientRect().height ?? 0;
  if (index < 0 || current < 0 || height <= 0 || items.length > 500 ||
      Math.abs(target.getBoundingClientRect().height - height) > 1 ||
      target.getAttribute('aria-disabled') === 'true' || target.classList.contains('am-picker-col-item-disabled')) return false;
  const start = column.getBoundingClientRect().top + height * 2;
  // rc-picker 只有发生“吸附到整格”的动画才调用 scrollingComplete。
  // 保留小于半格的余量，松手后吸附到目标；恰好拖到整格反而可能不提交 onChange。
  const end = start - ((index - current) + 0.125) * height;
  const mouse = (type: string, y: number) => column.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, clientY: y, buttons: type === 'mouseup' ? 0 : 1,
  }));
  mouse('mousedown', start);
  mouse('mousemove', end);
  // rc-picker 的速度采样窗为 100ms。停顿并重复位置，防止松手后惯性越过目标。
  await delay(130);
  mouse('mousemove', end);
  mouse('mouseup', end);
  return waitFor(() => column.isConnected &&
    [...column.querySelectorAll(SELECTED)].length === 1 && target.classList.contains('am-picker-col-item-selected'), 1_200);
}

function dateParts(value: string): string[] | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return [String(year), String(month), String(day)];
}

async function fill(entry: ControlEntry, values: string[], overwrite: boolean): Promise<ControlResult> {
  const element = entry.primary;
  const date = entry.kind === 'date-picker';
  const parts = date && /^\d{4}-\d{2}-\d{2}$/.test(values[0] ?? '') ? dateParts(values[0]!) : null;
  if (date && !parts) return failResult('PRECISION_MISMATCH', '日期滚轮需要完整年月日，不能替资料补日');
  const same = (actual: string, expected: string) => date
    ? dateParts(normalizeLabel(actual).replace(/年|月|\//g, '-').replace(/日$/, ''))?.join('-') === dateParts(expected)?.join('-')
    : AREA_LABEL.test(entry.descriptor.normalizedLabel) ? areaValuesEqual(actual, expected) : key(actual) === key(expected);
  const current = readValue(element);
  if (current && values.some((value) => same(current, value))) return okResult('VALUE_ALREADY_EQUAL', '网页已经是这个值');
  if (current && !overwrite) return failResult('EXISTING_VALUE', '网页已有不同内容，已保留原值');
  if (isDisabled(element)) return failResult('REQUIRES_USER_ACTION', '网站禁用了这个选择器');
  // 只接管本次操作新打开的唯一弹层，绝不操作用户已经打开的滚轮/弹窗。
  if (popups(element.ownerDocument).length ||
      [...element.ownerDocument.querySelectorAll('[role="dialog"], .am-modal')].some(isVisible)) {
    return failResult('REQUIRES_USER_ACTION', '请先关闭当前弹窗，再填写选择器');
  }
  element.click();
  await waitFor(() => popups(element.ownerDocument).length > 0, 1_000);
  const opened = popups(element.ownerDocument);
  if (opened.length !== 1) return failResult('UNSUPPORTED_WIDGET', '没有出现唯一可验证的 Ant Mobile 滚轮，请手动选择');
  const popup = opened[0]!;
  try {
    if (!headerButton(popup, '确定') || !headerButton(popup, '取消')) {
      return failResult('UNSUPPORTED_WIDGET', '滚轮缺少明确的确认或取消按钮');
    }
    const count = date ? 3 : 1;
    if (columns(popup).length !== count) {
      return failResult('UNSUPPORTED_WIDGET', date ? '日期滚轮不是可验证的年、月、日三列' : '多列联动选择器需要手动处理');
    }
    let selectedText = '';
    for (let index = 0; index < count; index += 1) {
      const column = columns(popup)[index];
      if (!column || columns(popup).length !== count) return failResult('STALE_PAGE', '滚轮列结构发生了变化');
      const unit = ['年', '月', '日'][index]!;
      const matches = options(column).filter((option) => {
        if (option.getAttribute('aria-disabled') === 'true' || option.classList.contains('am-picker-col-item-disabled')) return false;
        const text = key(option.textContent ?? '');
        return date ? text === `${parts![index]}${unit}` || text === `${parts![index]!.padStart(2, '0')}${unit}`
          : values.some((value) => same(text, value));
      });
      if (matches.length !== 1) return failResult('AMBIGUOUS_OPTION', '滚轮中没有唯一对应选项，需要手动选择');
      selectedText = normalizeText(matches[0]!.textContent ?? '');
      if (!await choose(column, matches[0]!)) return failResult('VALIDATION_FAILED', '滚轮没有停在目标选项，已取消');
    }
    // 后一列变化可能重建或重置前一列；提交前再次逐列核对。
    const finalColumns = columns(popup);
    if (finalColumns.length !== count || finalColumns.some((column, index) => {
      const selected = [...column.querySelectorAll(SELECTED)];
      if (selected.length !== 1) return true;
      const text = key(selected[0]!.textContent ?? '');
      return date ? ![`${parts![index]}${['年', '月', '日'][index]}`, `${parts![index]!.padStart(2, '0')}${['年', '月', '日'][index]}`].includes(text)
        : !same(text, selectedText);
    })) return failResult('VALIDATION_FAILED', '滚轮联动改变了已选值，已取消');
    const confirm = headerButton(popup, '确定');
    if (!confirm || !element.isConnected || popups(element.ownerDocument).length !== 1) {
      return failResult('STALE_PAGE', '提交前选择器结构发生变化');
    }
    if (readValue(element) !== current || isDisabled(element)) {
      return failResult('EXISTING_VALUE', '选择期间原字段被修改或锁定，已取消本次选择');
    }
    confirm.click();
    const closed = await waitFor(() => !isVisible(popup), 1_000);
    await nextFrames(2);
    if (!element.isConnected) return failResult('STALE_PAGE', '选择后网页替换了字段');
    if (!closed || !same(readValue(element), date ? values[0]! : selectedText)) {
      return failResult('VALIDATION_FAILED', '确认后网页没有回显目标值');
    }
    return okResult();
  } finally {
    if (isVisible(popup)) {
      headerButton(popup, '取消')?.click();
      await waitFor(() => !isVisible(popup), 500);
    }
  }
}

export const antMobileDriver: ComponentDriver = {
  discover: (root) => [...root.querySelectorAll<HTMLElement>('.am-list-item')],
  resolve(element) {
    if (!element.matches('.am-list-item') || element.closest('a[href], nav, [role="dialog"], .am-modal') ||
        element.querySelector('input, textarea, select, [role="combobox"]') ||
        !element.querySelector('.am-list-arrow-horizontal') || !element.querySelector('.am-list-extra')) return null;
    const label = normalizeText(element.querySelector('.am-list-content')?.textContent ?? '');
    if (!label || label.length > 60) return null;
    const date = DATE_LABEL.test(normalizeLabel(label));
    return { id: 'ant-mobile-v2-picker', kind: date ? 'date-picker' : 'combobox', label,
      datePrecision: date ? 'day' : undefined, readValue, isDisabled, fill };
  },
};
