import "server-only";
import "./free-proxy"; // 没填自己的 Key 时走免费额度（必须在读 LLM_* 配置之前）
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { postJson } from "./extract";

/**
 * 检索：素材多了以后，按 JD 从素材里挑最相关的几十条再交给模型，不再全部塞进去。
 * - 向量用千问的 text-embedding-v4（沿用 .env.local 里的 SEARCH_LLM_API_KEY / SEARCH_LLM_BASE_URL）
 * - 按 JD 要点多路查询：JD 拆成一条条要点，每个要点先各挑最像的素材，免得整段 JD 被一个主题带偏
 * - 关键词混合：SQL、A/B 实验这类硬技能靠字面命中更准，和向量排名用 RRF 合并
 * - 分散：可以按经历设上限，免得全挑同一段经历
 * - 传进来的文字必须已经脱敏；占位符的编号先统一掉（【人名3】→【人名】），同一段文字换了编号也不用重算
 * - 向量缓存在 data/embeddings.json，按文字的哈希存；查询（JD、要点）单独存，只留最近 300 条；素材 90 天没用到就清掉
 * - 向量没配置或接口失败时退回只用关键词
 */

const FILE = path.join(process.cwd(), "data", "embeddings.json");
const MODEL = () => process.env.EMBED_MODEL?.trim() || "text-embedding-v4";
const DIMS = 1024;
const BATCH = 10; // 千问向量接口一次最多 10 条
const MAX_QUERIES = 300;
const ITEM_TTL_DAYS = 90;
const DUP_SIM = 0.88; // 两条素材语义相似度超过这个算重复

export function embedConfig() {
  const apiKey = process.env.SEARCH_LLM_API_KEY?.trim();
  const baseUrl = (process.env.SEARCH_LLM_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {}
  return { enabled: Boolean(apiKey), apiKey, baseUrl, host };
}

/** 证据条目参与检索的文字（简历、岗位匹配、面试准备、调研报告共用，同一条证据只算一次向量） */
export function evidenceText(e: { problem?: string; action?: string; result?: string; quote: string }) {
  return `${[e.problem, e.action, e.result].filter(Boolean).join(" ")}\n${e.quote}`;
}

/* ---------------- 向量缓存 ---------------- */

type Cache = {
  model: string;
  dims: number;
  vecs: Record<string, string>; // 素材
  seen?: Record<string, number>; // 素材最近一次用到是哪天（天数）
  queries?: Record<string, { v: string; at: number }>; // 查询：JD、JD 要点
};

let cache: Cache | null = null;
let chain: Promise<unknown> = Promise.resolve();
const today = () => Math.floor(Date.now() / 86400000);

async function load(): Promise<Cache> {
  if (cache && cache.model === MODEL()) return cache;
  try {
    const c = JSON.parse(await fs.readFile(FILE, "utf8")) as Cache;
    cache = c.model === MODEL() && c.dims === DIMS ? c : { model: MODEL(), dims: DIMS, vecs: {} };
  } catch {
    cache = { model: MODEL(), dims: DIMS, vecs: {} };
  }
  cache.seen ??= {};
  cache.queries ??= {};
  return cache;
}

function prune(c: Cache) {
  const q = Object.entries(c.queries!);
  if (q.length > MAX_QUERIES) c.queries = Object.fromEntries(q.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_QUERIES));
  const cutoff = today() - ITEM_TTL_DAYS;
  for (const k of Object.keys(c.vecs)) {
    // 旧缓存没有 seen：当作今天用过，从现在开始计
    if (c.seen![k] === undefined) c.seen![k] = today();
    else if (c.seen![k] < cutoff) {
      delete c.vecs[k];
      delete c.seen![k];
    }
  }
}

async function save() {
  const run = chain.then(async () => {
    if (!cache) return;
    prune(cache);
    const tmp = FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(cache), "utf8");
    await fs.rename(tmp, FILE);
  });
  chain = run.catch(() => undefined);
  return run;
}

const stable = (s: string) => s.replace(/【([^【】\d]+?)\d+】/g, "【$1】").replace(/\s+/g, " ").trim().slice(0, 2000);
const key = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 20);
const toB64 = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString("base64");
const fromB64 = (s: string) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};

