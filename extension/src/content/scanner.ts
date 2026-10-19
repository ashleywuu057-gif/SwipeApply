import { collapseWhitespace, normalizeLabel, normalizeText } from '../shared/normalize';
import { fieldFingerprint, formFingerprint } from '../shared/fingerprints';
import { buildRouteKey } from '../shared/urls';
import type {
  ControlKind, DatePart, FieldDescriptor, FieldOption, SectionKind,
} from '../shared/types';
import type { ScanResult } from '../shared/protocol';
import {
  choiceOptionValue, classifySelectLikeInput, displayedSelectValue, groupLabelFor, isChoiceChecked,
  isOwnElement, isVisible, resolveLabel,
} from './dom-utils';
import { analyzeStructure, sectionContains, type RecordContainer } from './sections';
import type { SiteAdapter } from './adapters/types';
import type { AreaPickerKind, ComponentBinding, DatePickerKind } from './components/types';
import { discoverComponentControls, resolveComponent } from './components/registry';

/** DOM 到 FieldDescriptor。元素本身只保存在内容脚本私有 Map 中，不发给后台。 */

export const MAX_FIELDS = 300;
export const MAX_SERIALIZED_BYTES = 512 * 1024;

export interface ControlEntry {
  fieldId: string;
  kind: ControlKind;
  /** radio 组包含多个元素；其余为单元素。 */
  elements: HTMLElement[];
  primary: HTMLElement;
  descriptor: FieldDescriptor;
  recordRoot: Element | null;
  customSelectFallback: 'moka-school' | 'moka-major' | null;
  datePickerKind: DatePickerKind | null;
  areaPickerKind: AreaPickerKind | null;
  getSelectPopup: (() => Element | null) | null;
  component?: ComponentBinding | null;
}

export interface ScanOutput {
  result: ScanResult;
  entries: Map<string, ControlEntry>;
  addActionElements: Map<string, { button: HTMLElement; root: Element }>;
}

const DECLARATION_PATTERN = /(声明|承诺|同意|授权|隐私|条款|协议|保证|知情|真实性)/;
/**
 * 敏感信息默认列为待处理，绝不用别的字段代替。后台仅允许用户主动保存、
 * 字段目录显式放行并由站点适配器精确绑定的少数字段继续填写。
 */
const SENSITIVE_PATTERN = /(身份证|证件号|护照号|港澳|台胞证|社保|公积金|银行卡|银行账|开户行|政治面貌|民族|婚姻状况|健康状况|血型|残疾|宗教|户口|户籍所在地|家庭住址|详细地址|通讯地址|紧急联系|家庭成员|亲属|担保人|密码)/;
const SKIPPED_INPUT_TYPES = new Set(['password', 'hidden', 'file', 'submit', 'reset', 'button', 'image']);

function inputKind(input: HTMLInputElement): ControlKind | null {
  const type = (input.getAttribute('type') ?? 'text').toLowerCase();
  if (SKIPPED_INPUT_TYPES.has(type)) return null;
  switch (type) {
    case 'radio':
      return 'radio';
    case 'checkbox':
      return 'checkbox';
    case 'date':
      return 'date';
    case 'month':
      return 'month';
    case 'number':
    case 'tel':
    case 'email':
    case 'url':
    case 'search':
    case 'text':
      return 'text';
    default:
      return 'unsupported';
  }
}

function optionsOfSelect(select: HTMLSelectElement): FieldOption[] {
  return [...select.options]
    .filter((option) => !option.disabled)
    .map((option) => ({ label: collapseWhitespace(option.textContent ?? ''), value: option.value }))
    .filter((option) => option.label.length > 0 || option.value.length > 0);
}

function optionsOfRadioGroup(radios: HTMLElement[]): FieldOption[] {
  return radios.map((radio) => ({
    label: radio instanceof HTMLInputElement ? (resolveLabel(radio).raw || radio.value) : choiceOptionValue(radio),
    value: choiceOptionValue(radio),
  }));
}

const YEAR_UNIT = /^(年|年份|year)$/i;
const MONTH_UNIT = /^(月|月份|month)$/i;
const START_EDGE = /(开始|起始|入学|入职|起)/;
const END_EDGE = /(结束|毕业|离职|终止|至)/;

interface DatePartDetection {
  part: DatePart;
  label: string;
  /** 四段式年月范围的每一格都是可安全点选的自定义下拉，不是日历。 */
  customSelect: boolean;
}

