import "server-only";
import { LONG_OUTPUT } from "./extract";
import { chatJson, numbersOk } from "./native/llm";
import { cardWeights, red, type Pool, type PoolLine } from "./native/resume";
import type { CompanyBrief, PlanQuestion, PrepData, PrepMatch, PrepPlan } from "./native/types";
import { restore } from "./redact";
import type { Research } from "./research/types";
import { rank } from "./retrieve";

/**
 * 面试准备稿。结构参照一份人工写得很好的准备稿：
 * A（准备面试时生成）：简历深挖（最该讲的经历 + 追问三连）、风险点（JD 硬要求里素材证明不了的）、表达（为什么选这个岗、1 分钟主线、反问）
 * B（深度调研做完后生成）：公司业务的最新情况（带来源）、团队在做什么的推断和拆解公式、业务题和答题思路
 * 核对：追问里的数字必须在引用的素材里；业务事实必须有来源编号，数字必须出现在对应的调研发现里；引用的编号都要存在。
 * 发给模型前脱敏；标了「仅本地」的经历不参与。
 */

const MATERIALS = 16; // 按 JD 要点挑多少条素材
const PER_CARD = 5;
const NUM_LINES = 4; // 每段经历额外带上几条有数字的原句（追问数字口径要用）
const WEAK = 0.55; // 某个 JD 要点在全部素材里最高相似度低于这个，算"可能的缺口"

const QUESTION_KINDS: PlanQuestion["kind"][] = ["做了什么", "数字口径", "个人贡献", "重来", "其他"];

const labelOf = (pool: Pool, cardId?: string) => {
  const c = pool.cards.find((x) => x.id === cardId);
  return c ? `${c.company} · ${c.role}` : "";
};
const toMatch = (pool: Pool, l: PoolLine): PrepMatch => ({ ref: l.id, label: labelOf(pool, l.cardId), text: l.text, note: l.note });

