import "server-only";
import { chatJson, LONG_OUTPUT } from "../extract";
import { buildContext, redact, restore } from "../redact";
import { evidenceText, rank } from "../retrieve";
import { readEvidence } from "../store";
import type { ExperienceCard, Settings } from "../types";
import { normForQuote } from "./fetch-page";
import type { ChannelGroup, Report, Research } from "./types";

/**
 * 阶段 B：生成报告（一次模型调用，不联网）。
 * 输入：JD、调研发现（带来源编号）、你的经历卡片（简历原句 + 资料证据原文，多了按 JD 要点挑 30 条；先在本地脱敏；标了"仅本地"的不发）。
 * 输出后在本地核对：经历证据必须是卡片下的原句；引用的来源编号必须真实存在；业务题没有来源的不要。
 */
const PROMPT = `你是求职面试准备顾问。根据下面的 JD、调研发现和候选人的经历，写一份面试前的调研报告。
候选人经历里的【敏感词1】【人名1】等是脱敏占位符，原样保留。

输出 JSON，结构如下（所有字段都要有，没有就留空字符串或空数组）：
{
 "jd": {
   "abilities": [{"name":"能力或工作内容（4-10字）","detail":"JD 里的具体要求","match":"强|中|弱","evidence":[{"card":卡片编号,"quote":"该卡片下的原句"}],"gap":"还欠缺什么"}],
   "conclusion":"面试时优先讲哪段经历、哪个能力要补例子"
 },
 "businessLine": {"type":"电商/直播/广告/AI/游戏/本地生活/出海/其他","position":"这条业务在公司里的位置","products":[{"name":"","desc":"","refs":[来源编号]}],"conclusion":""},
 "firstHand": ["建议候选人自己做的第一手调研，如下载某产品体验某流程、看某团队的其他 JD"],
 "competitive": {
   "goal":"这次竞品对比要回答的面试问题",
   "reference":"参照产品名称（来自候选人的实习经历）",
   "relation":"直接竞品|间接竞品|替代品",
   "relationReason":"为什么可比",
   "dimensions":[{"name":"商业模式|业务位置|目标用户和市场|近一年动态|竞争格局|增长和运营","target":"目标业务怎么做","reference":"参照产品怎么做","insight":"差异和对候选人的启示","refs":[来源编号]}],
   "swot":{"S":[],"W":[],"O":[],"T":[]},
   "conclusion":"",
   "transferable":["候选人可以迁移过去的经验"],
   "talkingPoints":["面试时可以主动讲的观点，2-3 条"]
 },
 "homework":["面试前还要补的功课"],
 "bizQuestions":[{"q":"面试官可能问的业务题，像当面问的一句话","why":"为什么会问：依据哪条调研发现","refs":[来源编号],"use":[{"card":卡片编号,"quote":"可以用来回答的该卡片下的原句"}]}]
}

硬性规则：
1. jd.abilities 3~5 项，对应 JD 里最核心的要点（没有 JD 就按岗位名推断 3 项）。evidence 的 quote 必须从对应卡片下的原句里原样复制，不能改写；没有合适证据就留空数组并把 match 设为"弱"。
1b. bizQuestions 3~5 道：结合调研发现里这条业务的近况、产品、竞争和打法，问候选人怎么看、怎么做；每道都必须有 refs；use 同样只能原样复制卡片下的原句，没有就留空数组。
2. 关于公司和产品的事实，只能来自"调研发现"，并在 refs 里写上对应的来源编号；发现里没有的信息写"信息不足"，不要凭印象补充。
3. 参照产品那一侧，可以同时使用调研发现和候选人的经历。
4. 每个部分都要有 conclusion，写清楚"所以呢"。
5. 只输出 JSON。`;

