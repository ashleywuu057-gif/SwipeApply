import type { JobCandidate, SectionKind } from '../../shared/types';
import { jobCandidateFromHeuristic, jobCandidateFromJsonLd } from '../job-posting';
import type { AdapterContext, SiteAdapter } from './types';

/** 通用模式：只用公开的页面结构，不猜测任何站点专用行为。 */
export const genericAdapter: SiteAdapter = {
  id: 'generic',
  version: 1,
  matches(_context: AdapterContext): boolean {
    return true;
  },
  orderFallbackSections(): SectionKind[] {
    // 通用模式不默认第一行就是硕士，也不按下标绑定任何经历。
    return [];
  },
  getJobCandidate(document: Document): JobCandidate | null {
    return jobCandidateFromJsonLd(document) ?? jobCandidateFromHeuristic(document);
  },
  getAddRecordAction(): null {
    // 通用模式不自行寻找任意「添加」按钮。
    return null;
  },
};