/** 把模型写进正文的内部编号换成人话；没还原的姓名占位符去掉（模型有时自己造"我是【人名1】"） */
function human(s: string, map: { E?: (n: number) => string; P?: (n: number) => string } = {}) {
  return s
    .replace(/(?<![A-Za-z])M\d+(?:\s*[/、,，和及]\s*M\d+)*\s*(?:里|中|的|说|提到)?/g, "")
    .replace(/(?<![A-Za-z])E(\d+)/g, (_, n) => map.E?.(Number(n)) ?? "")
    .replace(/(?<![A-Za-z])P(\d+)/g, (_, n) => map.P?.(Number(n)) ?? "")
    .replace(/我是【[^】]*\d*】[，,]?\s*/g, "")
    .replace(/【人名\d*】/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const PROMPT_A = (round: string) => `你是资深面试官兼求职教练，帮一名应届生准备一场${round}。目标：让面试官相信 TA 的经历正好满足这个岗位要的东西。
只输出 JSON：
{"deepDive":[{"exp":"E1","points":[2,3],"why":"这段经历对应 JD 哪几条、为什么是重点，一两句","questions":[{"q":"面试官会怎么追问，像当面问的一句话","kind":"做了什么|数字口径|个人贡献|重来","refs":["M3"]}],"transfer":"怎么把这段经验迁移到目标公司的业务上讲，一两句"}],
 "risks":[{"need":"JD 里的要求（摘原文几个字）","why":"素材里为什么证明不了，一句话","prep":["面试前具体可以做的准备"]}],
 "pitch":{"whyRole":"为什么选这个岗位，一句话，结合 TA 的经历","intro":"1 分钟自我介绍的主线，两三句，点明重点讲哪几段","focus":["E1","E2"],"ask":["反问 1","反问 2"]}}
要求：
- deepDive 2~4 段，按对这个岗位的重要程度排序；points 填对应的 JD 要点编号（P 后面的数字），没有给出 JD 要点时留空数组
- q、why、transfer、risks、pitch 这些给人看的文字里不要写 M、E、P 编号，直接说内容（例如"上线两周日均收益 2.5w"）；编号只写在 refs、exp、points、focus 里
- 每段 3~5 道追问，覆盖：具体做了什么、数字的口径/对照组/归因、个人贡献占多少、如果重来会怎么改；素材里出现的关键数字要逐个追问口径
- 追问里出现的数字只能来自它 refs 引用的素材，不能编造；refs 只能填下面给出的 M 编号
- risks 只写 JD 明确写出的硬技能、硬经验要求（例如熟练 SQL、AUC/F1、某行业经验），素材里没有、或只是一笔带过的；学历、专业、届别、兴趣、软素质不写；最多 4 条；每条 prep 给 1~3 个具体动作（例如"手写一条 group by + join + 窗口函数的 SQL，算每个商家近 7 天日均订单和环比"）。"可能的缺口"只是提示，要结合素材判断
- whyRole、intro、transfer 里描述 TA 的角色，只能用素材里的原词：素材写"参与""协助""在 mentor 指导下"的，不能说成"主导""负责""独立"；数字只能用素材里有的
- 反问要具体到这个岗位和团队，不要问"团队氛围怎么样"这类泛泛的
- 【人名1】这类占位符保持原样`;

/** A：简历深挖 + 风险点 + 表达 */
export async function buildPlanA(p: PrepData, pool: Pool, brief: CompanyBrief | null): Promise<PrepPlan> {
  const local = new Set(pool.cards.filter((c) => c.localOnly).map((c) => c.id));
  const cands = pool.lines.filter((l) => (l.kind === "卡片原句" || l.kind === "资料证据") && !(l.cardId && local.has(l.cardId)));
  const r = await rank(red(pool, `${p.title}\n${p.jd.text}`), cands.map((l) => ({ id: l.id, text: red(pool, l.embed ?? l.text), group: l.cardId })), { k: MATERIALS, perGroup: PER_CARD, groupWeight: cardWeights(pool, p.title) });

  // 素材：按 JD 要点挑出的 + 这些经历里带数字的原句
  const picked = r.ranked.map((x) => cands.find((l) => l.id === x.id)!);
  const cardIds = [...new Set(picked.map((l) => l.cardId).filter(Boolean))] as string[];
  for (const id of cardIds) {
    const extra = cands.filter((l) => l.cardId === id && l.kind === "卡片原句" && /\d/.test(l.text) && !picked.includes(l)).slice(0, NUM_LINES);
    picked.push(...extra);
  }
  const code = new Map(picked.map((l, i) => [`M${i + 1}`, l])); // M 编号 → 素材
  const alias = new Map(cardIds.map((id, i) => [`E${i + 1}`, id])); // E 编号 → 经历
  const points = r.points.map((s) => restore(s, pool.map).trim());
  // 模型常把内部编号写进正文（"M9 里…""E3""对应 P1"）：M 编号去掉（依据另有展示），E 换成经历名，P 换成"JD 第几条"（没有 JD 时去掉）
  const back = (s: unknown) =>
    human(restore(String(s ?? ""), pool.map), {
      E: (n) => labelOf(pool, alias.get(`E${n}`)),
      P: (n) => (n >= 1 && n <= points.length ? `JD 第 ${n} 条` : ""),
    });
  const vector = r.by === "向量+关键词";
  const weak = r.coverage.map((c, i) => ({ c, i })).filter(({ c }) => (vector ? c < WEAK : c === 0)).map(({ i }) => i);
  const mats = [...alias]
    .map(([a, id]) => {
      const ls = [...code].filter(([, l]) => l.cardId === id);
      return `${a} ${red(pool, labelOf(pool, id))}\n${ls.map(([m, l]) => `  ${m} ${red(pool, l.text)}${l.note ? `（提炼：${red(pool, l.note)}）` : ""}`).join("\n")}`;
    })
    .join("\n");

  const out = await chatJson<{
    deepDive?: { exp?: string; points?: number[]; why?: string; questions?: { q?: string; kind?: string; refs?: string[] }[]; transfer?: string }[];
    risks?: { need?: string; why?: string; prep?: string[] }[];
    pitch?: { whyRole?: string; intro?: string; focus?: string[]; ask?: string[] };
  }>(
    PROMPT_A(p.round),
    [
      `岗位：${p.company} · ${p.title}（${p.round}）`,
      r.points.length ? `JD 要点：\n${r.points.map((x, i) => `P${i + 1} ${x}`).join("\n")}` : p.jd.text ? `JD：\n${red(pool, p.jd.text.slice(0, 2500))}` : "（没有 JD，按岗位名和公司业务判断）",
      weak.length ? `可能的缺口（素材里最接近的也不太像）：${weak.map((i) => `P${i + 1}`).join("、")}` : "",
      brief?.status === "ready" ? `公司速览：${brief.intro}\n业务条线：${brief.businessLine}` : "",
      `TA 的素材：\n${mats}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    0.3,
    LONG_OUTPUT,
  );
  if (!out) throw new Error("模型没有返回准备稿");

  const refOf = (m: unknown) => code.get(String(m).trim())?.id;
  const deepDive: PrepPlan["deepDive"] = [];
  for (const d of out.deepDive ?? []) {
    const cardId = alias.get(String(d.exp ?? "").trim());
    if (!cardId || deepDive.some((x) => x.cardId === cardId)) continue;
    const cardTexts = [...code.values()].filter((l) => l.cardId === cardId).map((l) => l.text);
    const questions: PlanQuestion[] = [];
    for (const q of d.questions ?? []) {
      const text = back(q.q);
      if (!text) continue;
      const refs = [...new Set((q.refs ?? []).map(refOf).filter((v): v is string => Boolean(v)))];
      // 数字只能来自引用的素材；没写引用的，按这段经历的全部素材核对
      const basis = refs.length ? refs.map((id) => picked.find((l) => l.id === id)!.text).join("\n") : cardTexts.join("\n");
      const n = numbersOk(text, basis);
      const kind = QUESTION_KINDS.includes(q.kind as PlanQuestion["kind"]) ? (q.kind as PlanQuestion["kind"]) : "其他";
      questions.push(n.ok ? { q: text, kind, refs, status: "可用" } : { q: text, kind, refs, status: "待核对", issue: `出现了素材里没有的数字：${n.extra.join("、")}` });
    }
    if (!questions.length) continue;
    deepDive.push({
      cardId,
      label: labelOf(pool, cardId),
      points: (d.points ?? []).map((x) => Number(x) - 1).filter((x) => x >= 0 && x < points.length),
      why: back(d.why),
      questions: questions.slice(0, 5),
      transfer: back(d.transfer),
    });
    if (deepDive.length >= 4) break;
  }

  const risks = (out.risks ?? [])
    .map((x) => ({ need: back(x.need), why: back(x.why), prep: (x.prep ?? []).map(back).filter(Boolean).slice(0, 3) }))
    .filter((x) => x.need)
    .slice(0, 4);
  const pt = out.pitch ?? {};
  const pitch = {
    whyRole: back(pt.whyRole),
    intro: back(pt.intro),
    focus: (pt.focus ?? []).map((e) => labelOf(pool, alias.get(String(e).trim()))).filter(Boolean),
    ask: (pt.ask ?? []).map(back).filter(Boolean).slice(0, 3),
  };

  return { materials: picked.map((l) => toMatch(pool, l)), points, deepDive, risks, pitch, at: new Date().toISOString() };
}

const PROMPT_B = `你帮一名应届生准备面试里的业务部分。根据下面的调研发现（每条都来自已核对过的网页原文）写，只输出 JSON：
{"facts":[{"text":"最新情况，一句话，写明时间","refs":[来源编号]}],
 "model":"这个岗位所在团队大概在做什么，两三句（这是推断，面试时可以反问确认）",
 "formulas":["把业务拆开的公式，例如：商业化收入 = 活跃商家数 × 付费渗透率 × ARPU"],
 "questions":[{"q":"面试官可能问的业务题","approach":"答题思路：按什么拆、每项给一个具体动作、最后提什么护栏指标，三四句","use":["M2"]}]}
要求：
- facts 4~8 条，只能来自调研发现，数字必须和发现里的一致，每条写 refs（发现后面方括号里的来源编号）
- formulas 1~2 条，和这个岗位的业务直接相关
- questions 3~5 道；use 填回答时可以用上的 TA 的经历素材（M 编号），能迁移过去的优先；没有就空数组
- 不要编造调研发现里没有的事实和数字；给人看的文字里不要写 M 编号；【人名1】这类占位符保持原样`;

/** B：公司业务（用深度调研的发现）。plan 是 A 的结果，素材编号沿用 A 的 */
export async function buildPlanB(p: PrepData, plan: PrepPlan, research: Research, pool: Pool): Promise<NonNullable<PrepPlan["business"]>> {
  const findings = research.findings.filter((f) => f.subject === "目标公司");
  if (!findings.length) throw new Error("深度调研没有关于这家公司的发现");
  const dateOf = (id: number) => research.sources.find((s) => s.id === id)?.date ?? "";
  const lines = findings.map((f) => `- [${f.section}] ${f.claim}（原文：${f.quote}）[${f.sourceId}]${dateOf(f.sourceId) ? ` ${dateOf(f.sourceId)}` : ""}`);
  const code = new Map(plan.materials.map((m, i) => [`M${i + 1}`, m]));
  const mats = [...code].map(([c, m]) => `${c} [${red(pool, m.label)}] ${red(pool, m.text)}`).join("\n");

  const out = await chatJson<{ facts?: { text?: string; refs?: number[] }[]; model?: string; formulas?: string[]; questions?: { q?: string; approach?: string; use?: string[] }[] }>(
    PROMPT_B,
    [`岗位：${p.company} · ${p.title}`, p.jd.text ? `JD：\n${red(pool, p.jd.text.slice(0, 2000))}` : "", `调研发现：\n${lines.join("\n")}`, `TA 的经历素材：\n${mats}`].filter(Boolean).join("\n\n"),
    0.3,
    LONG_OUTPUT,
  );
  if (!out) throw new Error("模型没有返回业务部分");
  const back = (s: unknown) => human(restore(String(s ?? ""), pool.map));
  const valid = new Set(research.sources.map((s) => s.id));

  // 事实：来源编号要存在；数字必须出现在这些来源的发现里（含来源日期）
  const facts: { text: string; refs: number[] }[] = [];
  for (const f of out.facts ?? []) {
    const text = back(f.text);
    const refs = [...new Set((f.refs ?? []).map(Number).filter((n) => valid.has(n)))];
    if (!text || !refs.length) continue;
    const basis = findings.filter((x) => refs.includes(x.sourceId)).map((x) => `${x.claim} ${x.quote} ${dateOf(x.sourceId)}`).join("\n");
    if (!numbersOk(text, basis).ok) continue;
    facts.push({ text, refs });
  }
  return {
    researchId: research.id,
    facts: facts.slice(0, 8),
    model: back(out.model),
    formulas: (out.formulas ?? []).map(back).filter(Boolean).slice(0, 2),
    questions: (out.questions ?? [])
      .map((q) => ({ q: back(q.q), approach: back(q.approach), use: [...new Set((q.use ?? []).map((c) => code.get(String(c).trim())?.ref).filter((v): v is string => Boolean(v)))] }))
      .filter((q) => q.q)
      .slice(0, 5),
  };
}
