import { normalizeLabel, normalizeText } from '../../shared/normalize';
import type { FieldDescriptor, JobCandidate, SectionKind } from '../../shared/types';
import { extractJobId, sanitizeUrl } from '../../shared/urls';
import { isVisible } from '../dom-utils';
import type { AdapterContext, FieldBinding, SectionHint, SiteAdapter, VerifiedAddAction } from './types';

/** 北森招聘云（zhiye.com）Phoenix 表单。不同公司只会更换主题与动态类名。 */

const FIXTURE_ORIGINS = new Set(['http://127.0.0.1:4173', 'http://localhost:4173']);
const SECTION_NAMES = new Map<string, SectionKind>([
  ['投递意向', 'preferences'],
  ['个人信息', 'personal'],
  ['求职意向', 'preferences'],
  ['教育经历', 'education'],
  ['实习经历', 'internships'],
  ['在校实践', 'projects'],
  ['获奖情况', 'awards'],
  ['论文/专著', 'publications'],
  ['证书', 'certificates'],
]);
const REPEATED = new Set<SectionKind>(['education', 'internships', 'projects', 'awards', 'publications', 'certificates']);

function sectionRoots(document: Document): Array<{ root: Element; section: SectionKind }> {
  const roots: Array<{ root: Element; section: SectionKind }> = [];
  for (const candidate of document.querySelectorAll<HTMLElement>('div')) {
    if (candidate.children.length > 0) continue;
    const section = SECTION_NAMES.get(normalizeText(candidate.textContent ?? ''));
    const root = candidate.parentElement;
    if (!section || !root || root.querySelectorAll('input, textarea, select').length === 0) continue;
    roots.push({ root, section });
  }
  return roots;
}

function commonAncestor(elements: Element[]): Element | null {
  if (elements.length === 0) return null;
  let node: Element | null = elements[0]!;
  while (node && !elements.every((element) => node!.contains(element))) node = node.parentElement;
  return node;
}

function recordRoots(sectionRoot: Element): Element[] {
  const body = [...sectionRoot.children].find((child) => child.querySelector('input, textarea, select'));
  if (!body) return [];

  const directControlWrappers = [...body.children]
    .filter((child) => child.querySelector('input, textarea, select'));
  if (directControlWrappers.length > 1) {
    // 北森新增记录后会把每条记录放进 body 的独立直属 wrapper；最后一个
    // wrapper 还同时包含“添加”入口。取每个 wrapper 内唯一的字段容器。
    return directControlWrappers.flatMap((wrapper) => {
      const candidates = [...wrapper.children]
        .filter((child) => child.querySelector('input, textarea, select'));
      return candidates.length === 1 ? candidates : [];
    });
  }

  // 初始页和回归夹具会把所有记录与“添加”入口放在同一个 wrapper。
  const wrapper = directControlWrappers[0];
  return wrapper
    ? [...wrapper.children].filter((child) => child.querySelector('input, textarea, select'))
    : [];
}

function visiblePhoenixPopup(document: Document, selector: string): Element | null {
  const matches = [...document.querySelectorAll<HTMLElement>('.common-unmodeled-layer')]
    .filter(isVisible)
    .filter((layer) => layer.querySelector(selector));
  return matches.length === 1 ? matches[0]! : null;
}

