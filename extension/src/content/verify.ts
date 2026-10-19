import { normalizeText, valuesEqual } from '../shared/normalize';
import type { ReasonCode } from '../shared/types';
import { choiceOptionValue, displayedSelectValue, isChoiceChecked, isVisible, readValidationError } from './dom-utils';
import type { ControlEntry } from './scanner';

/** 写入前后的校验。成功必须同时满足：值可读回、节点仍在目标记录内、没有新的错误提示。 */

export interface ControlResult {
  ok: boolean;
  reasonCode: ReasonCode;
  message: string;
}

export const okResult = (reasonCode: ReasonCode = 'FILLED_VERIFIED', message = ''): ControlResult => ({
  ok: true,
  reasonCode,
  message,
});

export const failResult = (reasonCode: ReasonCode, message: string): ControlResult => ({
  ok: false,
  reasonCode,
  message,
});

/** 读取控件当前值，仅用于本次比较，不写入日志。 */
export function readCurrentValue(entry: ControlEntry): string {
  const element = entry.primary;
  if (entry.component?.readValue) return entry.component.readValue(element);
  switch (entry.kind) {
    case 'radio': {
      const checked = entry.elements.find(isChoiceChecked);
      return checked ? choiceOptionValue(checked) : '';
    }
    case 'checkbox':
      return (element as HTMLInputElement).checked ? 'true' : 'false';
    case 'select':
      return (element as HTMLSelectElement).value;
    case 'combobox':
    case 'date-picker':
      if (entry.datePickerKind === 'feishu-period-month') {
        const root = element.closest('.atsx-date-picker-period-month');
        const labels = root?.querySelectorAll<HTMLElement>('.atsx-date-picker-period-month-label') ?? [];
        const index = entry.descriptor.datePart?.edge === 'end' ? 1 : 0;
        const value = normalizeText(labels[index]?.textContent ?? '').replace(/\s+/g, '');
        return /YYYY|MM/i.test(value) ? '' : value;
      }
      if (element instanceof HTMLInputElement) {
        if (element.value.trim()) return element.value;
        return displayedSelectValue(element);
      }
      return displayedSelectValue(element);
    case 'unsupported':
      return '';
    default:
      return (element as HTMLInputElement).value;
  }
}

/** 执行前重验：节点仍连接、可见、可编辑、标签未变。 */
export function revalidateTarget(entry: ControlEntry): ControlResult {
  const element = entry.primary;
  if (!element.isConnected) return failResult('STALE_PAGE', '网页结构已变化，原字段不存在了');
  if (entry.recordRoot && !entry.recordRoot.contains(element)) {
    return failResult('STALE_PAGE', '字段已经不在原来的经历区块中');
  }
  const visibleChoiceLabel = (entry.kind === 'checkbox' || entry.kind === 'radio')
    ? element.closest('label, .phoenix-checkbox')
    : null;
  const visibleDateRoot = entry.kind === 'date-picker'
    ? element.closest('.atsx-date-picker')
    : null;
  if (!isVisible(element) && (!visibleChoiceLabel || !isVisible(visibleChoiceLabel)) &&
      (!visibleDateRoot || !isVisible(visibleDateRoot))) {
    return failResult('STALE_PAGE', '字段当前不可见');
  }
  const input = element as HTMLInputElement;
  if (input.disabled || element.getAttribute('aria-disabled') === 'true' || entry.component?.isDisabled?.(element)) {
    return failResult('REQUIRES_USER_ACTION', '字段已被网页禁用');
  }
  // 新版飞书（ud-formily）的下拉输入框带 readonly 只是"只能点选"，selector 标 disabled 才是真锁定
  const udSelect = entry.kind === 'combobox' ? element.closest('.ud__select') : null;
  const udSelectable = udSelect !== null && !udSelect.querySelector('.ud__select__selector-disabled');
  if (input.readOnly && entry.kind !== 'date-picker' && !udSelectable) return failResult('REQUIRES_USER_ACTION', '字段是只读的');
  return okResult();
}

export interface VerifyOptions {
  expected: string | boolean;
  /** select/radio 比较 option 的 value；文本比较归一化后的字符串。 */
  compare: 'value' | 'text' | 'checked';
}

/** 写入后的回读校验。 */
export function verifyWrite(entry: ControlEntry, options: VerifyOptions): ControlResult {
  if (!entry.primary.isConnected) {
    return failResult('STALE_PAGE', '写入后网页替换了这个节点，无法确认结果');
  }
  const current = readCurrentValue(entry);
  if (options.compare === 'checked') {
    const expected = options.expected === true ? 'true' : 'false';
    if (current !== expected) return failResult('VALIDATION_FAILED', '勾选状态没有变化');
  } else if (options.compare === 'value') {
    if (current !== String(options.expected)) return failResult('VALIDATION_FAILED', '网页没有接受这个选项');
  } else if (!valuesEqual(current, String(options.expected))) {
    return failResult('VALIDATION_FAILED', '写入后读回的内容与目标不一致');
  }

  for (const element of entry.elements) {
    const error = readValidationError(element);
    if (error) return failResult('VALIDATION_FAILED', `网页提示：${error}`);
  }
  return okResult();
}
