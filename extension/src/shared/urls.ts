import { normalizeKeyPart } from './normalize';

/** URL 清洗、routeKey 与去重键。所有实现集中在这里，导入时可重算校验。 */

const SENSITIVE_PARAM_PATTERN = /(^|_|-)(token|session|sid|auth|code|secret|password|passwd|signature|sign|ticket|jwt|access|refresh|otp|nonce|state)(_|-|$)/i;
const SENSITIVE_PARAM_EXACT = new Set([
  'token', 'access_token', 'refresh_token', 'id_token', 'session', 'sessionid', 'sid',
  'auth', 'authorization', 'code', 'secret', 'password', 'pwd', 'signature', 'sign',
  'ticket', 'jwt', 'state', 'nonce', 'otp', 'key', 'apikey', 'api_key',
]);

/** 常见的岗位标识参数名；只有出现在这里或被适配器确认时才参与身份。 */
export const JOB_ID_PARAMS = ['jobid', 'job_id', 'jobcode', 'positionid', 'position_id', 'postid', 'requisitionid'];

export function isSensitiveParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_PARAM_EXACT.has(lower)) return true;
  return SENSITIVE_PARAM_PATTERN.test(lower);
}

export interface ParsedUrl {
  origin: string;
  pathname: string;
  hashRoute: string;
  params: Array<[string, string]>;
}

export function parseUrl(raw: string): ParsedUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // origin 已包含非默认端口；显式去掉 userinfo。
  const origin = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  const params: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => {
    if (!isSensitiveParam(key)) params.push([key, value]);
  });
  return { origin, pathname: url.pathname, hashRoute: extractHashRoute(url.hash), params };
}

/** hash 中具有路由意义的路径部分；令牌与查询串一律丢弃。 */
export function extractHashRoute(hash: string): string {
  if (!hash || hash === '#') return '';
  const body = hash.slice(1);
  const withoutQuery = body.split('?')[0] ?? '';
  if (!withoutQuery.startsWith('/')) return '';
  return withoutQuery.replace(/\/+$/, '');
}

/** 保存用的 sourceUrl：去 userinfo、去敏感查询参数、去无路由意义的 fragment。 */
export function sanitizeUrl(raw: string): string | null {
  const parsed = parseUrl(raw);
  if (!parsed) return null;
  const search = parsed.params.length > 0
    ? `?${parsed.params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
    : '';
  return `${parsed.origin}${parsed.pathname}${search}${parsed.hashRoute ? `#${parsed.hashRoute}` : ''}`;
}

export interface CanonicalOptions {
  /** 适配器已确认的岗位 ID 参数名，附加到默认列表。 */
  confirmedJobParams?: string[];
}

/** canonicalUrl：pathname + hash 路由 + 已确认的岗位 ID 参数，其他参数不参与身份。 */
export function buildCanonicalUrl(raw: string, options: CanonicalOptions = {}): string | null {
  const parsed = parseUrl(raw);
  if (!parsed) return null;
  const allowed = new Set([...JOB_ID_PARAMS, ...(options.confirmedJobParams ?? []).map((p) => p.toLowerCase())]);
  const kept = parsed.params
    .filter(([key]) => allowed.has(key.toLowerCase()))
    .sort((a, b) => a[0].localeCompare(b[0]));
  const search = kept.length > 0
    ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
    : '';
  return `${parsed.origin}${parsed.pathname}${search}${parsed.hashRoute ? `#${parsed.hashRoute}` : ''}`;
}

/** 从 URL 中读取岗位 ID；只认已知或适配器确认的参数名。 */
export function extractJobId(raw: string, options: CanonicalOptions = {}): string | null {
  const parsed = parseUrl(raw);
  if (!parsed) return null;
  const allowed = new Set([...JOB_ID_PARAMS, ...(options.confirmedJobParams ?? []).map((p) => p.toLowerCase())]);
  for (const [key, value] of parsed.params) {
    if (allowed.has(key.toLowerCase()) && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** routeKey 只保留 pathname 与有路由意义的 hash 路径，不含动态参数。 */
export function buildRouteKey(raw: string): string {
  const parsed = parseUrl(raw);
  if (!parsed) return '';
  return `${parsed.pathname}${parsed.hashRoute ? `#${parsed.hashRoute}` : ''}`;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export interface DedupeInput {
  company: string;
  role: string;
  location: string | null;
  canonicalUrl: string | null;
  externalJobId: string | null;
}

/** 去重键素材：有 externalJobId 时按 origin|job:<id>，否则按公司|岗位|地点|canonicalUrl。 */
export function dedupeMaterial(input: DedupeInput): string {
  if (input.externalJobId && input.externalJobId.trim().length > 0) {
    const origin = input.canonicalUrl ? (parseUrl(input.canonicalUrl)?.origin ?? '') : '';
    return `${origin}|job:${normalizeKeyPart(input.externalJobId)}`;
  }
  return [
    normalizeKeyPart(input.company),
    normalizeKeyPart(input.role),
    normalizeKeyPart(input.location),
    input.canonicalUrl ?? '',
  ].join('|');
}

export async function computeDedupeKey(input: DedupeInput): Promise<string> {
  return `sha256:${await sha256Hex(dedupeMaterial(input))}`;
}

/** 身份信息是否完整；不完整时 UI 需提示可能误判重复。 */
export function dedupeConfidence(input: DedupeInput): 'strong' | 'weak' {
  if (input.externalJobId && input.externalJobId.trim().length > 0) return 'strong';
  if (input.canonicalUrl) return 'strong';
  return 'weak';
}

/** 页面是否可以注入内容脚本；chrome:// 等受限页面明确提示。 */
export function isInjectablePage(rawUrl: string): { ok: true } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, message: '无法识别当前页面地址' };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return { ok: true };
  if (url.protocol === 'chrome:' || url.protocol === 'edge:' || url.protocol === 'about:') {
    return { ok: false, message: '浏览器内部页面不允许扩展填写，请切换到招聘网页' };
  }
  if (url.protocol === 'chrome-extension:') {
    return { ok: false, message: '这是扩展自己的页面，请切换到要填写的招聘网页' };
  }
  if (url.protocol === 'file:') {
    return { ok: false, message: '本地文件页面未获授权，请使用 http/https 页面' };
  }
  return { ok: false, message: `不支持的页面协议 ${url.protocol}` };
}