function dateUnit(raw: string): DatePart['unit'] | null {
  const normalized = normalizeLabel(raw);
  return YEAR_UNIT.test(normalized) ? 'year' : MONTH_UNIT.test(normalized) ? 'month' : null;
}

/**
 * 分拆年/月：
 * 1) 有「年 / 月」本体标签时，用外层分组标题判断起止；
 * 2) 国内 ATS 常把年月范围做成 4 个无标签下拉，只留下占位符
 *    `年、月、年、月`。严格识别这个完整序列，按 DOM 顺序绑定开始/结束。
 */
function detectDatePart(element: Element, ownLabel: string, groupLabel: string): DatePartDetection | null {
  const unit = YEAR_UNIT.test(ownLabel) ? 'year' : MONTH_UNIT.test(ownLabel) ? 'month' : null;
  if (unit && groupLabel) {
    const edge = START_EDGE.test(groupLabel) ? 'start' : END_EDGE.test(groupLabel) ? 'end' : null;
    if (edge) return { part: { edge, unit }, label: groupLabel, customSelect: false };
  }

  if (!(element instanceof HTMLInputElement)) return null;
  const explicitRange = element.closest('[class*="month-range-select"]');

  let ancestor: Element | null = element.parentElement;
  for (let hop = 0; ancestor && hop < 8; hop += 1, ancestor = ancestor.parentElement) {
    // Moka 在完整范围里嵌套两组年/月。以完整范围为边界，不能提前把内层一对
    // 当作获奖日期等 single 日期；已选择后占位符消失时也沿用同一结构。
    if (explicitRange && ancestor !== explicitRange) continue;
    const structuralRange = String(ancestor.className || '').includes('month-range-select');
    const allTextInputs = [...ancestor.querySelectorAll<HTMLInputElement>('input[type="text"]')]
      .filter((input) => isVisible(input));
    const candidates = structuralRange
      ? allTextInputs
      : allTextInputs.filter((input) => dateUnit(input.getAttribute('placeholder') ?? '') !== null);
    if (!candidates.includes(element) || (candidates.length !== 4 && candidates.length !== 2)) continue;

    const expectedUnits: DatePart['unit'][] = candidates.length === 4
      ? ['year', 'month', 'year', 'month']
      : ['year', 'month'];
    const units = candidates.map((input, candidateIndex) =>
      dateUnit(input.getAttribute('placeholder') ?? '') ?? (structuralRange ? expectedUnits[candidateIndex]! : null));
    if (units.join(',') !== expectedUnits.join(',')) continue;
    // 所有格都必须是结构化下拉；普通文本框不在这里冒充日期控件。
    if (!candidates.every((input) => classifySelectLikeInput(input, '') === 'custom-select')) continue;
    const index = candidates.indexOf(element);
    const edge: DatePart['edge'] = candidates.length === 2 ? 'single' : index < 2 ? 'start' : 'end';
    const unit = units[index]!;
    const baseLabel = edge === 'single'
      ? (resolveLabel(ancestor).raw || groupLabel || ownLabel || '日期')
      : `${edge === 'start' ? '开始' : '结束'}时间`;
    return { part: { edge, unit }, label: `${baseLabel}（${unit === 'year' ? '年' : '月'}）`, customSelect: true };
  }
  return null;
}

function isEmptyValue(kind: ControlKind, elements: HTMLElement[]): boolean {
  const primary = elements[0]!;
  switch (kind) {
    case 'radio':
      return !elements.some(isChoiceChecked);
    case 'checkbox':
      return !(primary as HTMLInputElement).checked;
    case 'select': {
      const select = primary as HTMLSelectElement;
      return select.value === '' || select.selectedIndex < 0;
    }
    case 'combobox':
    case 'date-picker': {
      if (primary instanceof HTMLInputElement) {
        return primary.value.trim() === '' && displayedSelectValue(primary) === '';
      }
      return displayedSelectValue(primary) === '';
    }
    case 'unsupported':
      return true;
    default:
      return (primary as HTMLInputElement).value.trim() === '';
  }
}

function maxLengthOf(element: HTMLElement): number | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.maxLength > 0 ? element.maxLength : null;
  }
  return null;
}