const BINDINGS = new Map<string, FieldBinding>([
  ['意向工作地点', { section: 'preferences', field: 'primaryPreferredCity' }],
  ['期望工作城市', { section: 'preferences', field: 'primaryPreferredCity' }],
  ['到岗时间', { section: 'preferences', field: 'availabilityText' }],
  ['其他意向城市1', { section: 'preferences', field: 'secondaryPreferredCity1' }],
  ['其他意向城市2', { section: 'preferences', field: 'secondaryPreferredCity2' }],
  ['擅长的开发语言1', { section: 'preferences', field: 'primaryDevelopmentLanguage' }],
  ['擅长的其他开发语言2', { section: 'preferences', field: 'secondaryDevelopmentLanguage' }],
  ['是否接受工作城市调剂', { section: 'preferences', field: 'acceptsRelocation' }],
  ['国籍/地区', { section: 'personal', field: 'nationality' }],
  ['籍贯', { section: 'personal', field: 'nativePlace' }],
  ['生源地', { section: 'personal', field: 'nativePlace' }],
  ['现居住地', { section: 'personal', field: 'currentCity' }],
  ['学习形式', { section: 'personal', field: 'highestEducationType' }],
  ['毕业时间', { section: 'personal', field: 'highestEducationEndDate' }],
  ['英语等级', { section: 'personal', field: 'englishLevel' }],
  ['英语等级成绩', { section: 'personal', field: 'englishScore' }],
  ['微信号', { section: 'personal', field: 'wechat' }],
  ['证件号码', { section: 'personal', field: 'identityNumber' }],
  ['身份证号码', { section: 'personal', field: 'identityNumber' }],
  ['身份证号', { section: 'personal', field: 'identityNumber' }],
  ['紧急联系人', { section: 'personal', field: 'emergencyContactName' }],
  ['紧急联系人姓名', { section: 'personal', field: 'emergencyContactName' }],
  ['紧急联系电话', { section: 'personal', field: 'emergencyContactPhone' }],
  ['紧急联系人电话', { section: 'personal', field: 'emergencyContactPhone' }],
  ['紧急联系人手机号', { section: 'personal', field: 'emergencyContactPhone' }],
  ['与紧急联系人关系', { section: 'personal', field: 'emergencyContactRelation' }],
  ['紧急联系人关系', { section: 'personal', field: 'emergencyContactRelation' }],
  ['学院名称', { section: 'education', field: 'department' }],
  ['是否为最高学历', { section: 'education', field: 'isHighestDegree' }],
  ['学历类型', { section: 'education', field: 'educationType' }],
  ['专业排名', { section: 'education', field: 'majorRanking' }],
  ['实验室', { section: 'education', field: 'lab' }],
  ['研究方向', { section: 'education', field: 'researchDirection' }],
  ['课题研究', { section: 'education', field: 'researchDirection' }],
  ['成绩(GPA)', { section: 'education', field: 'gpa' }],
  ['导师', { section: 'education', field: 'advisor' }],
  ['学号', { section: 'education', field: 'studentNumber' }],
  ['实践名称', { section: 'projects', field: 'name' }],
  ['职务', { section: 'projects', field: 'role' }],
  ['实践描述', { section: 'projects', field: 'description' }],
  ['项目成果', { section: 'projects', field: 'description' }],
  ['获奖项', { section: 'awards', field: 'name' }],
  ['获奖描述', { section: 'awards', field: 'description' }],
  ['名称', { section: 'publications', field: 'name' }],
  ['发布时间', { section: 'publications', field: 'publishedAt' }],
  ['成果描述', { section: 'publications', field: 'description' }],
  ['证书名称', { section: 'certificates', field: 'name' }],
  ['获得时间', { section: 'certificates', field: 'obtainedAt' }],
  ['证书描述', { section: 'certificates', field: 'description' }],
]);

/**
 * 北森的地点字段并不共用一种控件：
 * - 现居住地 / 籍贯是带搜索、已选区和确定按钮的省市弹窗；
 * - 意向工作地点 / 其他意向城市是普通 Phoenix 下拉。
 *
 * 只把前者送进 area-picker 执行器，后者由普通下拉精确匹配。
 */
const AREA_PICKER_LABEL = /^(?:现居住地|籍贯|生源地)$/;
const DAY_PICKER_LABEL = /^(?:出生日期|获奖时间|发布时间|获得时间|论文发表日期|证书获取日期)$/;
const MONTH_PICKER_LABEL = /^(?:开始时间|结束时间|起始时间|入学时间|预计毕业时间|工作开始时间|工作结束时间|实习开始时间|实习结束时间|项目开始时间|项目结束时间)$/;

function jobCandidate(document: Document): JobCandidate | null {
  const roleElement = [...document.querySelectorAll<HTMLElement>('div, span, p')]
    .find((element) => element.children.length === 0 && /^你正在投递职位\s*[:：]/.test(normalizeText(element.textContent ?? '')));
  const role = normalizeText(roleElement?.textContent ?? '').replace(/^你正在投递职位\s*[:：]\s*/, '');
  if (!role) return null;
  return {
    company: null,
    role: role.slice(0, 200),
    location: null,
    externalJobId: extractJobId(document.location.href),
    sourceUrl: sanitizeUrl(document.location.href),
    evidence: 'adapter',
  };
}

