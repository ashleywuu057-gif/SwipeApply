import { normalizeText } from '../../shared/normalize';
import type { JobCandidate, SectionKind } from '../../shared/types';
import { isVisible } from '../dom-utils';
import { jobCandidateFromJsonLd } from '../job-posting';
import type { AdapterContext, SiteAdapter, VerifiedAddAction } from './types';

/**
 * 本地演示适配器。只匹配 loopback 演示页面及页面自己声明的标识，
 * 只读取 DOM 中真实存在的分区属性，不读取任何测试答案。
 */

const DEMO_ORIGINS = new Set(['http://127.0.0.1:4173', 'http://localhost:4173']);

function demoPageId(document: Document): string | null {
  const meta = document.querySelector('meta[name="applykit-demo-page"]');
  const value = meta?.getAttribute('content') ?? '';
  return value.length > 0 && value.length < 40 ? value : null;
}

export const demoAdapter: SiteAdapter = {
  id: 'applykit-demo',
  version: 1,
  matches(context: AdapterContext): boolean {
    if (!DEMO_ORIGINS.has(context.origin)) return false;
    return demoPageId(context.document) !== null;
  },
  getJobCandidate(document: Document): JobCandidate | null {
    // 演示页面自己公开的 JobPosting JSON-LD，与真实站点同一套读取方式。
    return jobCandidateFromJsonLd(document);
  },
  orderFallbackSections(): SectionKind[] {
    // 演示页面的项目分区明确声明「按履历顺序」，其余分区仍需语义或身份匹配。
    return ['projects'];
  },
  getAddRecordAction(section: SectionKind, root: Element): VerifiedAddAction | null {
    if (section !== 'projects') return null;
    const button = root.querySelector<HTMLButtonElement>('button[data-applykit-add="projects"]');
    if (!button) return null;
    if (button.type !== 'button' || button.disabled || !isVisible(button)) return null;
    const label = normalizeText(button.textContent ?? '');
    if (!/新增|添加/.test(label)) return null;
    return { section, sectionInstanceId: '', label, button };
  },
};
