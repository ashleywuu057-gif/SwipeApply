import { collapseWhitespace } from '../shared/normalize';
import type { JobCandidate } from '../shared/types';
import { sanitizeUrl, extractJobId } from '../shared/urls';

/** 岗位候选提取：JSON-LD 只解析为数据，限制大小与嵌套，禁止执行其中的字符串。 */

const MAX_JSON_LD_BYTES = 200_000;
const MAX_DEPTH = 8;

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // 公司名与岗位名按原样保存，只折叠空白，不做全角/半角转换。
  const text = collapseWhitespace(value);
  return text.length > 0 && text.length <= 200 ? text : null;
}

function findJobPosting(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 50)) {
      const found = findJobPosting(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  const type = record['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return record;
  for (const value of Object.values(record).slice(0, 50)) {
    const found = findJobPosting(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function readOrganization(value: unknown): string | null {
  if (typeof value === 'string') return readString(value);
  if (value && typeof value === 'object') {
    return readString((value as Record<string, unknown>)['name']);
  }
  return null;
}

function readLocation(value: unknown): string | null {
  if (typeof value === 'string') return readString(value);
  if (Array.isArray(value)) return readLocation(value[0]);
  if (value && typeof value === 'object') {
    const address = (value as Record<string, unknown>)['address'];
    if (typeof address === 'string') return readString(address);
    if (address && typeof address === 'object') {
      const locality = readString((address as Record<string, unknown>)['addressLocality']);
      const region = readString((address as Record<string, unknown>)['addressRegion']);
      return locality ?? region;
    }
    return readString((value as Record<string, unknown>)['name']);
  }
  return null;
}

function readIdentifier(value: unknown): string | null {
  if (typeof value === 'string') return readString(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const raw = record['value'];
    if (typeof raw === 'string' || typeof raw === 'number') return readString(String(raw));
  }
  return null;
}

export function jobCandidateFromJsonLd(document: Document): JobCandidate | null {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent ?? '';
    if (raw.length === 0 || raw.length > MAX_JSON_LD_BYTES) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const posting = findJobPosting(parsed);
    if (!posting) continue;
    const role = readString(posting['title']);
    const company = readOrganization(posting['hiringOrganization']);
    const location = readLocation(posting['jobLocation']);
    const identifier = readIdentifier(posting['identifier']);
    if (!role && !company) continue;
    return {
      company,
      role,
      location,
      externalJobId: identifier ?? extractJobId(document.location.href),
      sourceUrl: sanitizeUrl(document.location.href),
      evidence: 'json-ld',
    };
  }
  return null;
}

/** 页面标题里像岗位名的部分，用来判断标题的哪一半是岗位、哪一半是公司。 */
const ROLE_HINT = /(工程师|实习生|开发|研发|经理|专员|助理|顾问|设计师|分析师|架构师|科学家|研究员|主管|总监|策划|编辑|销售|运营|产品|测试|讲师|培训生|管培生|intern|engineer|developer|manager|analyst|designer|scientist)/i;

/**
 * 保守启发式：只有当标题的某一半明显像岗位名时才给候选。
 *
 * 「搜狐 - 校园招聘」这种标题两边都不是岗位名，宁可不给候选，
 * 也不要把「校园招聘」当成公司、把「搜狐」当成岗位交给用户核对。
 */
export function jobCandidateFromHeuristic(document: Document): JobCandidate | null {
  const title = collapseWhitespace(document.title);
  if (!title) return null;
  const separators = [' - ', ' | ', ' — ', '｜', '－', ' _ '];
  for (const separator of separators) {
    const index = title.indexOf(separator);
    if (index <= 0) continue;
    const left = collapseWhitespace(title.slice(0, index));
    const right = collapseWhitespace(title.slice(index + separator.length));
    if (left.length < 2 || right.length < 2 || left.length > 100 || right.length > 100) continue;

    // 只有一边像岗位名时才能确定谁是岗位、谁是公司；两边都像或都不像就放弃。
    const leftIsRole = ROLE_HINT.test(left);
    const rightIsRole = ROLE_HINT.test(right);
    if (leftIsRole === rightIsRole) continue;

    return {
      company: leftIsRole ? right : left,
      role: leftIsRole ? left : right,
      location: null,
      externalJobId: extractJobId(document.location.href),
      sourceUrl: sanitizeUrl(document.location.href),
      evidence: 'heuristic',
    };
  }
  return null;
}
