import "server-only";
import "./free-proxy"; // 没填自己的 Key 时走免费额度（必须在读 LLM_* 配置之前）
import { newId } from "./store";
import { directionsOf, isOverseas, normCompany, parseDeadline } from "./tracker-logic";
import type { Application, Direction, JobPosting, Sector } from "./tracker-types";

/**
 * 联网搜索新开网申的岗位：单独用一个带联网搜索的模型（默认通义千问），和简历解析等功能用的模型分开配置。
 * 按「我的方向」逐个搜索，优先「我的行业」的公司，模型把搜到的招聘信息整理成岗位列表。
 *
 * 用 DashScope 原生接口（和 research/search.ts 一样）：enable_source 能拿到搜索结果的原始链接，
 * 模型写的 jdUrl / link 只保留出现在这个列表里的地址，免得模型自己拼链接。
 */
export const SEARCH_SOURCE = "联网搜索";

export function searchConfig() {
  const apiKey = process.env.SEARCH_LLM_API_KEY?.trim();
  const base = process.env.SEARCH_LLM_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  let origin = "https://dashscope.aliyuncs.com";
  try {
    origin = new URL(base).origin;
  } catch {}
  const model = process.env.SEARCH_LLM_MODEL?.trim() || "qwen-plus";
  return { enabled: Boolean(apiKey), apiKey, endpoint: `${origin}/api/v1/services/aigc/text-generation/generation`, model };
}

const MAX_DIRECTIONS = 4; // 每次最多搜几个方向，控制调用量

const PROMPT = (today: string, batch: string, direction: string, sectors: Sector[], exclude: string[]) => `今天是 ${today}。请联网搜索：目前正在开放网申的${batch}秋招 / 校园招聘中，「${direction}」方向的岗位。
${sectors.length ? `优先找这些行业的公司：${sectors.join("、")}。` : ""}${exclude.length ? `这些公司我已经投过，不要再列：${exclude.join("、")}。` : ""}优先找企业官方校招网站、官方公众号、牛客网等发布的招聘公告，只要截止时间还没过、现在能投递的。尽量找 10 家以上不同的公司。

只输出 JSON，不要其他文字：
{"jobs":[{"company":"公司名","title":"岗位名","location":"工作地点","deadline":"网申截止时间原文，没有写空字符串","jdUrl":"岗位详情页链接，找不到写空字符串","link":"网申入口链接","batch":"届别，例如 ${batch}秋招","industry":"行业","note":"内推码或其他备注，没有写空字符串"}]}

要求：
- 只写搜索结果里真实出现的信息，不要编造公司、岗位或链接
- jdUrl：这个岗位本身的详情页，页面上要能看到岗位职责和任职要求。例如 Moka、北森、飞书招聘的岗位详情地址、官网职位详情页、牛客网的职位页。找不到就写空字符串，不要用公司首页或招聘首页凑数
- link：网申入口，可以和 jdUrl 相同
- 链接必须是搜索结果里真实出现过的地址，不要自己拼接或猜测；必须是 http 或 https 开头的完整网址
- 一家公司的同类岗位可以合并成一条，岗位名写主要的那个`;