interface RawControl {
  kind: ControlKind;
  elements: HTMLElement[];
  primary: HTMLElement;
  /** unsupported 的具体原因，供报告使用。 */
  unsupportedReason?: string;
  /** 一个视觉年月区间只有一个隐藏 input，适配器把它拆成两个逻辑端点。 */
  forcedDatePart?: DatePart;
  forcedLabel?: string;
  component?: ComponentBinding;
}

/** 收集候选控件；密码、隐藏字段既不读取也不计入字段数量。 */
function collectControls(root: ParentNode, adapter: SiteAdapter): RawControl[] {
  const controls: RawControl[] = [];
  const seenRadioGroups = new Set<string>();

  const nodes = root.querySelectorAll<HTMLElement>(
    'input, textarea, select, [role="combobox"], .phoenix-radio-group, iframe, [contenteditable="true"]',
  );

  for (const node of nodes) {
    if (isOwnElement(node)) continue;

    if (node.classList.contains('phoenix-radio-group')) {
      if (!isVisible(node)) continue;
      const choices = [...node.querySelectorAll<HTMLElement>(':scope > .phoenix-radio-group__radioItem')]
        .filter(isVisible);
      if (choices.length > 0) controls.push({ kind: 'radio', elements: choices, primary: node });
      continue;
    }

    if (node.tagName.toLowerCase() === 'iframe') {
      if (!isVisible(node)) continue;
      controls.push({ kind: 'unsupported', elements: [node], primary: node, unsupportedReason: '内嵌页面（iframe）需要手动处理' });
      continue;
    }

    if (node.getAttribute('contenteditable') === 'true') {
      if (!isVisible(node)) continue;
      controls.push({ kind: 'unsupported', elements: [node], primary: node, unsupportedReason: '富文本编辑器暂不支持自动填写' });
      continue;
    }

    if (node instanceof HTMLSelectElement) {
      if (!isVisible(node) || node.multiple) {
        if (node.multiple && isVisible(node)) {
          controls.push({ kind: 'unsupported', elements: [node], primary: node, unsupportedReason: '多选列表需要手动选择' });
        }
        continue;
      }
      controls.push({ kind: 'select', elements: [node], primary: node });
      continue;
    }

    if (node instanceof HTMLTextAreaElement) {
      if (!isVisible(node)) continue;
      controls.push({ kind: 'textarea', elements: [node], primary: node });
      continue;
    }

    if (node instanceof HTMLInputElement) {
      const type = (node.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'password' || type === 'hidden') continue;
      if (type === 'file') {
        if (!isVisible(node)) continue;
        controls.push({ kind: 'unsupported', elements: [node], primary: node, unsupportedReason: '附件需要你自己上传' });
        continue;
      }
      const kind = inputKind(node);
      if (kind === null) continue;
      if (SKIPPED_INPUT_TYPES.has(type)) continue;
      if (!isVisible(node)) {
        const dateRoot = node.closest('.atsx-date-picker-period-month');
        if (dateRoot && isVisible(dateRoot) && adapter.datePickerKind?.(node) === 'feishu-period-month') {
          controls.push({
            kind: 'text', elements: [node], primary: node,
            forcedDatePart: { edge: 'start', unit: 'month' }, forcedLabel: '开始时间',
          });
          controls.push({
            kind: 'text', elements: [node], primary: node,
            forcedDatePart: { edge: 'end', unit: 'month' }, forcedLabel: '结束时间',
          });
          continue;
        }
        // Phoenix 把真实 checkbox 设为透明，并用旁边的 box/label 绘制视觉控件。
        // 它通常不在原生 <label> 内，但最近的 .phoenix-checkbox 是可见、可点击的。
        const labelledChoice = (kind === 'checkbox' || kind === 'radio')
          ? node.closest('label, .phoenix-checkbox')
          : null;
        if (!labelledChoice || !isVisible(labelledChoice)) continue;
      }

      if (kind === 'radio') {
        const groupKey = `${node.name}::${node.form ? (node.form.getAttribute('id') ?? 'form') : 'noform'}`;
        if (!node.name || seenRadioGroups.has(groupKey)) continue;
        seenRadioGroups.add(groupKey);
        const scope = node.form ?? node.ownerDocument;
        const radios = [...scope.querySelectorAll<HTMLInputElement>(`input[type="radio"]`)]
          .filter((radio) => radio.name === node.name && !isOwnElement(radio) && isVisible(radio));
        if (radios.length === 0) continue;
        controls.push({ kind: 'radio', elements: radios, primary: radios[0]!, });
        continue;
      }

      // 新版飞书（ud-formily）的学校名称是包在 .ud__select 里的搜索框：要从候选里点选，不能当普通文本写
      if (node.getAttribute('role') === 'combobox' || node.hasAttribute('aria-controls') || node.closest('.ud__select') !== null) {
        controls.push({ kind: 'combobox', elements: [node], primary: node });
        continue;
      }

      controls.push({ kind, elements: [node], primary: node });
      continue;
    }

    // role=combobox 的非 input 元素
    if (node.getAttribute('role') === 'combobox') {
      if (!isVisible(node)) continue;
      controls.push({ kind: 'combobox', elements: [node], primary: node });
    }
  }

  for (const element of discoverComponentControls(root)) {
    // 组件必须明确认领结构；List.Item 也可能只是导航，不能无条件当成字段。
    const component = resolveComponent(element, resolveLabel(element).raw);
    if (!component || controls.some((control) => element.contains(control.primary) || control.primary.contains(element))) continue;
    controls.push({ kind: component.kind, elements: [element], primary: element, component });
  }

  // 页面上既有真实控件又有视觉壳时，只保留一个逻辑控件。
  return controls.filter((control) => {
    if (control.kind !== 'combobox') return true;
    return !controls.some(
      (other) =>
        other !== control &&
        other.kind !== 'combobox' &&
        other.kind !== 'unsupported' &&
        control.primary.contains(other.primary),
    );
  });
}

