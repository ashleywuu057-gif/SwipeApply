import "server-only";
import { llmConfig, LONG_OUTPUT } from "../extract";
import { buildContext, redact, restore, type RedactContext } from "../redact";
import { newId, readEvidence, readLibrary } from "../store";
import type { ExperienceCard, Settings } from "../types";
import type { JobPosting } from "../tracker-types";
import { has, matchReasons } from "./feed";
import { chatJson, numbersOk, resumeModel, smallModel } from "./llm";
import { evidenceText, rank, topK } from "../retrieve";
import { note, step } from "./progress";
import { SAMPLE_CARDS } from "./samples";
import type { Bullet, Fact, MemoryData, Resume, ResumeExp } from "./types";

/**
 * 定制简历：从经历卡片里挑经历、挑句子、按 JD 调整措辞。
 * 核心约束（harness）：每一条都要指明依据的原句（卡片原句或你补充的事实）；
 * 改写后出现原句里没有的数字 → 标"待核对"，不会悄悄写进简历。
 * 发给模型之前先在本地脱敏；标了「仅本地」的经历不发给模型。
 */

export interface PoolLine {
  id: string; // L3 / F1 / S2
  text: string; // 原文
  cardId?: string;
  kind: "卡片原句" | "补充事实" | "素材原文" | "资料证据";
  note?: string; // 资料证据：提炼出的"问题 → 行动 → 结果"，给模型看，核对仍以原文 text 为准
  embed?: string; // 检索用的文字（资料证据用 evidenceText，和岗位匹配共用一份向量）；没有就用 text
}

export interface Pool {
  cards: ExperienceCard[];
  lines: PoolLine[];
  alias: Map<string, string>; // E1 → cardId
  ctx: RedactContext;
  map: Record<string, string>;
  sample: boolean;
  settings: Settings;
}

export async function buildPool(mem: MemoryData): Promise<Pool> {
  const lib = await readLibrary();
  const sample = lib.cards.length === 0;
  const cards = sample ? SAMPLE_CARDS : lib.cards;
  const lines: PoolLine[] = [];
  let n = 0;
  for (const c of cards) for (const d of c.details) lines.push({ id: `L${++n}`, text: d, cardId: c.id, kind: "卡片原句" });
  mem.facts.forEach((f, i) => lines.push({ id: `F${i + 1}`, text: f.text, kind: "补充事实" }));
  // 从复盘、工作文档里提炼的证据（隐藏的不用）
  if (!sample) {
    const ids = new Set(cards.map((c) => c.id));
    let v = 0;
    for (const e of await readEvidence())
      if (!e.hidden && ids.has(e.cardId))
        lines.push({ id: `V${++v}`, text: e.quote, cardId: e.cardId, kind: "资料证据", note: [e.problem && `问题：${e.problem}`, e.action && `行动：${e.action}`, e.result && `结果：${e.result}`].filter(Boolean).join("；"), embed: evidenceText(e) });
  }
  const alias = new Map(cards.map((c, i) => [`E${i + 1}`, c.id]));
  const ctx = buildContext(lib.settings, [...cards.flatMap((c) => [c.company, c.role, ...c.details]), ...mem.facts.map((f) => f.text), ...lines.filter((l) => l.kind === "资料证据").map((l) => l.text)]);
  return { cards, lines, alias, ctx, map: {}, sample, settings: lib.settings };
}

export function red(pool: Pool, s: string) {
  return redact(s, pool.ctx, pool.map).text;
}

export function aliasOf(pool: Pool, cardId: string) {
  for (const [a, id] of pool.alias) if (id === cardId) return a;
  return "";
}

/**
 * 证据条目多了以后，按 JD（和你刚说的话）挑最相关的 k 条给模型看，简历原句和补充事实照旧全给。
 * 返回 undefined = 不筛（没配置向量接口、出错、或本来就不多）。V 编号不变，模型引用哪条都能对上。
 */