export async function searchJobs(myDirections: Direction[], mySectors: Sector[] = [], exclude: string[] = [], now = new Date()): Promise<JobPosting[]> {
  const cfg = searchConfig();
  if (!cfg.enabled) throw new Error("未配置 SEARCH_LLM_API_KEY");
  const directions = (myDirections.length ? myDirections : (["产品", "运营"] as Direction[])).slice(0, MAX_DIRECTIONS);
  const sectors = mySectors.filter((s) => s !== "其他");
  // 7 月以后找的是下一年毕业的秋招
  const batch = `${now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear()}届`;
  const today = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

  const jobs: JobPosting[] = [];
  const errors: string[] = [];
  for (const dir of directions) {
    try {
      jobs.push(...(await searchOne(PROMPT(today, batch, dir, sectors, exclude.slice(0, 100)), batch, now)));
    } catch (e) {
      errors.push(`${dir}：${(e as Error).message}`);
    }
  }
  if (!jobs.length && errors.length) throw new Error(errors.join("；"));
  // 第一次搜索的来源大多是汇总文章，很少直接带岗位详情页：没有 jdUrl 的，按公司 + 岗位名再搜一次
  const exclude2 = exclude.map(normCompany).filter((c) => c.length >= 2);
  const fresh = jobs.filter((j) => !j.jdUrl && !exclude2.some((x) => normCompany(j.company).includes(x) || x.includes(normCompany(j.company))));
  for (let i = 0; i < fresh.length; i += 4) {
    await Promise.all(
      fresh.slice(i, i + 4).map(async (j) => {
        const url = await findJdUrl(j.company, j.title).catch(() => "");
        if (url) j.jdUrl = url;
      }),
    );
  }
  return jobs;
}

const JOB_PAGE = /mokahr|zhiye|beisen|italent|hotjob|dayee|jobs\.feishu|feishu\.cn\/.*(job|position)|nowcoder\.com\/(jobs|job)|zhipin\.com\/job_detail|job_detail|position|\/jobs?\/|\/detail|jobid|job_id|postid/i;

/**
 * 找一个岗位的详情页：只从搜索结果的真实链接里挑——不是首页、像招聘系统或职位详情的地址、
 * 搜索结果标题里有公司名，打开后通过 linkAlive 的岗位详情页核对。找不到返回空字符串。
 */
async function findJdUrl(company: string, title: string): Promise<string> {
  const { hits } = await dashscope(`搜索：${company} ${title} 校招 岗位职责 任职要求
只需要搜索，回答"好"即可。`, { maxTokens: 16, strategy: "turbo" });
  const short = normCompany(company).slice(0, 2);
  const candidates = hits.filter((h) => !isHomepage(h.url) && JOB_PAGE.test(h.url) && short.length === 2 && `${h.title} ${h.site}`.includes(short)).slice(0, 3);
  for (const h of candidates) if (await linkAlive(h.url, title)) return h.url;
  return "";
}