/** 有标签但没有可识别控件的行：报告为待处理，不猜测其结构。 */
function collectOrphanLabels(root: ParentNode, controls: RawControl[]): RawControl[] {
  const orphans: RawControl[] = [];
  const candidates = root.querySelectorAll<HTMLElement>('label, [class*="label"], [class*="Label"], .am-list-content');
  for (const label of candidates) {
    if (isOwnElement(label) || !isVisible(label)) continue;
    if (label.closest('nav, a[href], [role="dialog"], [role="listbox"], .am-picker-popup, .am-modal')) continue;
    const nativeLabel = label.tagName.toLowerCase() === 'label';
    const text = collapseWhitespace(label.textContent ?? '');
    if (!nativeLabel) {
      // 只报告“短标签 + 同行控件分支”的结构，忽略选项文案、说明文字、空展示值。
      if (!text || text.length > 60 || !label.nextElementSibling ||
          (label.parentElement?.children.length ?? 0) > 4 ||
          ![...label.classList].some((name) => /(?:^label(?:[-_]|$)|Label(?:___|$)|[-_]label(?:[-_]|$)|^am-list-content$)/.test(name))) continue;
    }
    const forId = label.getAttribute('for');
    if (forId && label.ownerDocument.getElementById(forId)) continue;
    if (label.querySelector('input, select, textarea, [role="combobox"]')) continue;
    const row = label.parentElement;
    if (!row) continue;
    // Phoenix 标题和控件位于同一个 form-item 的两个分支；普通页面仍只检查标签直属行，
    // 避免向上走到整个 form 后把真正的孤儿控件吞掉。
    // 新版飞书招聘（ud-formily）同理：标签和控件在同一个 .ud-formily-item 的两个分支里。
    const fieldScope = label.closest('.form-item, .atsx-form-item, .ud-formily-item, .am-list-item') ?? row;
    if (controls.some((control) => fieldScope.contains(control.primary))) continue;
    if (orphans.some((orphan) => fieldScope.contains(orphan.primary))) continue;
    orphans.push({
      kind: 'unsupported',
      elements: [label],
      primary: label,
      unsupportedReason: '这是页面自定义的控件，扩展无法安全操作',
      forcedLabel: text,
    });
  }
  return orphans;
}

export interface ScanOptions {
  adapter: SiteAdapter;
  adapterFallbackReason: string | null;
  document: Document;
}

