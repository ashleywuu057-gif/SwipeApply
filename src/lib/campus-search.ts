import "server-only";

/**
 * 到公司校招官网按关键词找具体岗位。目前支持飞书招聘（包括字节）：它的官网背后有公开的职位搜索接口，
 * 和在官网搜索框里搜是一样的，拿到的是真实的岗位和详情页地址。
 * 其他招聘系统（北森、Moka 等）以后在这里加；找不到的由你在官网自己搜，再把岗位链接贴回岗位库。
 */

export interface CampusJob {
  title: string;
  url: string; // 岗位详情页
  location?: string;
}

const MAX_PER_COMPANY = 5;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

export const isFeishuSite = (url: string) => /\.jobs\.feishu\.cn|jobs\.bytedance\.com/i.test(url);

/** 飞书招聘的站点：短链接（/s/xxxx）先跳转，拿到真实的站点路径（例如 /campus） */
async function feishuTarget(url: string): Promise<{ origin: string; path: string } | undefined> {
  let u = url;
  if (/\/s\/[\w-]+/.test(u)) {
    try {
      const res = await fetch(u, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(10000) });
      res.body?.cancel().catch(() => undefined);
      u = res.url;
    } catch {}
  }
  const m = u.match(/^(https?:\/\/(?:[a-z0-9-]+\.jobs\.feishu\.cn|jobs\.bytedance\.com))(?:\/([a-z0-9_-]+))?/i);
  if (!m) return undefined;
  const path = m[2] && m[2] !== "s" ? m[2] : "campus";
  return { origin: m[1], path };
}

/** 在飞书招聘的官网里按关键词搜校招正式岗位（不要实习、社招） */
export async function feishuJobs(siteUrl: string, keywords: string[]): Promise<CampusJob[]> {
  const t = await feishuTarget(siteUrl);
  if (!t) return [];
  const headers: Record<string, string> = { "User-Agent": UA, "Content-Type": "application/json", "website-path": t.path };
  const tr = await fetch(`${t.origin}/api/v1/csrf/token`, { method: "POST", headers, body: JSON.stringify({ portal_entrance: 1 }), signal: AbortSignal.timeout(10000) });
  const cookies = tr.headers.getSetCookie().map((c) => c.split(";")[0]);
  const token = decodeURIComponent(cookies.find((c) => c.startsWith("atsx-csrf-token="))?.split("=")[1] ?? "");
  const out = new Map<string, CampusJob>();
  for (const keyword of keywords) {
    const res = await fetch(`${t.origin}/api/v1/search/job/posts`, {
      method: "POST",
      headers: { ...headers, "x-csrf-token": token, Cookie: cookies.join("; ") },
      body: JSON.stringify({ keyword, limit: 10, offset: 0, job_category_id_list: [], location_code_list: [], subject_id_list: [], recruitment_id_list: [], portal_type: 3, portal_entrance: 1 }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) continue;
    const list = ((await res.json())?.data?.job_post_list ?? []) as {
      id: string;
      title: string;
      recruit_type?: { name?: string; parent?: { name?: string } };
      city_info?: { name?: string };
      city_list?: { name?: string }[];
    }[];
    for (const j of list) {
      if (j.recruit_type?.parent?.name && j.recruit_type.parent.name !== "校招") continue;
      if (j.recruit_type?.name && /实习/.test(j.recruit_type.name)) continue;
      if (/实习/.test(j.title) && !/全职|校招/.test(j.title)) continue; // 有的公司不标招聘类型，看岗位名
      if (!keywords.some((k) => j.title.includes(k))) continue; // 接口会模糊匹配，岗位名里要真有关键词
      const url = `${t.origin}/${t.path}/position/${j.id}/detail`;
      out.set(url, {
        title: j.title,
        url,
        location: (j.city_list?.map((c) => c.name).filter(Boolean) as string[] | undefined)?.join("、") || j.city_info?.name,
      });
    }
    if (out.size >= MAX_PER_COMPANY) break;
  }
  return [...out.values()].slice(0, MAX_PER_COMPANY);
}

/* ---------------- 简历关键词 ---------------- */

// 从经历卡片的岗位名里取关键词，按出现次数排序
const KEYWORD_DICT = ["商业化", "AI产品", "策略产品", "产品经理", "战略", "增长", "数据分析", "运营", "咨询", "营销", "行业研究", "市场", "管培"];

export function resumeKeywords(roles: string[], max = 3): string[] {
  const count = new Map<string, number>();
  for (const r of roles) for (const k of KEYWORD_DICT) if (r.toLowerCase().includes(k.toLowerCase())) count.set(k, (count.get(k) ?? 0) + 1);
  const top = [...count.entries()].sort((a, b) => b[1] - a[1] || KEYWORD_DICT.indexOf(a[0]) - KEYWORD_DICT.indexOf(b[0])).slice(0, max).map(([k]) => k);
  return top.length ? top : ["产品经理"];
}
