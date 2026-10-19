import "server-only";
import { llmConfig } from "../extract";
import { fetchPage, normForQuote } from "../research/fetch-page";
import { classifySource, searchConfig, webSearch, type SearchHit } from "../research/search";
import type { JobPosting } from "../tracker-types";
import { chatJson, smallModel } from "./llm";
import { renderPage } from "./render";
import { SAMPLE_JOBS, sampleBrief } from "./samples";
import { isRunning, once, readBrief, readJd, saveBrief, saveJd } from "./store";
import type { BriefRef, CompanyBrief, JdInfo } from "./types";

/* ================= JD：找到这个岗位的职责和要求 ================= */

/**
 * 很多岗位的链接只是公司校招首页，或者是动态页面、证书特殊的银行官网，直接下载拿不到 JD。按顺序试：
 *   1. 直接下载网页
 *   2. 用你电脑上的 Edge / Chrome 在后台打开（能加载动态内容）；是首页的话，顺着「这个岗位 / 校园招聘」的链接再点一层
 *   3. 联网搜索这个公司的这个岗位（官网详情页、牛客、实习僧、公众号等），读搜到的网页
 * 每一步都只从网页原文里挑句子，挑完核对是否都在原文里，并且要确认是这家公司的这个岗位。
 * 都不行的话，可以在浏览器里打开岗位页，点书签栏的「剪藏 JD」一键带回来。
 */
const JD_VERSION = 2; // 抓取方式升级后，旧的失败记录重新试

export async function ensureJd(job: JobPosting, opts: { force?: boolean } = {}): Promise<JdInfo> {
  const cached = await readJd(job.id);
  if (cached && cached.status === "ok" && !opts.force) return cached;
  const sample = SAMPLE_JOBS.find((s) => s.id === job.id);
  if (sample) return { jobId: job.id, text: sample.jd, status: "ok", by: "示例", updatedAt: new Date().toISOString() };
  if (!opts.force && cached && cached.v === JD_VERSION && Date.now() - new Date(cached.updatedAt).getTime() < 6 * 3600000) return cached; // 失败的 6 小时内不重试

  const info: JdInfo = { jobId: job.id, text: "", status: "empty", by: "网页", url: job.link, updatedAt: new Date().toISOString(), v: JD_VERSION };
  const notes: string[] = [];
  const tried = new Set<string>();
  const done = async (t: Picked, by: JdInfo["by"], url: string, title?: string) => {
    Object.assign(info, { text: t.text, warn: t.warn, by, url, sourceTitle: title, status: "ok", error: undefined });
    await saveJd(info);
    return info;
  };
  // 挑 JD；届别、校招/实习对不上被排除的，把原因记进"试了什么"
  const pick = async (text: string, date?: string) => {
    const t = await pickJdInfo(text, job, date);
    if (t.reject) notes.push(t.reject);
    return t;
  };

  // 岗位详情页（jdUrl，联网搜岗位时记下的）优先，其次是网申链接
  const links = [...new Set([(job as JobPosting & { jdUrl?: string }).jdUrl, job.link].filter((x): x is string => Boolean(x)))];
  for (const link of links) {
    const label = link === job.link ? "网申链接" : "岗位详情页";
    // 1. 直接下载
    tried.add(link);
    try {
      const page = await fetchPage(link);
      const t = await pick(page.text, page.date);
      if (t.text) return done(t, "网页", link, page.title);
      notes.push(`${label}的网页里没有这个岗位的职责`);
    } catch (e) {
      notes.push(`${label}直接打不开（${(e as Error).message}）`);
    }
    // 2. 浏览器打开，必要时再点一层
    try {
      const r = await renderPage(link);
      const t = await pick(r.text);
      if (t.text) return done(t, "浏览器", r.url, r.title);
      const next = pickLink(r.links, job).filter((l) => !tried.has(l));
      for (const href of next.slice(0, 2)) {
        tried.add(href);
        const r2 = await renderPage(href).catch(() => null);
        const t2 = r2 ? await pick(r2.text) : null;
        if (r2 && t2?.text) return done(t2, "浏览器", r2.url, r2.title);
      }
      notes.push(next.length ? `${label}用浏览器打开后顺着链接找了一层，也没找到这个岗位` : `${label}用浏览器打开后是公司首页或列表页，没找到这个岗位的入口`);
    } catch (e) {
      notes.push(`浏览器打开失败：${(e as Error).message}`);
    }
  }
  if (!links.length) notes.push("岗位库里没有网申链接");

  // 3. 联网搜索
  if (searchConfig().enabled) {
    const core = titleCore(job.title);
    const queries = [`${job.company} ${core} 岗位职责 任职要求`, `${job.company} 校园招聘 ${core} 职位描述`];
    const hits: SearchHit[] = [];
    for (const q of queries) {
      const list = await webSearch(q, { count: 8 }).catch(() => [] as SearchHit[]);
      for (const h of list) if (!tried.has(h.url) && !hits.some((x) => x.url === h.url)) hits.push(h);
    }
    for (const h of hits.slice(0, 4)) {
      tried.add(h.url);
      let text = "";
      let title = h.title;
      let date = h.date;
      try {
        const p = await fetchPage(h.url);
        text = p.text;
        title = p.title || title;
        date = p.date || date;
      } catch {
        const r = await renderPage(h.url).catch(() => null);
        text = r?.text ?? "";
      }
      if (!text || !mentionsCompany(`${text} ${title} ${h.title}`, job.company)) continue;
      const t = await pick(text, date);
      if (t.text) return done(t, "搜索", h.url, `${title}（${h.site}）`);
    }
    notes.push(hits.length ? `联网搜索读了 ${Math.min(hits.length, 4)} 个网页，没有这个岗位的 JD` : "联网搜索没有结果");
  } else notes.push("没配置联网搜索（SEARCH_LLM_API_KEY），没去网上找");

  info.status = "failed";
  info.error = notes.join("；");
  await saveJd(info);
  return info;
}

