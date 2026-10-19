import { dispatchInputEvents, nextFrames, setNativeValue } from '../dom-utils';
import type { ControlEntry } from '../scanner';
import { failResult, okResult, readCurrentValue, verifyWrite, type ControlResult } from '../verify';

/** date / month：值已由投影器按控件精度生成，这里只负责写入与回读。 */
export async function fillDateInput(entry: ControlEntry, value: string, overwrite: boolean): Promise<ControlResult> {
  const input = entry.primary as HTMLInputElement;
  const current = readCurrentValue(entry);
  if (current === value) return okResult('VALUE_ALREADY_EQUAL', '网页上的日期与履历相同');
  if (current.trim().length > 0 && !overwrite) {
    return failResult('EXISTING_VALUE', '网页已有不同日期，已保留原值');
  }

  input.focus({ preventScroll: true });
  setNativeValue(input, value);
  dispatchInputEvents(input, { blur: true });
  await nextFrames(2);

  if (input.value === '') {
    return failResult('PRECISION_MISMATCH', '网页拒绝了这个日期格式，可能要求更高精度');
  }
  return verifyWrite(entry, { expected: value, compare: 'value' });
}
