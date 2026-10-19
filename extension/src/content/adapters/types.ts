import type { DegreeLevel, FieldDescriptor, JobCandidate, KnownSection, SectionKind } from '../../shared/types';
import type { AreaPickerKind, DatePickerKind } from '../components/types';

/** 站点适配器接口。适配器只提供页面结构上的明确绑定，不能返回可执行脚本。 */

export interface AdapterContext {
  origin: string;
  pathname: string;
  document: Document;
}

export interface SectionHint {
  root: Element;
  section: SectionKind;
  /** 该容器对应的学历层级（页面上真实标注的）。 */
  degree?: DegreeLevel;
  /** 该容器是一条独立记录。 */
  isRecord?: boolean;
}

/** 适配器给出的明确字段绑定，仍需通过白名单校验。 */
export interface FieldBinding {
  section: KnownSection;
  field: string;
}

/** 新增经历元素必须由适配器绑定到明确分区并可检查。 */
export interface VerifiedAddAction {
  section: SectionKind;
  sectionInstanceId: string;
  label: string;
  /** 部分 ATS（如北森）使用带明确 addButton id 的可点击 div。 */
  button: HTMLElement;
}

export interface VerificationResult {
  ok: boolean;
  reason: string | null;
}

export interface SiteAdapter {
  id: string;
  version: number;
  matches(context: AdapterContext): boolean;
  /** 把扫描限制在站点的真实简历表单，排除页面插件和悬浮工具。 */
  scanRoot?(document: Document): ParentNode | null;
  /** 页面上真实存在的分区标注。 */
  sectionHints?(document: Document): SectionHint[];
  /** 对单个控件给出明确的源字段绑定。 */
  bindField?(descriptor: FieldDescriptor, element: Element): FieldBinding | null;
  /** 允许「按履历顺序」绑定重复经历的分区。 */
  orderFallbackSections?(): SectionKind[];
  getJobCandidate?(document: Document): JobCandidate | null;
  getAddRecordAction?(section: SectionKind, root: Element): VerifiedAddAction | null;
  /** 这个只读文本壳是适配器已验证可操作的年月选择器。 */
  datePickerKind?(element: Element): DatePickerKind | null;
  /** 这个选择器会打开适配器已验证的省市搜索与确认浮层。 */
  areaPickerKind?(element: Element): AreaPickerKind | null;
  /** 下拉选项被 portal 到 body 时，返回当前控件唯一且可见的浮层。 */
  getSelectPopup?(element: Element): Element | null;
  /** 页面明确提供的自由文本候选创建流程；只标记已实测的控件。 */
  customSelectFallback?(element: Element): 'moka-school' | 'moka-major' | null;
  /** 写入后由适配器补充验证（例如页面自身的状态回显）。 */
  verifyField?(element: Element, expected: string): VerificationResult;
}