/** DashScope 原生接口：返回模型的回答和搜索结果的原始链接 */
async function dashscope(prompt: string, opts: { maxTokens?: number; strategy?: "turbo" | "max" } = {}) {
  const cfg = searchConfig();
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      input: { messages: [{ role: "user", content: prompt }] },
      parameters: {
        temperature: 0,
        enable_search: true,
        search_options: { forced_search: true, enable_source: true, search_strategy: opts.strategy ?? "max" },
        result_format: "message",
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`搜索模型调用失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const content: string = json.output?.choices?.[0]?.message?.content ?? "";
  const hits = ((json.output?.search_info?.search_results ?? []) as Record<string, unknown>[])
    .filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url))
    .map((r) => ({ url: r.url as string, title: String(r.title ?? ""), site: String(r.site_name ?? "") }));
  return { content, hits };
}

/**
 * 模型偶尔会给出失效的链接：404、域名不存在、或者页面标题是"页面不存在"的丢掉；
 * 网站拒绝程序访问、超时的保留，免得误删。
 * 传了 jobTitle 时是核对岗位详情页：能打开的，页面里要出现岗位名的前 4 个字或"岗位职责 / 职位描述 / 任职要求"，
 * 否则判定不是这个岗位的详情页；页面几乎没有文字的（动态页面，后面会用浏览器再打开）保留。
 */
async function linkAlive(url: string, jobTitle?: string) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 jobprep" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404 || res.status === 410) {
      res.body?.cancel().catch(() => undefined);
      return false;
    }
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) {
      res.body?.cancel().catch(() => undefined);
      return true;
    }
    const html = await res.text();
    const title = html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? "";
    if (/页面不存在|页面找不到|找不到页面|不存在或已|已下线|已删除|404|not found/i.test(title)) return false;
    if (!jobTitle) return true;
    const text = html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|\s+/g, " ");
    if (text.replace(/\s/g, "").length < 200) return true;
    const key = jobTitle.replace(/\s/g, "").slice(0, 4);
    return (key.length >= 2 && `${title} ${text}`.includes(key)) || /岗位职责|职位描述|任职要求/.test(text);
  } catch (e) {
    const code = ((e as Error).cause as { code?: string } | undefined)?.code;
    return code !== "ENOTFOUND";
  }
}

/** 只是公司首页 / 招聘首页，而不是具体岗位页 */
export function isHomepage(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // 单页应用把岗位写在 # 后面（例如 /#/job/123），这种不算首页
  if (u.hash.replace(/^#\/?/, "").length > 2) return false;
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length === 0) return true;
  return segs.length === 1 && /^(index|home|default|campus|school|zhaopin|recruit|recruitment|career|careers|job|jobs|join|hr)(\.(s?html?|php|aspx?|jsp|do))?$/i.test(segs[0]);
}

/** 比较链接时去掉协议、www、末尾斜杠 */
const normUrl = (u: string) => u.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();

async function searchOne(prompt: string, batch: string, now: Date): Promise<JobPosting[]> {
  const { content, hits } = await dashscope(prompt);
  const sources = new Set(hits.map((h) => normUrl(h.url)));
  const inSources = (u: string) => Boolean(u) && sources.has(normUrl(u));
  const isUrl = (u: string) => /^https?:\/\/\S+$/.test(u);

  const rows = parseJobs(content)
    .map((r) => ({
      company: str(r.company),
      title: str(r.title),
      location: str(r.location),
      deadline: str(r.deadline),
      jdUrl: str(r.jdUrl),
      link: str(r.link),
      batch: str(r.batch) || `${batch}秋招`,
      industry: str(r.industry),
      note: str(r.note),
    }))
    .filter((r) => r.company && r.title);

  const checked = await Promise.all(
    rows.map(async (r) => {
      // jdUrl：必须在搜索结果里、不是首页、打开后像这个岗位的详情页
      let jdUrl = isUrl(r.jdUrl) && inSources(r.jdUrl) && !isHomepage(r.jdUrl) ? r.jdUrl : "";
      if (jdUrl && !(await linkAlive(jdUrl, r.title))) jdUrl = "";
      // link：在搜索结果里的直接用（首页也保留，它仍是网申入口）；不在的检查能不能打开
      let link = isUrl(r.link) && (inSources(r.link) || (await linkAlive(r.link))) ? r.link : "";
      if (!link) link = jdUrl; // 网申入口不可用时，岗位详情页通常也能投递
      return { ...r, jdUrl, link };
    }),
  );

  const at = now.toISOString();
  return checked
    .filter((r) => r.link)
    .map(({ jdUrl, ...r }) => ({
      id: newId(),
      ...r,
      ...(jdUrl ? { jdUrl } : {}),
      deadlineAt: r.deadline ? parseDeadline(r.deadline, now) : undefined,
      directions: directionsOf(r.title, r.note),
      overseas: isOverseas(r.title, r.note, r.location),
      source: SEARCH_SOURCE,
      starred: false,
      createdAt: at,
    }));
}

function parseJobs(s: string): Record<string, unknown>[] {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const jobs = (JSON.parse(m[0]) as { jobs?: unknown }).jobs;
    return Array.isArray(jobs) ? jobs.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : [];
  } catch {
    return [];
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** 已经投过的公司不再放进岗位库（公司名互相包含也算，例如「网易游戏雷火」和「网易」） */
export function skipApplied(jobs: JobPosting[], apps: Application[]) {
  const applied = apps.map((a) => normCompany(a.company)).filter((c) => c.length >= 2);
  return jobs.filter((j) => {
    const c = normCompany(j.company);
    return !applied.some((x) => c === x || c.includes(x) || x.includes(c));
  });
}