/** "海外市场营销管培生（2027届）" → "海外市场营销管培生" */
function titleCore(title: string) {
  return title.replace(/[（(【\[].*?[)）】\]]/g, "").replace(/(2026|2027|2028)届?|校招|秋招|春招|实习生?$/g, "").trim() || title;
}

function mentionsCompany(text: string, company: string) {
  const c = company.replace(/[（(].*?[)）]/g, "").replace(/(股份有限公司|有限责任公司|有限公司|集团|控股|科技|中国)$/g, "").trim();
  return text.includes(company) || (c.length >= 2 && text.includes(c)) || (c.length >= 4 && text.includes(c.slice(0, 4)));
}

/** 在首页里找去这个岗位（或校园招聘列表）的链接 */
function pickLink(links: { text: string; href: string }[], job: JobPosting) {
  const core = titleCore(job.title);
  const exact = links.filter((l) => l.text.includes(core) || (core.length >= 4 && l.text.includes(core.slice(0, 4))));
  const campus = links.filter((l) => /校园招聘|校招|应届|毕业生|campus|graduate/i.test(`${l.text} ${l.href}`));
  return [...new Set([...exact, ...campus].map((l) => l.href))];
}

/**
 * 这个岗位是哪一届、是校招还是实习（按岗位库的批次和岗位名）。只认写明了的，没写就不拿来排除网页：
 * 写了校招但没写届别的，7 月以后算明年那届。
 */
function jobKind(job: JobPosting) {
  const s = `${job.batch} ${job.title}`;
  const intern = /实习/.test(s);
  const campus = !intern && /校招|校园招聘|届|秋招|春招|管培|应届/.test(s);
  const y = s.match(/(20\d{2})\s*届/)?.[1] ?? s.match(/20\d{2}/)?.[0];
  const now = new Date();
  const batch = y ? Number(y) : campus ? (now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear()) : undefined;
  return { intern, campus, batch };
}

type Picked = { text: string; warn?: string; reject?: string };

/**
 * 从网页正文里找这个岗位的 JD。有模型时让模型挑出原句（只挑不改，挑完核对是否都在原文里）；没有模型用关键词截取。
 * 顺便看页面写的届别和招聘类型：届别比要找的早、或者校招/实习对不上的，不要（reject 说明原因）；
 * 发布时间早于去年的，照用但提醒可能是往年的（warn）。
 */
