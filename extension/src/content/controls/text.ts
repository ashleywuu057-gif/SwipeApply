import { valuesEqual } from '../../shared/normalize';
import { delay, dispatchInputEvents, nextFrames, setNativeValue } from '../dom-utils';
import type { ControlEntry } from '../scanner';
import { failResult, okResult, readCurrentValue, verifyWrite, type ControlResult } from '../verify';

/** input / textarea：使用原生 value setter，触发冒泡事件，等待渲染后回读。 */
function editAtsxText(element: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  if (!element.closest('.atsx-form-item')) return false;
  try {
    // 飞书 ATSX 的 rc-form 对真实编辑命令产生的 beforeinput/input 链路最稳定。
    // 选择现有内容后一次替换，避免字符级延迟，也不会触碰控件之外的页面状态。
    element.focus({ preventScroll: true });
    element.setSelectionRange(0, element.value.length);
    const inserted = element.ownerDocument.execCommand('insertText', false, value);
    return inserted && element.value === value;
  } catch {
    return false;
  }
}

export async function fillText(entry: ControlEntry, value: string, overwrite: boolean): Promise<ControlResult> {
  const element = entry.primary as HTMLInputElement | HTMLTextAreaElement;
  const current = readCurrentValue(entry);

  if (current.trim().length > 0) {
    if (valuesEqual(current, value)) return okResult('VALUE_ALREADY_EQUAL', '网页上的内容与履历相同');
    if (!overwrite) return failResult('EXISTING_VALUE', '网页已有不同内容，已保留原值');
  }

  const maxLength = element.maxLength;
  if (maxLength > 0 && value.length > maxLength) {
    return failResult('TEXT_TOO_LONG', `内容 ${value.length} 字，超过网页限制的 ${maxLength} 字`);
  }

  element.focus({ preventScroll: true });
  const browserEdited = editAtsxText(element, value);
  if (!browserEdited) {
    setNativeValue(element, value);
    dispatchInputEvents(element, { blur: true });
  } else {
    // execCommand 已派发 input；补 change 让 rc-form 立即提交最终值。
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
  }
  // Moka 的单行 Input 在真实失焦时才把草稿提交进 React 表单状态；
  // 仅派发一个 synthetic blur 事件会出现“回读成功，稍后又消失”。
  element.blur();
  await nextFrames(2);
  await delay(60);

  return verifyWrite(entry, { expected: value, compare: 'text' });
}