/** 取一批文字的向量（缓存里有的不调接口）。asQuery：存到查询区（只留最近的） */
async function embed(texts: string[], asQuery = false): Promise<Float32Array[]> {
  const cfg = embedConfig();
  const c = await load();
  const norm = texts.map(stable);
  const get = (t: string) => (asQuery ? c.queries![key(t)]?.v : c.vecs[key(t)]);
  const missing = [...new Set(norm.filter((t) => t && !get(t)))];
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const r = await postJson(`${cfg.baseUrl}/embeddings`, cfg.apiKey!, cfg.host, { model: MODEL(), input: batch, dimensions: DIMS, encoding_format: "float" }, 30000);
    for (const d of (r.data ?? []) as { index: number; embedding: number[] }[]) {
      const k = key(batch[d.index]);
      if (asQuery) c.queries![k] = { v: toB64(d.embedding), at: Date.now() };
      else c.vecs[k] = toB64(d.embedding);
    }
  }
  // 记下用到的时间（查询按毫秒排先后，素材按天清理）
  let touched = missing.length > 0;
  for (const t of norm) {
    if (!t) continue;
    const k = key(t);
    if (asQuery && c.queries![k]) c.queries![k].at = Date.now();
    if (!asQuery && c.vecs[k] && c.seen![k] !== today()) {
      c.seen![k] = today();
      touched = true;
    }
  }
  if (touched || asQuery) await save();
  return norm.map((t) => {
    const v = get(t);
    return v ? fromB64(v) : new Float32Array(DIMS);
  });
}

function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/* ---------------- JD 要点、关键词 ---------------- */

const HEADER = /^(岗位职责|工作职责|职位描述|工作内容|岗位描述|任职要求|任职资格|岗位要求|职位要求|加分项|我们希望你|你需要|Responsibilities|Requirements|Qualifications)[：:\s]*/i;

// 门槛类要求（学历、专业、届别、兴趣、学习能力这类）：经历证据证明不了，不作为要点
const GATE = /学历|本科|硕士|博士|专业优先|相关专业|\d{4}\s*届|应届|毕业|热爱|激情|兴趣|抗压|自驱|学习能力|英[语文].{0,6}(读写|能力|流利)|听说读写|跨专业/;

/**
 * 把 JD 拆成一条条要点（按行、分号、编号），最多 12 条；拆不出 2 条就返回空数组（只用整段查询）。
 * 去掉：开头的岗位名、小标题（没有标点的短句）、门槛类要求。
 */
export function jdPoints(jd: string): string[] {
  const parts = jd
    .split(/\n|；|;|(?=\s(?:\d{1,2}[.、)）](?!\d)|[（(]\d{1,2}[)）]|[•▪●]))/)
    .map((s, i) => ({
      i,
      s: s
        .replace(/^\s*(?:\d{1,2}[.、)）](?!\d)|[（(]\d{1,2}[)）]|[a-zA-Z][、.)）]|[•▪●\-*])\s*/, "")
        .replace(HEADER, "")
        .trim(),
    }))
    .filter(({ s, i }) => {
      if (s.length < 6 || s.length > 300 || GATE.test(s)) return false;
      const plain = !/[，。、,.:：；;（(]/.test(s);
      if (i === 0 && (plain || /^【/.test(s)) && s.length < 40) return false; // 第一行是岗位名
      return !(plain && s.length <= 14); // 小标题
    })
    .map((x) => x.s);
  const out = [...new Set(parts)].slice(0, 12);
  return out.length >= 2 ? out : [];
}

// JD 里到处都是、不说明任何能力的两字词
const STOP = new Set(
  "负责 能力 相关 工作 优先 具备 良好 以上 熟悉 经验 了解 具有 进行 以及 我们 你的 公司 团队 岗位 要求 专业 学历 本科 硕士 毕业 优秀 较强 强烈 积极 主动 参与 协助 完成 包括 提供 各类 不限 其他 等等 以上 学习 沟通 合作 意识 责任 抗压"
    .split(" "),
);