async function pickJdInfo(text: string, job: JobPosting, pageDate?: string): Promise<Picked> {
  if (!text || text.length < 80) return { text: "" };
  if (llmConfig().enabled) {
    const r = await chatJson<{ lines?: string[]; batch?: string; type?: string; posted?: string }>(
      `你从招聘网页正文里找出指定岗位的"岗位职责"和"任职要求"。只输出 JSON：{"lines":["原文的一行", ...],"batch":"页面写明的届别，如 2027届；没写留空","type":"校招|实习|社招|未注明","posted":"页面写明的发布或更新日期，如 2025-09-01；没写留空"}
- 每一行都必须从正文里原样复制，不要改写、不要总结、不要补充
- 页面里有多个岗位时，只要指定岗位（或名称非常接近的同一岗位）的那一个
- 页面不是这家公司的招聘信息、或者没有这个岗位的职责和要求，就输出 {"lines":[]}，不要拿别的岗位凑数`,
      `指定岗位：${job.company} · ${job.title}${job.batch ? `（${job.batch}）` : ""}\n\n网页正文：\n${text.slice(0, 12000)}`,
      0,
      undefined,
      smallModel(), // 只是照抄原文的活，用快模型；主模型（推理）常常超时，以前超时被当成「没找到这个岗位」
    ).catch((e: Error) => ({ failed: e.message }) as const);
    if (r && "failed" in r) return { text: "", reject: `读到了网页，但挑 JD 的模型没有响应（${r.failed.slice(0, 40)}）` };
    const norm = normForQuote(text);
    const lines = (r?.lines ?? []).map((l) => String(l).trim()).filter((l) => l && norm.includes(normForQuote(l)));
    if (lines.length < 2) return { text: "" };

    const want = jobKind(job);
    const pageBatch = Number(String(r?.batch ?? "").match(/20\d{2}/)?.[0] ?? 0);
    const type = String(r?.type ?? "");
    if (want.batch && pageBatch && pageBatch < want.batch) return { text: "", reject: `找到的是 ${pageBatch} 届的往年 JD` };
    if (want.campus && type === "实习") return { text: "", reject: "找到的是实习岗位的 JD，你投的是校招" };
    if (want.intern && type === "校招") return { text: "", reject: "找到的是校招岗位的 JD，你投的是实习" };
    const posted = Number(String(r?.posted || pageDate || "").match(/20\d{2}/)?.[0] ?? 0);
    const warn = posted && posted < new Date().getFullYear() - 1 ? `网页发布于 ${posted} 年，可能是往年的 JD，核对一下` : undefined;
    return { text: lines.join("\n").slice(0, 3000), warn };
  }
  if (!text.includes(titleCore(job.title).slice(0, 4))) return { text: "" };
  const m = text.match(/(岗位职责|工作职责|职位描述|工作内容|岗位描述|Responsibilities)[\s\S]{30,2500}/i);
  return { text: m ? m[0].slice(0, 2500).trim() : "" };
}

async function pickJd(text: string, job: JobPosting): Promise<string> {
  return (await pickJdInfo(text, job)).text;
}

/**
 * 不等待的版本：有现成的就返回；没有就在后台开始找（最多一分钟），先返回"正在找"，前端轮询。
 * 页面、简历生成、对话都用这个，不会因为找 JD 卡住。
 */
export async function peekJd(job: JobPosting): Promise<JdInfo> {
  const sample = SAMPLE_JOBS.find((s) => s.id === job.id);
  if (sample) return { jobId: job.id, text: sample.jd, status: "ok", by: "示例", updatedAt: new Date().toISOString() };
  const cached = await readJd(job.id);
  if (cached?.status === "ok") return cached;
  const fresh = cached && cached.v === JD_VERSION && Date.now() - new Date(cached.updatedAt).getTime() < 6 * 3600000;
  if (fresh && !isRunning(`jd:${job.id}`)) return cached;
  once(`jd:${job.id}`, () => ensureJd(job));
  return { jobId: job.id, text: "", status: "searching", by: "网页", url: job.link, updatedAt: new Date().toISOString(), v: JD_VERSION };
}

/** 剪藏：从你在浏览器里打开的页面文字里挑出这个岗位的 JD */
export async function jdFromText(text: string, job: JobPosting) {
  return pickJd(text, job);
}

export async function setManualJd(jobId: string, text: string, by: JdInfo["by"] = "手动", url?: string) {
  const info: JdInfo = { jobId, text: text.trim().slice(0, 6000), status: text.trim() ? "ok" : "empty", by, url, updatedAt: new Date().toISOString(), v: JD_VERSION };
  await saveJd(info);
  return info;
}

/* ================= 公司速览：公司介绍 · 业务条线 · 主要产品 · 要点 ================= */

const BRIEF_TTL = 14 * 86400000; // 两周内用缓存

/** 读缓存；没有或过期就在后台生成（前端轮询），这样第二次打开秒开，提前预取时第一次也能秒开 */
export async function getBrief(job: JobPosting, jd: string): Promise<CompanyBrief> {
  if (job.source === "示例") return sampleBrief(job.company);
  const cached = await readBrief(job.company);
  const fresh = cached && cached.status === "ready" && Date.now() - new Date(cached.updatedAt).getTime() < BRIEF_TTL;
  if (fresh) return cached;
  startBrief(job, jd);
  return (
    (cached?.status === "ready" ? { ...cached } : null) ??
    ({ company: job.company, status: "generating", basis: "联网", intro: "", businessLine: "", products: [], facts: [], refs: [], updatedAt: new Date().toISOString() } as CompanyBrief)
  );
}

