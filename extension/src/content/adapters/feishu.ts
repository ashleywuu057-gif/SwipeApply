import { normalizeLabel, normalizeText } from '../../shared/normalize';
import type { FieldDescriptor, JobCandidate, KnownSection, SectionKind } from '../../shared/types';
import { extractJobId, sanitizeUrl } from '../../shared/urls';
import { isVisible } from '../dom-utils';
import type { AdapterContext, FieldBinding, SectionHint, SiteAdapter, VerifiedAddAction } from './types';

/** 飞书招聘 ATS（jobs.feishu.cn）。租户只改变子域名与主题，表单控件沿用 atsx-* 结构。 */

const FIXTURE_ORIGINS = new Set(['http://127.0.0.1:4173', 'http://localhost:4173']);
const SECTION_NAMES = new Map<string, SectionKind>([
  ['申请信息', 'preferences'],
  ['基础信息', 'personal'],
  ['教育经历', 'education'],
  ['工作经历', 'workExperiences'],
  ['实习经历', 'internships'],
  ['项目经历', 'projects'],
  ['获奖', 'awards'],
  ['语言能力', 'languages'],
  ['自我评价', 'selfIntroduction'],
]);
const REPEATED = new Set<SectionKind>([
  'education', 'workExperiences', 'internships', 'projects', 'awards', 'languages',
]);

