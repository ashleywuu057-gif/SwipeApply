import { fillAreaPicker, fillBeisenMultiAreaPicker, fillFeishuAreaPicker, readBeisenMultiAreaValue } from '../controls/area-picker';
import { fillDatePicker } from '../controls/date-picker';
import { isOwnElement, isVisible } from '../dom-utils';
import { antMobileDriver } from './ant-mobile';
import type { ComponentBinding, ComponentDriver, ComponentHints } from './types';

const DRIVERS: ComponentDriver[] = [antMobileDriver];

export function discoverComponentControls(root: ParentNode): HTMLElement[] {
  return [...new Set(DRIVERS.flatMap((driver) => driver.discover?.(root) ?? []))]
    .filter((element) => !isOwnElement(element) && isVisible(element));
}

/** 站点声明的已验证变体优先；通用组件识别不依赖当前站点适配器。 */
export function resolveComponent(
  element: HTMLElement,
  label: string,
  hints: ComponentHints = {},
): ComponentBinding | null {
  if (hints.datePickerKind) {
    return {
      id: hints.datePickerKind,
      kind: 'date-picker',
      datePrecision: hints.datePickerKind === 'beisen-phoenix-day' ? 'day'
        : hints.datePickerKind === 'feishu-year' ? 'year' : 'month',
      fill: (entry, values, overwrite) => fillDatePicker(entry, values[0] ?? '', overwrite),
    };
  }
  if (hints.areaPickerKind) {
    const multi = hints.areaPickerKind === 'beisen-phoenix-area-multi';
    return {
      id: hints.areaPickerKind,
      kind: 'combobox',
      ...(multi ? { readValue: readBeisenMultiAreaValue } : {}),
      fill: hints.areaPickerKind === 'beisen-phoenix-area'
        ? fillAreaPicker
        : multi
          ? fillBeisenMultiAreaPicker
          : fillFeishuAreaPicker,
    };
  }
  const matches = DRIVERS.flatMap((driver) => {
    const match = driver.resolve(element, label);
    return match ? [match] : [];
  });
  // 多个组件同时声称拥有同一控件时，不选择其中一个碰运气。
  return matches.length === 1 ? matches[0]! : null;
}
