import { dispatchInputEvents, nextFrames } from '../dom-utils';
import type { ControlEntry } from '../scanner';
import { failResult, okResult, readCurrentValue, verifyWrite, type ControlResult } from '../verify';

/** 原生 select：设置真实 option.value 并触发 change，然后回读选中值。 */
export async function fillSelect(entry: ControlEntry, optionValue: string, overwrite: boolean): Promise<ControlResult> {
  const select = entry.primary as HTMLSelectElement;
  const current = readCurrentValue(entry);

  if (current === optionValue) return okResult('VALUE_ALREADY_EQUAL', '网页上已经是这个选项');
  if (current.trim().length > 0 && !overwrite) {
    return failResult('EXISTING_VALUE', '网页已选择了不同选项，已保留原值');
  }

  const matches = [...select.options].filter((option) => option.value === optionValue && !option.disabled);
  if (matches.length === 0) return failResult('AMBIGUOUS_OPTION', '选项在写入时已不存在');
  if (matches.length > 1) return failResult('AMBIGUOUS_OPTION', '有多个同值选项，无法确定');

  select.focus({ preventScroll: true });
  select.value = optionValue;
  dispatchInputEvents(select);
  await nextFrames(2);

  return verifyWrite(entry, { expected: optionValue, compare: 'value' });
}