export async function selectEvidence(pool: Pool, query: string, k = 40, always: string[] = []): Promise<Set<string> | undefined> {
  const local = new Set(pool.cards.filter((c) => c.localOnly).map((c) => c.id));
  const items = pool.lines
    .filter((l) => l.kind === "资料证据" && !(l.cardId && local.has(l.cardId)))
    .map((l) => ({ id: l.id, text: red(pool, l.embed ?? l.text) }));
  const top = await topK(red(pool, query), items, k);
  if (!top) return undefined;
  for (const id of always) top.add(id);
  return top;
}

// 大厂：挑经历时"业务相关度"同等条件下优先
const BIG_TECH = /字节|抖音|tiktok|快手|小红书|阿里|淘宝|天猫|蚂蚁|腾讯|微信|美团|京东|百度|网易|拼多多|哔哩|bilibili|b站|滴滴|携程|小米|华为|米哈游|得物|shopee|微软|google|谷歌|meta|amazon|亚马逊|apple|苹果/i;
const roleOf = (role: string) => (/产品/.test(role) ? "产品" : /运营|增长|营销|市场/.test(role) ? "运营/营销" : /咨询|战略|分析|研究/.test(role) ? "咨询/战略/研究" : "其他");

/**
 * 每段经历的标签（是否大厂、职能）+ 和 JD 的文本相似度（按 JD 要点检索，取这段经历里最像的一句），写成提示给模型。
 * 挑经历的优先级在提示词里：业务相关度 → 岗位相关度 → 行业相关度；文本相似度只作参考。
 */
export async function cardRelevance(pool: Pool, query: string): Promise<string> {
  const cloud = pool.cards.filter((c) => !c.localOnly);
  if (cloud.length < 2) return "";
  const lines = pool.lines.filter((l) => (l.kind === "卡片原句" || l.kind === "资料证据") && cloud.some((c) => c.id === l.cardId));
  const best = new Map<string, number>();
  if (lines.length && query.trim().length >= 20) {
    const r = await rank(red(pool, query), lines.map((l) => ({ id: l.id, text: red(pool, l.embed ?? l.text), group: l.cardId })), { k: lines.length });
    for (const x of r.ranked) {
      const cardId = lines.find((l) => l.id === x.id)?.cardId;
      if (cardId && x.pointSim !== undefined) best.set(cardId, Math.max(best.get(cardId) ?? 0, x.pointSim));
    }
  }
  const tag = (c: ExperienceCard) => `${cardTag(c)}${best.has(c.id) ? `·文本相似 ${best.get(c.id)!.toFixed(2)}` : ""}`;
  return `每段经历的标签：${cloud.map((c) => `${aliasOf(pool, c.id)}［${tag(c)}］`).join("、")}`;
}

/** 学术经历（论文、课题）：用户要求弱化，只有 AI 强相关岗位才用 */
const isAcademic = (c: ExperienceCard) => /论文|学位|课题|thesis|dissertation/i.test(`${c.company} ${c.role} ${c.type}`);
const AI_JOB = /ai|aigc|大模型|llm|算法|模型|智能体|agent/i;

/** 经历标签："学术" 或 "大厂·产品" 这样（挑经历、匹配理由时给模型参考） */
export function cardTag(c: ExperienceCard) {
  return isAcademic(c) ? "学术" : `${BIG_TECH.test(c.company) ? "大厂" : "非大厂"}·${roleOf(c.role)}`;
}

/**
 * 检索时每段经历的权重（乘在相关度上），按用户定的优先级：业务 → 岗位 → 行业，大厂优先，学术只用于 AI 岗。
 * 只是轻微调整排序，不会把真正相关的素材压下去。
 */
export function cardWeights(pool: Pool, jobTitle: string): Map<string, number> {
  const jobRole = roleOf(jobTitle);
  const ai = AI_JOB.test(jobTitle);
  return new Map(
    pool.cards.map((c) => {
      if (isAcademic(c)) return [c.id, ai ? 0.9 : 0.5];
      let w = BIG_TECH.test(c.company) ? 1 : 0.9;
      if (jobRole !== "其他" && roleOf(c.role) !== jobRole) w *= 0.9;
      return [c.id, w];
    }),
  );
}

