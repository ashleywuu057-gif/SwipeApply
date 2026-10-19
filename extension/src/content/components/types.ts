import type { ControlKind } from '../../shared/types';
import type { ControlEntry } from '../scanner';
import type { ControlResult } from '../verify';

/** 组件层只理解 DOM 控件，不选择履历记录、不点击新增经历、不包含域名规则。 */
export type DatePickerKind =
  | 'moka-month'
  | 'beisen-phoenix-month'
  | 'beisen-phoenix-day'
  | 'feishu-period-month'
  | 'feishu-year';
export type AreaPickerKind = 'beisen-phoenix-area' | 'beisen-phoenix-area-multi' | 'feishu-tree-area';

/** 平台可以声明已验证的组件变体；业务判断仍留在平台层。 */
export interface ComponentHints {
  datePickerKind?: DatePickerKind | null;
  areaPickerKind?: AreaPickerKind | null;
}

/** 只留在内容脚本内，不把函数或 DOM 发给后台。 */
export interface ComponentBinding {
  id: string;
  kind: ControlKind;
  label?: string;
  datePrecision?: 'year' | 'month' | 'day';
  readValue?: (element: HTMLElement) => string;
  isDisabled?: (element: HTMLElement) => boolean;
  fill: (entry: ControlEntry, values: string[], overwrite: boolean) => Promise<ControlResult>;
}

export interface ComponentDriver {
  /** 额外发现没有原生 input / ARIA 的视觉控件。 */
  discover?: (root: ParentNode) => HTMLElement[];
  resolve: (element: HTMLElement, label: string) => ComponentBinding | null;
}
