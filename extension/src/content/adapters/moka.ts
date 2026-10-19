import { normalizeText } from '../../shared/normalize';
import type { JobCandidate, SectionKind } from '../../shared/types';
import { isVisible } from '../dom-utils';
import { jobCandidateFromHeuristic, jobCandidateFromJsonLd } from '../job-posting';
import type { AdapterContext, SiteAdapter, VerifiedAddAction } from './types';

/**
 * Moka 校招简历页适配器。
 *
 * 只使用经过实页验证的结构特征：`apply-block-*` 分区、
 * `blockTitle-*` 标题、分区内唯一的 type=button 「添加」，以及
 * `day_info` 年月生日选择器。页面结构不符合时宁可不操作。
 */

const MOKA_ORIGINS = new Set(['https://app.mokahr.com']);
const DEMO_ORIGINS = new Set(['http://127.0.0.1:4173', 'http://localhost:4173']);
const REPEATED: SectionKind[] = [
  'education', 'workExperiences', 'internships', 'projects', 'languages', 'awards',
];

function exactlyOneAddButton(root: Element): HTMLButtonElement | null {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button[type="button"]')]
    .filter((button) => isVisible(button) && !button.disabled)
    .filter((button) => /^(?:)?\s*(?:新增|添加)$/.test(normalizeText(button.textContent ?? '')));
  return buttons.length === 1 ? buttons[0]! : null;
}

export const mokaAdapter: SiteAdapter = {
  id: 'moka-campus-resume',
  version: 1,
  matches(context: AdapterContext): boolean {
    const isFixture = DEMO_ORIGINS.has(context.origin) &&
      context.document.querySelector('meta[name="applykit-moka-fixture"][content="true"]') !== null;
    if (!MOKA_ORIGINS.has(context.origin) && !isFixture) return false;
    if (isFixture) return true;
    return /\/(?:campus_)?apply\//.test(context.pathname) || /candidateHome\/resume/.test(context.document.location.hash);
  },
  orderFallbackSections(): SectionKind[] {
    // Moka 的「添加」只在分区末尾追加空白记录，所以履历顺序是可验证的绑定依据。
    return [...REPEATED];
  },
  getAddRecordAction(section: SectionKind, root: Element): VerifiedAddAction | null {
    if (!REPEATED.includes(section)) return null;
    if (!String(root.className || '').includes('apply-block-')) return null;
    const button = exactlyOneAddButton(root);
    if (!button) return null;
    return { section, sectionInstanceId: '', label: normalizeText(button.textContent ?? ''), button };
  },
  datePickerKind(element: Element): 'moka-month' | null {
    if (!(element instanceof HTMLInputElement) || !element.readOnly) return null;
    const label = element.closest('label');
    const dropdown = element.closest('[class*="Dropdown-container"]');
    return label?.classList.contains('day_info') && dropdown ? 'moka-month' : null;
  },
  customSelectFallback(element: Element): 'moka-school' | 'moka-major' | null {
    if (!(element instanceof HTMLInputElement)) return null;
    const placeholder = normalizeText(element.placeholder);
    if (placeholder === '请输入就读学校') return 'moka-school';
    if (placeholder === '请输入专业名称') return 'moka-major';
    return null;
  },
  getJobCandidate(document: Document): JobCandidate | null {
    return jobCandidateFromJsonLd(document) ?? jobCandidateFromHeuristic(document);
  },
};
