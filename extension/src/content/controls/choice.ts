import { choiceOptionValue, dispatchInputEvents, nextFrames } from '../dom-utils';
import type { ControlEntry } from '../scanner';
import { failResult, okResult, readCurrentValue, verifyWrite, type ControlResult } from '../verify';

/** radio：只在组内选择唯一等价选项，不触发组外选项。 */
export async function fillRadio(entry: ControlEntry, optionValue: string, overwrite: boolean): Promise<ControlResult> {
  const radios = entry.elements;
  const current = readCurrentValue(entry);
  if (current === optionValue) return okResult('VALUE_ALREADY_EQUAL', '网页上已经是这个选项');
  if (current.trim().length > 0 && !overwrite) {
    return failResult('EXISTING_VALUE', '网页已选择了不同选项，已保留原值');
  }

  const matches = radios.filter((radio) => choiceOptionValue(radio) === optionValue &&
    (!(radio instanceof HTMLInputElement) || !radio.disabled));
  if (matches.length !== 1) {
    return failResult('AMBIGUOUS_OPTION', `组内有 ${matches.length} 个匹配项，无法确定`);
  }
  const target = matches[0]!;
  if (target instanceof HTMLInputElement) {
    target.focus({ preventScroll: true });
    target.checked = true;
    dispatchInputEvents(target);
  } else {
    // Phoenix 把选中处理绑在内层可点击节点上。直接对
    // radioItem 外壳调用 click() 不会把事件向内传递。
    // querySelector 对选择器列表按 DOM 顺序返回，不会按选择器的优先级返回；
    // 因此要逐项查找，确保先点真正绑定事件的文字节点。
    const clickTarget = target.querySelector<HTMLElement>('.phoenix-radio__radio-text') ??
      target.querySelector<HTMLElement>('.phoenix-radio__wrapper') ??
      target.querySelector<HTMLElement>('.phoenix-radio') ??
      target;
    clickTarget.click();
  }
  await nextFrames(2);

  return verifyWrite(entry, { expected: optionValue, compare: 'value' });
}

/** 普通 checkbox：只在布尔含义明确时执行；声明类在扫描阶段已排除。 */
export async function fillCheckbox(entry: ControlEntry, checked: boolean, overwrite: boolean): Promise<ControlResult> {
  const box = entry.primary as HTMLInputElement;
  if (box.checked === checked) return okResult('VALUE_ALREADY_EQUAL', '勾选状态已经一致');
  if (box.checked && !overwrite) return failResult('EXISTING_VALUE', '网页已勾选，未改动');

  box.focus({ preventScroll: true });
  // Phoenix 把事件绑在可见的方框外壳，真实 input 只是透明状态载体。
  // 普通原生 checkbox 没有这个外壳，仍直接点击 input。
  const phoenix = box.closest<HTMLElement>('.phoenix-checkbox');
  const clickTarget = phoenix?.querySelector<HTMLElement>('.phoenix-checkbox__box') ?? box;
  clickTarget.click();
  if (box.checked !== checked) {
    box.checked = checked;
    dispatchInputEvents(box);
  }
  await nextFrames(2);

  return verifyWrite(entry, { expected: checked, compare: 'checked' });
}