/** 每张卡片下给模型看的原句：简历原句 + 资料证据的原文（隐藏的不用） */
async function cardLines(cards: ExperienceCard[]) {
  const ev = (await readEvidence()).filter((e) => !e.hidden);
  return cards.map((c) => [...c.details.map((d) => ({ text: d, embed: d })), ...ev.filter((e) => e.cardId === c.id).map((e) => ({ text: e.quote, embed: evidenceText(e) }))]);
}

const MAX_LINES = 30; // 原句多了按 JD 要点挑最相关的这么多条

export async function buildReport(r: Research, cards: ExperienceCard[], settings: Settings): Promise<Report> {
  const usable = cards.filter((c) => !c.localOnly);
  const lines = await cardLines(usable);
  const findingText = r.findings.map((f) => `- [${f.subject} · ${f.section}] ${f.claim}（来源 [${f.sourceId}]）`);

  // 本地脱敏：经历和"参照产品"的发现用同一张占位表，保证参照公司名在两边一致
  const ctx = buildContext(settings, [...usable.flatMap((c) => [c.company, c.role]), ...lines.flat().map((l) => l.text), ...findingText]);
  const map: Record<string, string> = {};
  const red = (t: string) => redact(t, ctx, map).text;

  // 按 JD 要点挑原句（每段经历最多 8 条），检索不可用时按关键词
  const all = lines.flatMap((ls, i) => ls.map((l, j) => ({ id: `${i}-${j}`, text: red(l.embed), group: String(i) })));
  const keep = all.length > MAX_LINES ? new Set((await rank(red(`${r.jobTitle}\n${r.jd}`), all, { k: MAX_LINES, perGroup: 8 })).ranked.map((x) => x.id)) : null;
  const cardText = usable
    .map((c, i) => {
      const ls = lines[i].filter((_, j) => !keep || keep.has(`${i}-${j}`));
      return ls.length ? `【卡片${i + 1}】${c.company} · ${c.role}（${c.start}-${c.end}）\n${ls.map((l) => `- ${l.text}`).join("\n")}` : "";
    })
    .filter(Boolean);
  const safeCards = cardText.map(red);
  const safeFindings = r.findings.map((f, i) => (f.subject === "参照产品" ? redact(findingText[i], ctx, map).text : findingText[i]));
  const sources = r.sources.map((s) => `[${s.id}] ${s.title} | ${s.site} | ${s.channel} | 可信度 ${s.tier}${s.date ? ` | ${s.date}` : ""}`);

  const user = [
    `【目标公司】${r.company}${r.jobTitle ? `\n【岗位】${r.jobTitle}` : ""}`,
    `【JD】\n${r.jd || "（未提供 JD，请根据岗位名称和调研发现推断）"}`,
    `【调研发现】\n${safeFindings.join("\n") || "（无）"}`,
    `【来源列表】\n${sources.join("\n") || "（无）"}`,
    `【候选人经历】\n${safeCards.join("\n\n") || "（素材库里还没有经历卡片）"}`,
    r.refCompany ? `【参照产品所在公司】${redact(r.refCompany, ctx, map).text}` : "【参照产品】无",
  ].join("\n\n");

  const raw = restore(await chatJson(PROMPT, user, { maxTokens: LONG_OUTPUT }), map) as Record<string, unknown> | null;
  if (!raw) throw new Error("模型没有返回有效的报告");
  return verify(raw, r, usable, lines.map((ls) => ls.map((l) => l.text)));
}