/** 给模型看的素材清单（已脱敏，仅本地的经历不出现）。keep：只列这些证据条目（见 selectEvidence） */
export function poolForModel(pool: Pool, keep?: Set<string>) {
  const local = new Set(pool.cards.filter((c) => c.localOnly).map((c) => c.id));
  const blocks = pool.cards
    .filter((c) => !c.localOnly)
    .map((c) => {
      const ls = pool.lines.filter((l) => l.cardId === c.id && (!keep || l.kind !== "资料证据" || keep.has(l.id)));
      const line = (l: PoolLine) => `  ${l.id} ${red(pool, l.text)}${l.note ? `\n     （提炼：${red(pool, l.note)}）` : ""}`;
      return `${aliasOf(pool, c.id)} ${red(pool, c.company)} · ${red(pool, c.role)}（${c.start}–${c.end}）\n${ls.map(line).join("\n")}`;
    });
  const facts = pool.lines.filter((l) => l.kind === "补充事实");
  return [
    blocks.join("\n\n"),
    facts.length ? `你之前补充过的事实：\n${facts.map((l) => `  ${l.id} ${red(pool, l.text)}`).join("\n")}` : "",
    local.size ? `（另有 ${local.size} 段经历标了"仅本地"，你看不到）` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 核对一条 bullet：依据存在、数字都在依据里出现过、没有残留的占位符 */
export function checkBullet(text: string, source: string): Pick<Bullet, "status" | "issue"> {
  if (!source) return { status: "待核对", issue: "没有依据的原句" };
  if (/【[^】]*\d+】/.test(text)) return { status: "待核对", issue: "含有未还原的脱敏占位符" };
  const n = numbersOk(text, source);
  if (!n.ok) return { status: "待核对", issue: `出现了原句里没有的数字：${n.extra.join("、")}` };
  return { status: text.trim() === source.trim() ? "原句" : "改写" };
}

export function makeBullet(text: string, source: string, manual = false): Bullet {
  const c = checkBullet(text, source);
  return { id: newId(), text, source, status: manual && c.status !== "待核对" ? "手动" : c.status, issue: c.issue };
}

function expOf(c: ExperienceCard, include: boolean, bullets: Bullet[]): ResumeExp {
  return { cardId: c.id, include, company: c.company, role: c.role, time: `${c.start}–${c.end}`, bullets };
}

/* ---------------- 生成 ---------------- */

/** 每段经历 2~3 条 bullet（用户定的） */
export const MAX_BULLETS = 3;
export const MIN_BULLETS = 2;

/*
 * 写满一页 A4（用户定的）：排版和用户给的简历一致（10pt 宋体、行距 16.3pt、页边距 12.7mm，内容区 184.6mm × 271.6mm），
 * 粗估一行约 52 字、一页约 47 行。
 * 抬头、教育、技能先占掉固定的行数，剩下的就是经历部分的篇幅，告诉模型按这个篇幅选经历、写长短。
 * 导出时前端会再按实际排版量一次（apply 页的 fitOnePage），这里只负责让内容量对得上。
 */
const LINE_CHARS = 52;
const PAGE_LINES = 47;
const linesOf = (t: string) => Math.max(1, Math.ceil(t.length / LINE_CHARS));
function expLineBudget(mem: MemoryData) {
  const text = (t: string) =>
    t
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const edu = text(mem.profile.education ?? "");
  const extra = text(mem.profile.extra ?? "");
  const fixed =
    3 + // 姓名 + 联系方式
    (edu.length ? 1.5 + edu.reduce((n, l) => n + linesOf(l), 0) : 0) + // 模块标题 + 每行
    (extra.length ? 1.5 + extra.reduce((n, l) => n + linesOf(l), 0) + 1 : 0) + // 技能，另留一行给「其他技能」
    1.5; // 「实习经历」标题
  return Math.max(20, Math.round(PAGE_LINES - fixed));
}
/** 两句是不是在讲同一件事：关键词相同，或者较短那句一半以上的字在另一句里出现 */
function sameTopic(a: string, b: string) {
  const ka = a.split("：")[0];
  if (ka.length === 4 && ka === b.split("：")[0]) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  const chars = [...new Set(s.replace(/[\s，。、；：:,.;（）()“”"'’‘—-]/g, ""))];
  return chars.length > 0 && chars.filter((c) => l.includes(c)).length / chars.length > 0.75;
}

/** 选中的经历大概占几行：每段公司 + 职位 2 行，每条按字数折行 */
const expLines = (exps: ResumeExp[]) => exps.reduce((n, e) => n + 2 + e.bullets.reduce((m, b) => m + linesOf(b.text), 0), 0);

/** bullet 的格式（用户定的，参考 TA 的产品经理简历）：生成和工作台 agent 改写共用 */
export const BULLET_FORMAT = `每条 bullet 写成「关键词：详细介绍」：
   - 关键词固定 4 个汉字，是动作或能力，例如：数据分析、策略设计、统筹落地、竞品调研、行业调研、平台设计、样式设计、流程搭建、用户研究、项目管理。优先用 JD 看重的说法；同一段经历里的关键词不重复
   - 关键词必须是依据里真的做过的事，不能拔高（依据只写了"参与调研"，不能写成"策略设计"）
   - 冒号用全角"："
   - 详细介绍按"背景或问题 → 怎么做的（方法、工具、对接了谁）→ 结果"写，结果和数字放最后，一到两句话
   - 例："数据分析：利用 BI 平台和 SQL 拉取数据，对比历史未转化用户和首次转化用户的静态与动态特征，产出分析报告，为后续策略指明方向"`;

/** 是不是「关键词：详细介绍」的格式（关键词固定 4 个汉字）；半角冒号顺手换成全角 */
export function bulletFormat(text: string): { ok: boolean; text: string } {
  const m = text.trim().match(/^([一-龥]{4})\s*[：:]\s*(\S[\s\S]*)$/);
  return m ? { ok: true, text: `${m[1]}：${m[2]}` } : { ok: false, text: text.trim() };
}

const GEN_PROMPT = `你是资深校招简历顾问，帮用户针对一个岗位定制简历的"经历"部分。用户的素材都在下面，每一句都有编号。

只输出 JSON：
{
 "experiences":[{"exp":"E1","bullets":[{"text":"简历上的一句","source":"L3"}]}],
 "skills":[{"name":"技能或工具","source":"L2"}],
 "gaps":["JD 看重、但素材里找不到证据的点，写成问用户的一句话，例如：JD 希望熟悉游戏行业，素材里没看到，你有游戏相关的经历或长期爱好吗？"]
}

规则：
1. 选 3-4 段经历（对口的不够时可以 2 段，但要写满篇幅，见第 8 条），按这个优先级挑选和排序（用户定的）：
   ① 业务相关度：经历所在的业务和这个岗位的业务是不是同一类（例如都是 C 端互联网产品、内容/社区、电商、广告商业化、AI 应用），同等条件下大厂的业务经历优先
   ② 岗位相关度：职能是否一致（产品岗优先用产品经历，运营岗优先用运营经历）
   ③ 行业相关度：所在行业是否相同，只在前两项都弱时才看
   ④ 标签里是"学术"的经历（例如硕士论文）要弱化：只有 AI 强相关的岗位（AI 产品、大模型、AIGC、算法、模型评测等）才选，而且排在工作经历后面、最多 2 条；其他岗位一律不选
   ⑤ 非大厂、职能和岗位不同、业务也不同类的经历（例如咨询公司实习）：只有和岗位行业强相关时才选（例如汽车公司的岗位用汽车行业调研），或者前面对口的经历不足 2 段时才用来补位
   例如"影像产品经理"：先选大厂的 C 端产品经历，再看是不是产品岗；咨询公司里做过的汽车座舱调研只是沾了硬件体验的边，一般不选。
   "都做过调研""都写过报告"这类泛泛的共性不算相关，不要凑数。每段必须 2-3 条，不相关的句子不要选。素材前面给了每段经历的标签（是否大厂、职能）和一个文本相似度，相似度只作参考，以上面的优先级为准
2. 每条 bullet 必须指明依据的一句素材（source 填编号）。可以调整措辞、语序，突出 JD 关心的关键词，但不能加入依据里没有的事实、数字、职责或成果；一条 bullet 只依据一句素材
   ${BULLET_FORMAT}
3. 依据本身已经是「关键词：详细介绍」而且写得好的，直接用原句；原句没有关键词的，按依据补上合适的关键词
4. skills 只写素材里有证据的，最多 6 个
5. gaps 最多 3 条，只写真正重要的
6. 【人名1】【敏感词1】这类占位符保持原样
7. L 开头是简历原句，V 开头是从 TA 的复盘、工作文档里摘出的原文（括号里是提炼，仅供理解）。V 往往有简历里没写的细节和结果，JD 相关时优先用；依据仍然是原文本身。职责用词不能比依据更重：原文写"参与""协助"的，不能写成"主导""负责"
8. 简历要写满一页 A4：用户消息开头给了经历部分的篇幅（大约多少行，每行约 52 字；每段经历的公司和职位占 2 行）。按这个篇幅决定选几段、每段 2 条还是 3 条、每条写多长（一条 1~2 行，即 50~104 字），写满但不超出。字数不够时把依据里的背景、做法、结果写具体，不能为了凑字数编内容`;

export async function generateResume(job: JobPosting, jd: string, mem: MemoryData, briefLine = ""): Promise<Resume> {
  const pool = await buildPool(mem);
  const base: Resume = { jobId: job.id, experiences: [], skills: [], portfolio: [], gaps: [], by: pool.sample ? "示例" : "规则", updatedAt: new Date().toISOString() };
  const cloud = pool.cards.filter((c) => !c.localOnly);
  if (llmConfig().enabled && cloud.length) {
    const writing = mem.writing.filter((w) => w.active).map((w) => `- ${w.text}`);
    const budget = expLineBudget(mem);
    const evidence = pool.lines.filter((l) => l.kind === "资料证据").length;
    step(job.id, "按 JD 检索相关素材", `${cloud.length} 段经历、${pool.lines.length} 条素材`);
    const keep = await selectEvidence(pool, `${job.title}\n${briefLine}\n${jd}`);
    const relevance = await cardRelevance(pool, `${job.title}\n${jd}`);
    const own = pool.lines.length - evidence;
    note(job.id, evidence && keep ? `从 ${evidence} 条复盘证据里挑出最相关的 ${keep.size} 条，加上 ${own} 条简历原句` : evidence ? `${own} 条简历原句和 ${evidence} 条复盘证据全部参考` : `${own} 条简历原句全部参考`);
    step(job.id, "对照 JD 挑经历、改写句子", writing.length ? `每一句都要对上素材原句，并遵守你的 ${writing.length} 条写作偏好` : "每一句都要对上素材原句，不加原文没有的事实和数字");
    const r = await chatJson<{ experiences?: { exp: string; bullets: { text: string; source: string }[] }[]; skills?: { name: string; source: string }[]; gaps?: string[] }>(
      GEN_PROMPT + (writing.length ? `\n8. 用户的写作偏好（必须遵守）：\n${writing.join("\n")}` : ""),
      `经历部分的篇幅：约 ${budget} 行（每行约 ${LINE_CHARS} 字）\n岗位：${job.company} · ${job.title}\n${briefLine ? `业务：${briefLine}\n` : ""}JD：\n${jd || "（没有抓到 JD，按岗位名判断）"}\n\n${relevance ? `${relevance}\n\n` : ""}素材：\n${poolForModel(pool, keep)}`,
      0.2,
      LONG_OUTPUT,
      resumeModel(),
    );
    if (r?.experiences?.length) {
      const used = new Set<string>();
      for (const e of r.experiences) {
        const cardId = pool.alias.get(e.exp);
        const card = cloud.find((c) => c.id === cardId);
        if (!card || used.has(card.id)) continue;
        used.add(card.id);
        const bullets = (e.bullets ?? [])
          .map((b) => {
            const src = pool.lines.find((l) => l.id === String(b.source).trim());
            if (!src || (src.cardId && src.cardId !== card.id && (src.kind === "卡片原句" || src.kind === "资料证据"))) return null;
            const f = bulletFormat(restore(String(b.text ?? ""), pool.map));
            const bullet = makeBullet(f.text, src.text);
            // 不是「四字关键词：详细介绍」的标出来让用户看到，不悄悄放过
            return f.ok || bullet.status === "待核对" ? bullet : { ...bullet, status: "待核对" as const, issue: "格式不是「四字关键词：详细介绍」" };
          })
          .filter((b): b is Bullet => Boolean(b?.text))
          .slice(0, MAX_BULLETS);
        // 每段至少 2 条：模型只写了 1 条时，从这段经历没用过的原句里补，标出来让用户看
        for (const d of card.details) {
          if (!bullets.length || bullets.length >= MIN_BULLETS) break;
          // 已经有一条在讲同一件事（同一个关键词、或一半以上的字重合）就不补，免得出现两条差不多的
          if (bullets.some((b) => b.source === d || sameTopic(b.text, d))) continue;
          bullets.push({ ...makeBullet(bulletFormat(d).text, d), status: "待核对", issue: "每段至少 2 条，这条是从原句补上的，看看要不要改" });
        }
        if (bullets.length) base.experiences.push(expOf(card, true, bullets));
      }
      for (const c of pool.cards) if (!used.has(c.id)) base.experiences.push(expOf(c, false, c.details.slice(0, MAX_BULLETS).map((d) => makeBullet(d, d))));
      base.skills = (r.skills ?? []).filter((s) => pool.lines.some((l) => l.id === String(s.source).trim())).map((s) => restore(String(s.name), pool.map)).slice(0, 6);
      base.gaps = (r.gaps ?? []).map((g) => restore(String(g), pool.map)).slice(0, 3);
      base.by = pool.sample ? "示例" : "模型";
      const picked = base.experiences.filter((e) => e.include);
      const bullets = picked.flatMap((e) => e.bullets);
      const count = (s: Bullet["status"]) => bullets.filter((b) => b.status === s).length;
      const wrote = Math.round(expLines(picked));
      const fill = Math.round((wrote / budget) * 100);
      note(job.id, `篇幅：经历部分约 ${budget} 行，写了约 ${wrote} 行（${fill}%）${fill < 85 ? "，偏少，导出前看看要不要扩写" : fill > 110 ? "，偏多，导出时会缩小字号" : ""}`);
      step(
        job.id,
        "逐条核对依据和数字",
        [`选了 ${picked.length} 段经历、${bullets.length} 条`, count("原句") && `${count("原句")} 条直接用原句`, count("改写") && `${count("改写")} 条改写`, count("待核对") && `${count("待核对")} 条待你核对`].filter(Boolean).join("，"),
      );
      return base;
    }
  }
  const why = !llmConfig().enabled ? "没有配置模型" : !cloud.length ? "经历都标了「仅本地」，不发给模型" : "模型没有返回结果";
  step(job.id, "按关键词挑原句", `${why}，先按关键词挑原句，不改写`);
  return ruleResume(job, jd, pool, base);
}

/** 没有模型时：按关键词挑最相关的经历，用原句，不改写 */
function ruleResume(job: JobPosting, jd: string, pool: Pool, base: Resume): Resume {
  const text = `${job.title} ${jd}`;
  const ranked = pool.cards
    .map((c) => ({ c, reasons: matchReasons(text, [c], [], 5) }))
    .sort((a, b) => b.reasons.length - a.reasons.length);
  ranked.forEach(({ c, reasons }, i) => {
    const hitLines = reasons.map((r) => r.have);
    const ordered = [...hitLines, ...c.details.filter((d) => !hitLines.includes(d))];
    base.experiences.push(expOf(c, i < 3 && (reasons.length > 0 || i < 2), ordered.slice(0, MAX_BULLETS).map((d) => makeBullet(d, d))));
  });
  const all = [...pool.cards.flatMap((c) => c.details), ...pool.lines.filter((l) => l.kind === "补充事实").map((l) => l.text)].join(" ");
  const words = ["海外", "社媒", "KOL", "投放", "数据分析", "SQL", "Python", "用户调研", "竞品", "小语种", "游戏", "AI", "PRD"];
  base.gaps = words.filter((w) => text.includes(w) && !has(all, w)).slice(0, 3).map((w) => `JD 提到「${w}」，素材里没找到相关经历，你有这方面的经历吗？`);
  return base;
}

export function factFrom(text: string, question: string | undefined, from: string): Fact {
  return { id: newId(), text: text.trim(), question, from, createdAt: new Date().toISOString() };
}

/* ---------------- 收短：最后一行只有几个字的 bullet ---------------- */

const numbersIn = (t: string) => t.match(/\d+(?:\.\d+)?/g) ?? [];
/** 收短后最少几个字：只许比上限再短 8 个字，免得为了省一行删掉信息 */
const minLen = (x: { maxLen: number }) => x.maxLen - 8;

/**
 * 排版后最后一行只有 ≤6 个字的 bullet（前端按真实排版量出来的），让快模型压到 maxLen 字以内，省掉这一行（用户定的）。
 * 硬性核对，任何一条不过就保留原句：仍是「四字关键词：详细介绍」、不超过 maxLen、原来的数字一个不少、没有依据里没有的数字。
 * 发给模型前和生成时一样先脱敏。
 */
export async function tightenBullets(resume: Resume, items: { id: string; maxLen: number }[], mem: MemoryData): Promise<{ resume: Resume; changed: number; kept: number }> {
  const all = resume.experiences.flatMap((e) => e.bullets);
  const todo = items.map((it) => ({ ...it, b: all.find((b) => b.id === it.id) })).filter((x): x is { id: string; maxLen: number; b: Bullet } => Boolean(x.b && x.maxLen > 10));
  if (!todo.length || !llmConfig().enabled) return { resume, changed: 0, kept: todo.length };
  const pool = await buildPool(mem);
  // 模型数不准字数，所以不让它整句重写：只让它列出可以删短的小片段（按"删了最不影响信息"排序），
  // 程序一处一处地换，短到 maxLen 就停。这样改动最小，长度也是程序算的
  const r = await chatJson<{ items?: { id: string; edits?: { from: string; to: string }[] }[] }>(
    `下面几条简历句子，每条都要删短几个字。不要重写整句，只列出可以删短的地方。只输出 JSON：
{"items":[{"id":"…","edits":[{"from":"原句里的一小段原文，必须一字不差","to":"更短的说法，可以是空字符串"}]}]}
要求：
- 每条给 6~10 处，每处只省 1~6 个字，按"删了以后最不影响意思和信息"排在前面
- 适合删的：多余的"的""了""并""进行""相关""对应"、重复的说法、可以换成更短同义词的说法、可有可无的引号
- 不能删掉事实、背景、做法、结果，不能动数字，不能动冒号前的四字关键词
- to 里不能加原句没有的内容
- 【人名1】这类占位符保持原样`,
    todo.map((x) => `id=${x.id}（要删掉至少 ${x.b.text.length - x.maxLen} 个字）：${red(pool, x.b.text)}`).join("\n"),
    0.2,
    undefined,
    smallModel(),
  );
  let changed = 0;
  for (const x of todo) {
    const edits = r?.items?.find((y) => y.id === x.id)?.edits ?? [];
    let t = x.b.text;
    for (const e of edits) {
      if (t.length <= x.maxLen) break;
      const from = restore(String(e?.from ?? ""), pool.map);
      const to = restore(String(e?.to ?? ""), pool.map);
      const at = t.indexOf(from);
      // 只接受真的变短、不碰关键词（前 5 个字）、不动数字的小改动
      if (!from || at < 5 || to.length >= from.length || from.length - to.length > 6 || numbersIn(from).join() !== numbersIn(to).join()) continue;
      t = t.slice(0, at) + to + t.slice(at + from.length);
    }
    const f = bulletFormat(t);
    if (t === x.b.text || t.length > x.maxLen || t.length < minLen(x) || !f.ok || numbersIn(x.b.text).some((n) => !t.includes(n))) continue;
    const c = checkBullet(f.text, x.b.source);
    if (c.status === "待核对") continue;
    Object.assign(x.b, { text: f.text, status: x.b.status === "手动" ? "手动" : c.status, issue: undefined });
    changed++;
  }
  return { resume: { ...resume, updatedAt: new Date().toISOString() }, changed, kept: todo.length - changed };
}