function sectionRoots(document: Document): Array<{ root: Element; section: SectionKind }> {
  const roots: Array<{ root: Element; section: SectionKind }> = [];
  for (const title of document.querySelectorAll<HTMLElement>('.createFormSection-title')) {
    const section = SECTION_NAMES.get(normalizeText(title.textContent ?? ''));
    const left = title.closest('.createFormSection-left');
    const root = left?.parentElement ?? null;
    if (!section || !root) continue;
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

function recordRoots(root: Element): Element[] {
  return [...root.querySelectorAll<HTMLElement>('.createFormSection-formList > .resumeEditForm-item')]
    .filter((record) => record.querySelector('input, textarea, select, [role="combobox"]'));
}

function fieldIdOf(element: Element): string {
  return element.id || element.closest<HTMLElement>('.atsx-select[id]')?.id || '';
}

function repeatedBinding(section: SectionKind, id: string): FieldBinding | null {
  const patterns: Array<[RegExp, KnownSection, string]> = [
    [/^education\[\d+\]\.school$/, 'education', 'school'],
    [/^education\[\d+\]\.degree$/, 'education', 'degreeLevel'],
    [/^education\[\d+\]\.fieldOfStudy$/, 'education', 'major'],
    [/^career\[\d+\]\.company$/, 'workExperiences', 'company'],
    [/^career\[\d+\]\.title$/, 'workExperiences', 'title'],
    [/^career\[\d+\]\.desc$/, 'workExperiences', 'description'],
    [/^internship\[\d+\]\.company$/, 'internships', 'company'],
    [/^internship\[\d+\]\.title$/, 'internships', 'title'],
    [/^internship\[\d+\]\.desc$/, 'internships', 'description'],
    [/^project\[\d+\]\.name$/, 'projects', 'name'],
    [/^project\[\d+\]\.role$/, 'projects', 'role'],
    [/^project\[\d+\]\.link$/, 'projects', 'url'],
    [/^project\[\d+\]\.desc$/, 'projects', 'description'],
    [/^award\[\d+\]\.title$/, 'awards', 'name'],
    [/^award\[\d+\]\.desc$/, 'awards', 'description'],
    [/^language\[\d+\]\.language$/, 'languages', 'language'],
    [/^language\[\d+\]\.proficiency$/, 'languages', 'proficiency'],
  ];
  for (const [pattern, expectedSection, field] of patterns) {
    if (section === expectedSection && pattern.test(id)) return { section: expectedSection, field };
  }
  return null;
}

function visiblePopupFor(element: Element): Element | null {
  const combobox = element.matches('[role="combobox"]')
    ? element
    : element.closest('[role="combobox"]');
  const controls = combobox?.getAttribute('aria-controls') ?? combobox?.getAttribute('aria-owns');
  if (controls) {
    const ids = controls.split(/\s+/).filter(Boolean);
    if (ids.length === 1) {
      const target = element.ownerDocument.getElementById(ids[0]!);
      const popup = target?.closest('.atsx-select-dropdown') ?? target;
      if (popup && isVisible(popup)) return popup;
    }
  }
  const visible = [...element.ownerDocument.querySelectorAll<HTMLElement>('.atsx-select-dropdown')]
    .filter(isVisible);
  return visible.length === 1 ? visible[0]! : null;
}

function candidate(document: Document): JobCandidate | null {
  const role = normalizeText(document.querySelector('.resumeEditForm-header')?.textContent ?? '');
  if (!role) return null;
  const titleCompany = normalizeText(document.title)
    .replace(/^投递简历\s*[-–—]\s*/u, '')
    .replace(/内推$/u, '')
    .trim();
  return {
    company: titleCompany || null,
    role: role.slice(0, 200),
    location: null,
    externalJobId: extractJobId(document.location.href),
    sourceUrl: sanitizeUrl(document.location.href),
    evidence: 'adapter',
  };
}

export const feishuAdapter: SiteAdapter = {
  id: 'feishu-jobs-atsx',
  version: 1,
  matches(context: AdapterContext): boolean {
    const fixture = FIXTURE_ORIGINS.has(context.origin) &&
      context.document.querySelector('meta[name="applykit-feishu-fixture"][content="true"]') !== null;
    if (fixture) return true;
    return /^https:\/\/([a-z0-9-]+\.)*jobs\.feishu\.cn$/i.test(context.origin) &&
      context.document.querySelector('.resumeEditForm-wrapper .atsx-form-item') !== null;
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
    const id = fieldIdOf(element);
    const direct = new Map<string, FieldBinding>([
      ['application_preferred_city_list', { section: 'preferences', field: 'preferredCities' }],
      ['accept_transfer_preferred_city', { section: 'preferences', field: 'acceptsRelocation' }],
      ['name', { section: 'personal', field: 'fullName' }],
      ['email', { section: 'personal', field: 'email' }],
      ['age', { section: 'personal', field: 'age' }],
      ['gender', { section: 'personal', field: 'gender' }],
      ['current_city_code', { section: 'personal', field: 'currentCity' }],
      ['hometown_city_code', { section: 'personal', field: 'nativePlace' }],
    ]).get(id);
    if (direct && direct.section === descriptor.section) return direct;
    const repeated = repeatedBinding(descriptor.section, id);
    if (repeated) return repeated;
    // 该开关视觉上位于“工作经历”区，但它表达的是个人层面的派生值。
    if (descriptor.normalizedLabel === '没有工作经历') {
      return { section: 'personal', field: 'noWorkExperience' };
    }
    if (descriptor.datePart && ['education', 'workExperiences', 'internships', 'projects'].includes(descriptor.section)) {
      return {
        section: descriptor.section as 'education' | 'workExperiences' | 'internships' | 'projects',
        field: descriptor.datePart.edge === 'start' ? 'startDate' : 'endDate',
      };
    }
    if (descriptor.section === 'awards' && descriptor.normalizedLabel === '获奖时间') {
      return { section: 'awards', field: 'date' };
    }
    return null;
  },
  orderFallbackSections(): SectionKind[] {
    return [...REPEATED];
  },
  getAddRecordAction(section: SectionKind, root: Element): VerifiedAddAction | null {
    if (!REPEATED.has(section) && section !== 'selfIntroduction') return null;
    const candidates = [...root.querySelectorAll<HTMLElement>('.formOperate-addBtn, .createFormSection-addBtn')]
      .filter(isVisible)
      .filter((button) => normalizeLabel(button.textContent ?? '') === '添加');
    if (candidates.length !== 1) return null;
    return { section, sectionInstanceId: '', label: '添加', button: candidates[0]! };
  },
  datePickerKind(element: Element): 'feishu-period-month' | 'feishu-year' | null {
    if (element.closest('.atsx-date-picker-period-month')) return 'feishu-period-month';
    if (element instanceof HTMLInputElement && element.placeholder === 'YYYY' &&
        element.closest('.atsx-date-picker')) return 'feishu-year';
    return null;
  },
  areaPickerKind(element: Element): 'feishu-tree-area' | null {
    const id = fieldIdOf(element);
    return id === 'current_city_code' || id === 'hometown_city_code' ? 'feishu-tree-area' : null;
  },
  getSelectPopup(element: Element): Element | null {
    if (!element.closest('.atsx-select') && !element.matches('.atsx-select, [role="combobox"]')) return null;
    return visiblePopupFor(element);
  },
  getJobCandidate(document: Document): JobCandidate | null {
    return candidate(document);
  },
};