/** 本地核对：证据原句、来源编号；并由程序整理"找到的渠道" */
function verify(raw: Record<string, unknown>, r: Research, cards: ExperienceCard[], texts: string[][]): Report {
  const warnings: string[] = [];
  const validRefs = new Set(r.sources.map((s) => s.id));
  const cleanRefs = (refs: unknown) => (Array.isArray(refs) ? refs.map(Number).filter((n) => validRefs.has(n)) : []);
  const arr = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  const str = (x: unknown) => (typeof x === "string" ? x : "");

  const jd = (raw.jd ?? {}) as Record<string, unknown>;
  // 经历证据：必须是那张卡片下的简历原句或资料证据原文
  const evidenceOf = (list: unknown) =>
    arr<Record<string, unknown>>(list).map((e) => {
      const i = Number(e.card) - 1;
      const card = cards[i];
      const quote = str(e.quote);
      const q = normForQuote(quote);
      const verified = Boolean(card && q.length >= 4 && (texts[i] ?? []).some((d) => normForQuote(d).includes(q)));
      if (!verified) warnings.push(`「${quote.slice(0, 20)}…」在经历卡片里找不到原句，可能被改写过`);
      return { cardId: card?.id ?? "", label: card ? `${card.company} · ${card.role}` : "未知经历", quote, verified };
    });
  const abilities = arr<Record<string, unknown>>(jd.abilities)
    .slice(0, 5)
    .map((a) => ({
      name: str(a.name),
      detail: str(a.detail),
      match: (["强", "中", "弱"].includes(str(a.match)) ? str(a.match) : "中") as "强" | "中" | "弱",
      gap: str(a.gap),
      evidence: evidenceOf(a.evidence),
    }));
  // 业务题：没有来源的不要
  const bizQuestions = arr<Record<string, unknown>>(raw.bizQuestions)
    .map((b) => ({ q: str(b.q), why: str(b.why), refs: cleanRefs(b.refs), use: evidenceOf(b.use).filter((e) => e.verified) }))
    .filter((b) => b.q && b.refs.length)
    .slice(0, 5);

  const bl = (raw.businessLine ?? {}) as Record<string, unknown>;
  const comp = (raw.competitive ?? {}) as Record<string, unknown>;
  const swot = (comp.swot ?? {}) as Record<string, unknown>;
  const dimensions = arr<Record<string, unknown>>(comp.dimensions).map((d) => {
    const refs = cleanRefs(d.refs);
    if (!refs.length) warnings.push(`竞品对比「${str(d.name)}」没有来源支持，仅供参考`);
    return { name: str(d.name), target: str(d.target), reference: str(d.reference), insight: str(d.insight), refs };
  });

  // 找到的渠道：按来源的渠道类型整理（程序统计，不靠模型）
  const groups = new Map<string, { group: ChannelGroup; channel: string; sources: number[] }>();
  for (const s of r.sources) {
    const k = `${s.group}|${s.channel}`;
    const g = groups.get(k) ?? { group: s.group, channel: s.channel, sources: [] };
    g.sources.push(s.id);
    groups.set(k, g);
  }

  return {
    jd: { abilities, conclusion: str(jd.conclusion) },
    businessLine: {
      type: str(bl.type),
      position: str(bl.position),
      products: arr<Record<string, unknown>>(bl.products).map((p) => ({ name: str(p.name), desc: str(p.desc), refs: cleanRefs(p.refs) })),
      conclusion: str(bl.conclusion),
    },
    channels: { found: [...groups.values()].sort((a, b) => a.group.localeCompare(b.group)), firstHand: arr<string>(raw.firstHand).map(String) },
    competitive: {
      goal: str(comp.goal),
      reference: str(comp.reference),
      relation: (["直接竞品", "间接竞品", "替代品"].includes(str(comp.relation)) ? str(comp.relation) : "") as Report["competitive"]["relation"],
      relationReason: str(comp.relationReason),
      dimensions,
      swot: { S: arr<string>(swot.S).map(String), W: arr<string>(swot.W).map(String), O: arr<string>(swot.O).map(String), T: arr<string>(swot.T).map(String) },
      conclusion: str(comp.conclusion),
      transferable: arr<string>(comp.transferable).map(String),
      talkingPoints: arr<string>(comp.talkingPoints).map(String),
    },
    homework: arr<string>(raw.homework).map(String),
    bizQuestions,
    warnings: [...new Set(warnings)],
  };
}