export const beisenAdapter: SiteAdapter = {
  id: 'beisen-zhiye-phoenix',
  version: 1,
  matches(context: AdapterContext): boolean {
    const fixture = FIXTURE_ORIGINS.has(context.origin) &&
      context.document.querySelector('meta[name="applykit-beisen-fixture"][content="true"]') !== null;
    if (fixture) return true;
    return /^https:\/\/([a-z0-9-]+\.)*zhiye\.com$/i.test(context.origin) &&
      context.document.querySelector('.form-item--phoenix, .phoenix-select') !== null;
  },
  scanRoot(document: Document): ParentNode | null {
    return commonAncestor(sectionRoots(document).map((item) => item.root));
  },
  sectionHints(document: Document): SectionHint[] {
    const hints: SectionHint[] = [];
    for (const item of sectionRoots(document)) {
      hints.push({ root: item.root, section: item.section });
      if (!REPEATED.has(item.section)) continue;
      for (const root of recordRoots(item.root)) hints.push({ root, section: item.section, isRecord: true });
    }
    return hints;
  },
  bindField(descriptor: FieldDescriptor, element: Element): FieldBinding | null {
    if (descriptor.normalizedLabel === '期望工作城市' && element.closest('.phoenix-select--multi')) {
      return { section: 'preferences', field: 'preferredCities' };
    }
    const binding = BINDINGS.get(descriptor.normalizedLabel);
    if (binding?.section === descriptor.section) return binding;
    if (descriptor.controlKind === 'checkbox' && /至今$/.test(descriptor.normalizedLabel)) {
      if (descriptor.section === 'projects' || descriptor.section === 'internships') {
        return { section: descriptor.section, field: 'endDate' };
      }
    }
    return null;
  },
  orderFallbackSections(): SectionKind[] {
    return [...REPEATED];
  },
  getAddRecordAction(section: SectionKind, root: Element): VerifiedAddAction | null {
    if (!REPEATED.has(section)) return null;
    const candidates = [...root.querySelectorAll<HTMLElement>('[id$="_addButton"]')]
      .filter(isVisible)
      .filter((element) => normalizeLabel(element.textContent ?? '').startsWith('添加'));
    if (candidates.length !== 1) return null;
    return { section, sectionInstanceId: '', label: normalizeText(candidates[0]!.textContent ?? ''), button: candidates[0]! };
  },
  datePickerKind(element: Element): 'beisen-phoenix-month' | 'beisen-phoenix-day' | null {
    if (!(element instanceof HTMLInputElement) || !element.closest('.phoenix-select')) return null;
    const label = normalizeLabel(element.closest('.form-item')?.querySelector('.form-item__text')?.textContent ?? '');
    if (DAY_PICKER_LABEL.test(label)) return 'beisen-phoenix-day';
    if (label === '毕业时间') {
      const section = sectionRoots(element.ownerDocument).find((item) => item.root.contains(element))?.section;
      return section === 'personal' ? 'beisen-phoenix-day' : 'beisen-phoenix-month';
    }
    return MONTH_PICKER_LABEL.test(label) ? 'beisen-phoenix-month' : null;
  },
  areaPickerKind(element: Element): 'beisen-phoenix-area' | 'beisen-phoenix-area-multi' | null {
    if (!(element instanceof HTMLInputElement) || !element.closest('.phoenix-select')) return null;
    const label = normalizeLabel(element.closest('.form-item')?.querySelector('.form-item__text')?.textContent ?? '');
    if (label === '期望工作城市' && element.closest('.phoenix-select--multi')) {
      return 'beisen-phoenix-area-multi';
    }
    return AREA_PICKER_LABEL.test(label) ? 'beisen-phoenix-area' : null;
  },
  getSelectPopup(element: Element): Element | null {
    if (!element.closest('.phoenix-select, .phoenix-auto-complete-container')) return null;
    return visiblePhoenixPopup(element.ownerDocument, '.phoenix-selectList, [class*="auto-complete"]');
  },
  getJobCandidate(document: Document): JobCandidate | null {
    return jobCandidate(document);
  },
};