export function scanPage(options: ScanOptions): ScanOutput {
  const { document, adapter } = options;
  const scanRoot = adapter.scanRoot?.(document) ?? document;
  const raw = [...collectControls(scanRoot, adapter)];
  raw.push(...collectOrphanLabels(scanRoot, raw));

  const controlElements = raw.map((control) => control.primary);
  const structure = analyzeStructure(scanRoot, controlElements);

  // 适配器给出的分区标注覆盖启发式结果。
  const hintedSections = new Map<Element, {
    section: SectionKind;
    degree: string | null;
    isRecord: boolean;
    recordOrder: number;
  }>();
  const recordOrderBySection = new Map<SectionKind, number>();
  for (const hint of adapter.sectionHints?.(document) ?? []) {
    const recordOrder = hint.isRecord ? (recordOrderBySection.get(hint.section) ?? 0) : 0;
    if (hint.isRecord) recordOrderBySection.set(hint.section, recordOrder + 1);
    hintedSections.set(hint.root, {
      section: hint.section,
      degree: hint.degree ?? null,
      isRecord: hint.isRecord ?? false,
      recordOrder,
    });
  }

  const entries = new Map<string, ControlEntry>();
  const descriptors: FieldDescriptor[] = [];
  const adapterBindings: ScanResult['adapterBindings'] = [];
  const recordInstances = new Map<string, {
    section: SectionKind;
    sectionInstanceId: string;
    recordInstanceId: string;
    degreeHint: string | null;
    identityHint: string | null;
    order: number;
  }>();

  let truncated = false;
  let truncationReason: string | null = null;
  let serializedBytes = 0;

  raw.forEach((control, index) => {
    if (descriptors.length >= MAX_FIELDS) {
      truncated = true;
      truncationReason = `页面可见字段超过 ${MAX_FIELDS} 个，只处理前 ${MAX_FIELDS} 个`;
      return;
    }
    if (truncated) return;

    const element = control.primary;
    const labelInfo = resolveLabel(element);
    const record: RecordContainer | undefined = structure.recordOfControl.get(element);
    const sectionBinding = structure.sectionOfControl.get(element);

    // 适配器标注的分区优先。
    let section: SectionKind = sectionBinding?.section ?? 'unknown';
    let sectionInstanceId = sectionBinding?.sectionInstanceId ?? 'sec-none';
    let recordInstanceId = record?.recordInstanceId ?? null;
    let degreeHint: string | null = record?.degreeHint ?? null;
    let recordRoot: Element | null = record?.root ?? null;
    let recordOrder = record?.order ?? 0;

    for (const [root, hint] of hintedSections) {
      if (!root.contains(element)) continue;
      section = hint.section;
      sectionInstanceId = `adapter-${hint.section}`;
      if (hint.isRecord) {
        recordInstanceId = `adapter-${hint.section}-record-${hint.recordOrder}`;
        degreeHint = hint.degree;
        recordRoot = root;
        recordOrder = hint.recordOrder;
      }
    }

    const groupLabel = groupLabelFor(element, recordRoot);
    const dateDetection = detectDatePart(element, labelInfo.normalized, groupLabel);
    const datePart = control.forcedDatePart ?? dateDetection?.part ?? null;
    // radio 组的含义来自组标签，不是某个选项自己的文字。
    const label = control.forcedLabel ?? control.component?.label ?? dateDetection?.label ??
      (control.kind === 'radio' && groupLabel ? groupLabel : labelInfo.raw);
    const normalized = normalizeLabel(label);

    const isDeclaration = control.kind === 'checkbox' && DECLARATION_PATTERN.test(normalized);
    // 长得像输入框的自定义控件：直接写文本只会造成假成功。
    // 自定义下拉可以按「点开 → 精确匹配 → 点击 → 回读」操作；
    // 日期选择器仅交给明确支持该组件的站点适配器。
    const selectLike = control.kind === 'text'
      ? (control.forcedDatePart ? 'date-picker' : dateDetection?.customSelect ? 'custom-select' : classifySelectLikeInput(element, normalized))
      : null;
    const sensitive = normalized.length > 0 && SENSITIVE_PATTERN.test(normalized);
    // 新版飞书（ud-formily）的下拉输入框都带 readonly：意思是"不能打字、只能点选"，不是被锁定。
    // 真正锁定的下拉会在 selector 上标 disabled。
    const udSelectable = Boolean(element.closest('.ud__select')) &&
      !element.closest('.ud__select')!.querySelector('.ud__select__selector-disabled');
    const locked = (element as HTMLInputElement).disabled === true ||
      ((element as HTMLInputElement).readOnly === true && !udSelectable);

    const datePickerKind = selectLike === 'date-picker' ? (adapter.datePickerKind?.(element) ?? null) : null;
    const areaPickerKind = (control.kind === 'combobox' || selectLike === 'custom-select')
      ? (adapter.areaPickerKind?.(element) ?? null)
      : null;
    const component = control.component ?? resolveComponent(element, label, { datePickerKind, areaPickerKind });
    const datePrecision = component?.datePrecision ?? null;
    const supportedDatePicker = component?.kind === 'date-picker';
    const kind: ControlKind = isDeclaration || (selectLike === 'date-picker' && !supportedDatePicker)
      ? 'unsupported'
      : supportedDatePicker
        ? 'date-picker'
      : selectLike === 'custom-select'
        ? 'combobox'
        : control.kind;

    const unsupportedReason = isDeclaration
      ? '声明与授权类勾选需要你自己确认'
      : selectLike === 'date-picker' && !supportedDatePicker
        ? '这是网站自定义的日期选择器，扩展不会去点它的日历，请手动选择'
        : sensitive
          ? '敏感信息默认不自动填写；只有履历明确保存且当前站点经过精确适配时才会使用'
          : locked
            ? '网站锁定了这个字段（通常来自你的账号资料），只能在网站上修改'
            : (control.unsupportedReason ?? null);

    const options: FieldOption[] =
      kind === 'select'
        ? optionsOfSelect(element as HTMLSelectElement)
        : kind === 'radio'
          ? optionsOfRadioGroup(control.elements)
          : [];

    const nameHint = element.getAttribute('name');
    const placeholderHint = element.getAttribute('placeholder');
    const fieldId = `field-${index}`;

    const descriptor: FieldDescriptor = {
      fieldId,
      section,
      sectionInstanceId,
      recordInstanceId,
      label: label || '(未命名字段)',
      normalizedLabel: normalized,
      nameHint: nameHint && nameHint.length <= 200 ? nameHint : null,
      placeholderHint: placeholderHint && placeholderHint.length <= 300 ? placeholderHint : null,
      controlKind: kind,
      required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true' ||
        Boolean(element.closest('.form-item')?.querySelector('.form-item__required')) ||
        Boolean(element.closest('.atsx-form-item')?.querySelector('.atsx-form-item-required')),
      disabled: (element as HTMLInputElement).disabled === true || element.getAttribute('aria-disabled') === 'true' ||
        (component?.isDisabled?.(element) ?? false),
      readOnly: supportedDatePicker || udSelectable ? false : (element as HTMLInputElement).readOnly === true,
      visible: isVisible(element) || (supportedDatePicker && Boolean(
        element.closest('.atsx-date-picker') && isVisible(element.closest('.atsx-date-picker')!),
      )) || ((kind === 'checkbox' || kind === 'radio') && Boolean(
        element.closest('label, .phoenix-checkbox') && isVisible(element.closest('label, .phoenix-checkbox')!),
      )),
      empty: component?.readValue ? component.readValue(element).trim() === '' : isEmptyValue(kind, control.elements),
      maxLength: maxLengthOf(element),
      options,
      semanticFingerprint: fieldFingerprint({ section, label: normalized, controlKind: kind, options, nameHint }),
      datePart,
      datePrecision,
      datePresentValue: datePickerKind === 'feishu-period-month' ? '至今' : null,
      degreeHint: (degreeHint as FieldDescriptor['degreeHint']) ?? null,
      recordIdentityHint: null,
      unsupportedReason: kind === 'unsupported' || sensitive || (locked && !supportedDatePicker) ? unsupportedReason : null,
      sensitive,
    };

    serializedBytes += JSON.stringify(descriptor).length;
    if (serializedBytes > MAX_SERIALIZED_BYTES) {
      truncated = true;
      truncationReason = '页面结构过大，已停止扫描，请缩小页面范围后重试';
      return;
    }

    descriptors.push(descriptor);
    entries.set(fieldId, {
      fieldId,
      kind,
      elements: control.elements,
      primary: element,
      descriptor,
      recordRoot,
      customSelectFallback: adapter.customSelectFallback?.(element) ?? null,
      datePickerKind,
      areaPickerKind,
      getSelectPopup: adapter.getSelectPopup ? () => adapter.getSelectPopup!(element) : null,
      component,
    });

    if (recordInstanceId && !recordInstances.has(recordInstanceId)) {
      recordInstances.set(recordInstanceId, {
        section,
        sectionInstanceId,
        recordInstanceId,
        degreeHint,
        identityHint: null,
        order: recordOrder,
      });
    }

    const binding = adapter.bindField?.(descriptor, element);
    if (binding) adapterBindings.push({ fieldId, section: binding.section, field: binding.field });
  });

  // 记录身份：容器内已填写的学校/公司/项目名，仅用于本轮绑定。
  const IDENTITY_LABELS = /^(学校|毕业院校|就读院校|学校名称|公司|公司名称|单位|实习单位|项目名称|项目名|实践名称|语种|语言类型|奖项名称|获奖项|名称|证书名称)$/;
  for (const entry of entries.values()) {
    if (!entry.descriptor.recordInstanceId) continue;
    if (!IDENTITY_LABELS.test(entry.descriptor.normalizedLabel)) continue;
    const value = entry.component?.readValue ? entry.component.readValue(entry.primary) : entry.primary instanceof HTMLInputElement
      ? (entry.primary.value || displayedSelectValue(entry.primary))
      : (entry.primary.textContent ?? '');
    const text = normalizeText(value);
    if (!text) continue;
    const instance = recordInstances.get(entry.descriptor.recordInstanceId);
    if (instance && !instance.identityHint) instance.identityHint = text.slice(0, 200);
    entry.descriptor.recordIdentityHint = text.slice(0, 200);
  }

  // 新增经历控件：只接受适配器明确提供且位于对应分区的元素。
  const addActions: ScanResult['addActions'] = [];
  const addActionElements = new Map<string, { button: HTMLElement; root: Element }>();
  const sectionRoots = new Map<string, { section: SectionKind; sectionInstanceId: string; root: Element }>();
  for (const sectionBinding of structure.sections) {
    // 虚拟的相邻分区不能把整个父容器交给平台寻找“添加”按钮。
    if (sectionBinding.contentRoots.length !== 1 || sectionBinding.contentRoots[0] !== sectionBinding.root) continue;
    sectionRoots.set(sectionBinding.sectionInstanceId, sectionBinding);
  }
  for (const [root, hint] of hintedSections) {
    if (hint.isRecord) continue;
    const sectionInstanceId = `adapter-${hint.section}`;
    sectionRoots.set(sectionInstanceId, { section: hint.section, sectionInstanceId, root });
  }
  for (const sectionBinding of sectionRoots.values()) {
    const action = adapter.getAddRecordAction?.(sectionBinding.section, sectionBinding.root);
    if (!action) continue;
    addActions.push({
      section: sectionBinding.section,
      sectionInstanceId: sectionBinding.sectionInstanceId,
      label: action.label,
    });
    addActionElements.set(sectionBinding.sectionInstanceId, { button: action.button, root: sectionBinding.root });
  }

  const jobCandidate = adapter.getJobCandidate?.(document) ?? null;

  const diagnostics = [...new Set(structure.sections.flatMap((section) => {
    if (section.section === 'unknown' || descriptors.some((field) => field.section === section.section) ||
        controlElements.some((element) => sectionContains(section, element)) ||
        addActions.some((action) => action.section === section.section)) return [];
    const buttons = section.contentRoots.flatMap((root) => [root, ...root.querySelectorAll('button, a, [role="button"]')]);
    if (!buttons.some((button) => isVisible(button) && /^\+?\s*(?:添加|新增)$/.test(normalizeText(button.textContent ?? '')))) return [];
    return [`${section.headingText}尚未展开字段，请先在网页添加经历，再重新扫描；本轮未自动点击添加。`];
  }))].slice(0, 30);

  const result: ScanResult = {
    routeKey: buildRouteKey(document.location.href),
    origin: document.location.origin,
    pageTitle: normalizeText(document.title).slice(0, 300),
    descriptors,
    recordInstances: [...recordInstances.values()].map((instance) => ({
      section: instance.section,
      sectionInstanceId: instance.sectionInstanceId,
      recordInstanceId: instance.recordInstanceId,
      degreeHint: (instance.degreeHint as FieldDescriptor['degreeHint']) ?? null,
      identityHint: instance.identityHint,
      order: instance.order,
    })),
    addActions,
    adapterBindings,
    orderFallbackSections: adapter.orderFallbackSections?.() ?? [],
    jobCandidate,
    adapterId: adapter.id,
    truncated,
    truncationReason,
    formFingerprint: formFingerprint(descriptors),
    diagnostics,
  };

  return { result, entries, addActionElements };
}
