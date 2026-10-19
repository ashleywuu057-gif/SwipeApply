import { normalizeLabel, normalizeText } from '../../shared/normalize';
import type { FieldDescriptor, KnownSection, SectionKind } from '../../shared/types';
import { isVisible } from '../dom-utils';
import type { AdapterContext, FieldBinding, SectionHint, SiteAdapter, VerifiedAddAction } from './types';

/**
 * 新版飞书招聘申请表（ud-formily 组件库，例如 xiaopeng.jobs.feishu.cn）。
 * 和旧版（atsx / resumeEditForm，见 feishu.ts）结构完全不同：
 * - 分区：.applyFormModuleWrapper-left 里的 .applyFormModuleWrapper-text 是标题，右侧是字段；
 * - 字段：每个字段包在 id="formily-item-<key>" 的 .ud-formily-item 里，key 稳定（name、school、field_of_study…）；
 * - 经历：每一段是一张 [class*="apply-form-array-card__"] 卡片，同一个 key 在每张卡片里重复出现；
 * - 新增：分区里文字为「添加」的 ud__button。
 * 下拉（学历、性别…）和学校搜索框：选项在 portal 出来的 .ud__select__dropdown 里，走通用的自定义下拉流程
 * （点开 → 必要时输入关键字 → 唯一精确匹配 → 点选 → 回读 .ud__select__selector__selectItem）。
 * 日期（throne-biz 区间选择器）、城市还没有适配，留给你手动选。
 * 结构来自 2026-09 小鹏集团申请页的只读诊断（不含任何个人数据）。
 */

const FIXTURE_ORIGINS = new Set(['http://127.0.0.1:4173', 'http://localhost:4173']);

const SECTION_NAMES = new Map<string, SectionKind>([
  ['申请信息', 'preferences'],
  ['基本信息', 'personal'],
  ['教育经历', 'education'],
  ['工作经历', 'workExperiences'],
  ['实习经历', 'internships'],
  ['项目经历', 'projects'],
  ['获奖', 'awards'],
  ['语言能力', 'languages'],
  ['自我评价', 'selfIntroduction'],
]);
const REPEATED = new Set<SectionKind>(['education', 'workExperiences', 'internships', 'projects', 'awards', 'languages']);

/** formily-item-<key> → 源字段。按分区区分：同一个 key（如 company）在实习和工作经历里含义不同。 */
const BINDINGS: Partial<Record<SectionKind, Record<string, string>>> = {
  personal: { name: 'fullName', email: 'email', age: 'age', gender: 'gender', current_city: 'currentCity' },
  preferences: { preferred_city_list: 'preferredCities' },
  education: { school: 'school', degree: 'degreeLevel', field_of_study: 'major' },
  internships: { company: 'company', title: 'title', position: 'title', desc: 'description', description: 'description' },
  workExperiences: { company: 'company', title: 'title', position: 'title', desc: 'description', description: 'description' },
  projects: { name: 'name', project_name: 'name', role: 'role', link: 'url', url: 'url', desc: 'description', description: 'description' },
  awards: { title: 'name', name: 'name', award_name: 'name', desc: 'description', description: 'description' },
  languages: { language: 'language', language_type: 'language', proficiency: 'proficiency', level: 'proficiency' },
};

function modules(document: Document): Array<{ root: Element; section: SectionKind }> {
  const out: Array<{ root: Element; section: SectionKind }> = [];
  for (const title of document.querySelectorAll<HTMLElement>('.applyFormModuleWrapper-left .applyFormModuleWrapper-text')) {
    const section = SECTION_NAMES.get(normalizeText(title.textContent ?? ''));
    const root = title.closest('.applyFormModuleWrapper-left')?.parentElement ?? null;
    if (section && root) out.push({ root, section });
  }
  return out;
}

function cards(root: Element): Element[] {
  return [...root.querySelectorAll<HTMLElement>('[class*="apply-form-array-card__"]')]
    .filter((card) => card.querySelector('input, textarea, [role="combobox"]'));
}

function itemKey(element: Element): string {
  const item = element.closest<HTMLElement>('[id^="formily-item-"]');
  return item ? item.id.slice('formily-item-'.length) : '';
}

function commonAncestor(elements: Element[]): Element | null {
  if (elements.length === 0) return null;
  let node: Element | null = elements[0]!;
  while (node && !elements.every((element) => node!.contains(element))) node = node.parentElement;
  return node;
}

export const feishuFormilyAdapter: SiteAdapter = {
  id: 'feishu-jobs-formily',
  version: 1,
  matches(context: AdapterContext): boolean {
    const hasForm = context.document.querySelector('.applyFormModuleWrapper-left') !== null &&
      context.document.querySelector('[id^="formily-item-"].ud-formily-item') !== null;
    if (!hasForm) return false;
    const fixture = FIXTURE_ORIGINS.has(context.origin) &&
      context.document.querySelector('meta[name="applykit-feishu-formily-fixture"][content="true"]') !== null;
    return fixture || /^https:\/\/([a-z0-9-]+\.)*jobs\.feishu\.cn$/i.test(context.origin);
  },
  scanRoot(document: Document): ParentNode | null {
    return commonAncestor(modules(document).map((item) => item.root));
  },
  sectionHints(document: Document): SectionHint[] {
    const hints: SectionHint[] = [];
    for (const item of modules(document)) {
      hints.push({ root: item.root, section: item.section });
      if (!REPEATED.has(item.section)) continue;
      for (const root of cards(item.root)) hints.push({ root, section: item.section, isRecord: true });
    }
    return hints;
  },
  bindField(descriptor: FieldDescriptor, element: Element): FieldBinding | null {
    const field = BINDINGS[descriptor.section]?.[itemKey(element)];
    if (field) return { section: descriptor.section as KnownSection, field };
    if (descriptor.normalizedLabel === '没有工作经历') return { section: 'personal', field: 'noWorkExperience' };
    return null;
  },
  orderFallbackSections(): SectionKind[] {
    return [...REPEATED];
  },
  /** ud 下拉的选项挂在页面最外层（portal）：同一时间只会有一个展开的下拉 */
  getSelectPopup(element: Element): Element | null {
    if (!element.closest('.ud__select')) return null;
    const open = [...element.ownerDocument.querySelectorAll<HTMLElement>('.ud__select__dropdown')].filter(isVisible);
    return open.length === 1 ? open[0]! : null;
  },
  getAddRecordAction(section: SectionKind, root: Element): VerifiedAddAction | null {
    if (!REPEATED.has(section)) return null;
    // 分区里文字为「添加」的按钮：空分区只有一个；已有卡片时每张卡片底部各有一个，取最后一个（加在末尾）。
    const buttons = [...root.querySelectorAll<HTMLElement>('button.ud__button')]
      .filter(isVisible)
      .filter((button) => normalizeLabel(button.textContent ?? '') === '添加');
    const button = buttons.at(-1);
    return button ? { section, sectionInstanceId: '', label: '添加', button } : null;
  },
};