export function startBrief(job: JobPosting, jd: string, force = false) {
  return once(`brief:${job.company}`, async () => {
    if (!force) {
      const c = await readBrief(job.company);
      if (c && c.status === "ready" && Date.now() - new Date(c.updatedAt).getTime() < BRIEF_TTL) return;
    }
    const b = await generateBrief(job, jd).catch(
      (e) =>
        ({
          company: job.company,
          status: "failed",
          basis: "联网",
          intro: "",
          businessLine: "",
          products: [],
          facts: [],
          refs: [],
          error: (e as Error).message,
          updatedAt: new Date().toISOString(),
        }) as CompanyBrief,
    );
    await saveBrief(b);
  });
}

const BRIEF_PROMPT = (withSources: boolean) => `你在帮一名应届生快速了解一家公司，决定要不要投、怎么准备。只输出 JSON：
{
 "intro": "公司是做什么的，2-3 句",
 "businessLine": "这个岗位大概率在哪条业务线，这条业务在公司里的位置，1-2 句",
 "products": [{"name":"主要产品","desc":"一句话","refs":[来源编号]}],
 "facts": [{"text":"其他值得知道的要点：规模、近期动态、出海情况等","refs":[来源编号]}]
}
要求：
${withSources ? `- 只根据下面给出的来源写，每条都标来源编号；来源里没有的信息不要写，宁可少写` : `- 你无法联网，只能根据已有知识写；不确定的信息不要写，数字尽量不写
- refs 一律写 []`}
- products 最多 5 个，facts 最多 4 条，全部用中文，简洁`;

async function generateBrief(job: JobPosting, jd: string): Promise<CompanyBrief> {
  const base: CompanyBrief = {
    company: job.company,
    status: "ready",
    basis: "联网",
    intro: "",
    businessLine: "",
    products: [],
    facts: [],
    refs: [],
    updatedAt: new Date().toISOString(),
  };
  if (!llmConfig().enabled) throw new Error("还没有配置 LLM_API_KEY，无法生成公司速览");
  const task = `公司：${job.company}\n岗位：${job.title}\n${jd ? `JD：${jd.slice(0, 1500)}` : ""}`;

  if (!searchConfig().enabled) {
    const r = await chatJson<Partial<CompanyBrief>>(BRIEF_PROMPT(false), task);
    return fill({ ...base, basis: "模型知识" }, r, 0);
  }

  // 联网：搜 3 个角度，读排在前面的几个网页
  const queries = [`${job.company} 公司 主要业务 产品`, `${job.company} ${job.title.replace(/[（(].*?[)）]/g, "")} 业务`];
  const hits: SearchHit[] = [];
  for (const q of queries) {
    const list = await webSearch(q, { count: 6 }).catch(() => [] as SearchHit[]);
    for (const h of list) if (!hits.some((x) => x.url === h.url)) hits.push(h);
  }
  const pick = hits.slice(0, 5);
  const pages = await Promise.all(
    pick.map(async (h) => {
      try {
        const p = await fetchPage(h.url);
        return { hit: h, text: p.text.slice(0, 2500), title: p.title || h.title };
      } catch {
        return null;
      }
    }),
  );
  const ok = pages.filter(Boolean) as { hit: SearchHit; text: string; title: string }[];
  const refs: BriefRef[] = ok.map((p, i) => ({ id: i + 1, title: p.title, url: p.hit.url, site: p.hit.site }));
  if (!ok.length) {
    const r = await chatJson<Partial<CompanyBrief>>(BRIEF_PROMPT(false), task);
    return fill({ ...base, basis: "模型知识" }, r, 0);
  }
  const sources = ok.map((p, i) => `[${i + 1}] ${p.title}（${p.hit.site} · ${classifySource(p.hit.url).channel}）\n${p.text}`).join("\n\n");
  const r = await chatJson<Partial<CompanyBrief>>(BRIEF_PROMPT(true), `${task}\n\n来源：\n${sources}`);
  return fill({ ...base, refs }, r, refs.length);
}

/** 整理模型输出；引用了不存在的来源编号的去掉 */
function fill(b: CompanyBrief, r: Partial<CompanyBrief> | null, nRefs: number): CompanyBrief {
  if (!r) throw new Error("模型没有返回有效内容");
  const okRefs = (x: unknown) => (Array.isArray(x) ? x.map(Number).filter((n) => n >= 1 && n <= nRefs) : []);
  b.intro = String(r.intro ?? "");
  b.businessLine = String(r.businessLine ?? "");
  b.products = (Array.isArray(r.products) ? r.products : []).slice(0, 5).map((p) => ({ name: String(p?.name ?? ""), desc: String(p?.desc ?? ""), refs: okRefs(p?.refs) }));
  b.facts = (Array.isArray(r.facts) ? r.facts : []).slice(0, 4).map((f) => ({ text: String(f?.text ?? ""), refs: okRefs(f?.refs) }));
  b.updatedAt = new Date().toISOString();
  return b;
}