/** 检索用的词：英文和技能词整体算一个，中文按两字一组；去掉 JD 套话 */
export function terms(s: string): Set<string> {
  const t = s.toLowerCase();
  const out = new Set<string>();
  for (const m of t.match(/[a-z][a-z0-9+#./-]*/g) ?? []) {
    const w = m.replace(/[./-]+$/, ""); // "sql." → "sql"；保留 a/b、c++、c#
    if (w.length >= 2) out.add(w);
  }
  for (const seg of t.match(/[一-鿿]+/g) ?? []) for (let i = 0; i + 1 < seg.length; i++) {
    const g = seg.slice(i, i + 2);
    if (!STOP.has(g)) out.add(g);
  }
  return out;
}

/** 关键词分：命中的词按稀有程度加权（很多素材都有的词分低） */
function keywordScores(query: string, docs: Set<string>[]): number[] {
  const q = terms(query);
  const df = new Map<string, number>();
  for (const d of docs) for (const g of d) if (q.has(g)) df.set(g, (df.get(g) ?? 0) + 1);
  const n = docs.length;
  return docs.map((d) => {
    let s = 0;
    for (const g of d) if (q.has(g)) s += Math.log(1 + n / (df.get(g) ?? 1));
    return s;
  });
}

/* ---------------- 排序 ---------------- */

export type Candidate = { id: string; text: string; group?: string };
export type Ranked = { id: string; score: number; point?: number; pointSim?: number };
/** coverage：每个要点在全部候选里最高的得分（向量时是相似度 0~1，关键词兜底时是关键词分，两者不可比） */
export type RankResult = { ranked: Ranked[]; points: string[]; coverage: number[]; by: "向量+关键词" | "关键词" };

/** 按排名合并（RRF）。关键词没命中的不参与关键词这一路 */
function rrf(lists: { order: number[]; w: number }[], n: number) {
  const s = new Array(n).fill(0);
  for (const { order, w } of lists) order.forEach((idx, r) => (s[idx] += w / (60 + r)));
  return s;
}

/**
 * 给候选排序并挑出 k 条。
 * - 有 JD 要点时：先让每个要点各挑一条最像的（覆盖），剩下的名额按总分补齐
 * - perGroup：同一组（例如同一段经历）最多几条；按上限挑不满时放宽
 * - 返回的 point 是这条素材最对得上的要点序号，pointSim 是相似度（只有向量可用时有）
 */
export async function rank(
  query: string,
  items: Candidate[],
  opts: { k: number; perGroup?: number; points?: string[]; legacy?: boolean; groupWeight?: Map<string, number> },
): Promise<RankResult> {
  // legacy：旧做法（整段 JD 一次向量查询，不拆要点、不用关键词、不分散），只给对比脚本用
  const points = opts.legacy ? [] : (opts.points ?? jdPoints(query));
  const perGroup = opts.legacy ? undefined : opts.perGroup;
  const n = items.length;
  // groupWeight：按组（经历）乘在相关度上的权重，例如大厂、同职能的经历略优先（见 native/resume.ts 的 cardWeights）
  const gw = (i: number) => (opts.legacy ? 1 : (opts.groupWeight?.get(items[i].group ?? "") ?? 1));
  const kwDocs = items.map((x) => terms(x.text));
  const kw = keywordScores(query, kwDocs).map((s, i) => s * gw(i));
  const kwByPoint = points.map((p) => keywordScores(p, kwDocs).map((s, i) => s * gw(i)));
  const kwOrder = opts.legacy ? [] : kw.map((s, i) => ({ s, i })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.i);

  let total: number[];
  let perPoint: number[][]; // [要点][素材]
  let pointSim: number[][] | null = null;
  let vecs: Float32Array[] | null = null;
  let by: RankResult["by"] = "关键词";
  try {
    if (!embedConfig().enabled || !query.trim() || !n) throw new Error("没有配置向量接口");
    const [qv, ...pv] = await embed([query, ...points], true);
    const iv = await embed(items.map((x) => x.text));
    vecs = iv;
    const whole = iv.map((v) => cosine(qv, v));
    pointSim = pv.map((p) => iv.map((v) => cosine(p, v)));
    const dense = iv.map((_, i) => (points.length ? 0.7 * Math.max(...pointSim!.map((row) => row[i])) + 0.3 * whole[i] : whole[i]) * gw(i));
    const dOrder = dense.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s).map((x) => x.i);
    total = rrf([{ order: dOrder, w: 1 }, { order: kwOrder, w: 0.5 }], n);
    perPoint = pointSim.map((row) => row.map((s, i) => s * gw(i))); // 覆盖选取也按权重；报告的 pointSim 仍是原始相似度
    by = "向量+关键词";
  } catch (e) {
    if (embedConfig().enabled && n) console.warn("[retrieve] 向量检索失败，改用关键词：", (e as Error).message);
    total = rrf([{ order: kwOrder, w: 1 }], n);
    perPoint = kwByPoint;
  }

  const bestPoint = (i: number) => {
    let bp = -1;
    let bs = 0;
    perPoint.forEach((row, j) => {
      if (row[i] > bs) {
        bs = row[i];
        bp = j;
      }
    });
    return bp;
  };

  const picked: number[] = [];
  const used = new Set<number>();
  const groupCount = new Map<string, number>();
  // 几乎一样的两条（同一句话既是简历原句又是资料证据、或者同一件事换了个说法）只要一条：
  // 用词看"较短那条有多少词被另一条包含"（资料证据的检索文字里多了提炼的字段）；有向量时再看语义是否几乎一样
  const overlap = (a: Set<string>, b: Set<string>) => {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / Math.max(1, Math.min(a.size, b.size));
  };
  const dup = (i: number) => picked.some((j) => overlap(kwDocs[i], kwDocs[j]) >= 0.8 || (vecs !== null && cosine(vecs[i], vecs[j]) >= DUP_SIM));
  const fits = (i: number, strict: boolean) => {
    if (used.has(i) || (!opts.legacy && dup(i))) return false;
    const g = items[i].group;
    return !strict || !perGroup || !g || (groupCount.get(g) ?? 0) < perGroup;
  };
  const take = (i: number) => {
    used.add(i);
    picked.push(i);
    const g = items[i].group;
    if (g) groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
  };

  // 1. 覆盖：每个要点先挑一条（最多占一半名额；关键词兜底时要点没有命中就跳过）
  const coverSlots = Math.min(points.length, Math.ceil(opts.k / 2));
  for (let j = 0; j < points.length && picked.length < coverSlots; j++) {
    const order = perPoint[j].map((s, i) => ({ s, i })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    const hit = order.find((x) => fits(x.i, true));
    if (hit) take(hit.i);
  }
  // 2. 补齐：按总分；先守分组上限，挑不满再放宽
  const byTotal = total.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s).map((x) => x.i);
  for (const strict of [true, false]) for (const i of byTotal) if (picked.length < opts.k && fits(i, strict)) take(i);

  const ranked = picked
    .map((i) => {
      const p = bestPoint(i);
      return { id: items[i].id, score: total[i], point: p >= 0 ? p : undefined, pointSim: pointSim && p >= 0 ? pointSim[p][i] : undefined };
    })
    .sort((a, b) => b.score - a.score);
  const coverage = (pointSim ?? perPoint).map((row) => row.reduce((m, s) => Math.max(m, s), 0)); // 用不加权的原始相似度
  return { ranked, points, coverage, by };
}

/**
 * 旧接口：按和 query 的相关度挑前 k 条的 id。
 * 候选不超过 k 条时直接全部返回（不调接口）；向量没配置或出错返回 null（调用方退回"全部发送"）。
 */
export async function topK(query: string, items: { id: string; text: string; group?: string }[], k: number, perGroup?: number): Promise<Set<string> | null> {
  if (items.length <= k) return new Set(items.map((x) => x.id));
  if (!embedConfig().enabled || !query.trim()) return null;
  const r = await rank(query, items, { k, perGroup });
  if (r.by !== "向量+关键词") return null;
  return new Set(r.ranked.map((x) => x.id));
}
