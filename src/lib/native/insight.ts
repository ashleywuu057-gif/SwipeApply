import "server-only";
import { llmConfig } from "../extract";
import { buildContext, redact, restore } from "../redact";
import { evidenceText, topK } from "../retrieve";
import { readEvidence, readLibrary, readSourceText } from "../store";
import type { LibraryData } from "../types";
import type { JobPosting } from "../tracker-types";
import type { EvidenceDoc } from "./feed";
import { chatJson } from "./llm";
import { cardTag } from "./resume";
import { INSIGHT_V, insightView, readInsight, saveInsight, type Insight } from "./store";
import type { InsightView, MatchReason } from "./types";

/** 素材库里除简历以外的资料（业务知识、项目复盘、工作文档），取开头一段用来匹配 */
export async function loadDocs(lib?: LibraryData): Promise<EvidenceDoc[]> {
  const l = lib ?? (await readLibrary());
  const out: EvidenceDoc[] = [];
  for (const s of l.sources) {
    if (s.category === "简历") continue;
    out.push({ id: s.id, name: s.name, category: s.category, cardId: s.cardId, text: (await readSourceText(s.id)).slice(0, 4000) });
  }
  return out;
}

const PROMPT = `你帮一名应届生判断：这个岗位和 TA 的经历、积累的资料有哪些对得上的地方。
下面给出岗位信息，和 TA 的素材索引：L 开头是简历里的经历原句，V 开头是从 TA 的复盘、工作文档里提炼的经历证据，D 开头是 TA 整理的其他资料（业务知识等）的标题和开头。
只输出 JSON：{"reasons":[{"need":"岗位看重的点，4~10 个字，例如：具身智能行业认知","ref":"L3、V2 或 D2"}],"gaps":[{"need":"JD 明确看重、但索引里找不到证据的点，4~10 个字"}]}
要求：
- reasons 最多 3 条，按相关程度排序；每条只引用一个编号，编号必须来自下面的索引
- 要有实质关联（同一行业/领域、同类能力、同类产品），不要牵强；没有就输出空数组。以下都算牵强，不要用：
  · 只是字面沾边（例如论文里审计 AI 绘图的视觉偏见，不能对应"影像视觉审美"）
  · 证据里写的是别人主导、TA 只做了边缘部分（"研发在推进，我参与了…"），不能支撑"××经验"这类要求
  · D 开头的资料只能支撑"行业/业务认知"这类要求，而且资料主题要和这个要求直接对口；个人笔记、日报、面试准备类资料不能当证据
- 选理由时的优先级（用户定的）：业务相关 → 岗位职能相关 → 行业相关，大厂经历优先；标了"学术"的经历（论文）只在 AI 强相关岗位才用
- gaps 最多 2 条：只写 JD 里明确写出的硬性要求或核心职责（例如：3 年以上 B 端经验、熟练使用 SQL），素材索引里确实找不到对应证据的才写；学历、专业、届别、毕业时间、语言证书这类门槛不要写（索引里本来就没有教育背景）；没有 JD 时输出空数组
- 【人名1】这类占位符保持原样`;

/** AI 分析匹配理由和差距（在预取时调用，结果缓存；JD 抓到后会按 JD 重算一次） */
export async function ensureInsight(job: JobPosting, jd: string): Promise<InsightView | null> {
  if (!llmConfig().enabled) return null;
  const basis = jd ? "JD" : "岗位名";
  const cached = await readInsight(job.id);
  if (cached && (cached.v ?? 1) >= INSIGHT_V && (cached.basis === basis || basis === "岗位名")) return insightView(cached);

  const lib = await readLibrary();
  const local = new Set(lib.cards.filter((c) => c.localOnly).map((c) => c.id));
  const cards = lib.cards.filter((c) => !c.localOnly);
  const docs = (await loadDocs(lib)).filter((d) => !(d.cardId && local.has(d.cardId)));
  if (!cards.length && !docs.length) return null;

  const ctx = buildContext(lib.settings, [...cards.flatMap((c) => [c.company, c.role, ...c.details]), ...docs.flatMap((d) => [d.name, d.text])]);
  const map: Record<string, string> = {};
  const red = (t: string) => redact(t, ctx, map).text;
  const lines: { id: string; text: string; cardId: string }[] = [];
  const docIdx: { id: string; doc: EvidenceDoc }[] = [];
  const index: string[] = [];
  // 资料里提炼出的证据（V）：比资料开头一段更准，有证据的资料就不再用开头一段（D）
  const allEvidence = (await readEvidence()).filter((e) => !e.hidden && cards.some((c) => c.id === e.cardId));
  const withEvidence = new Set(allEvidence.map((e) => e.sourceId));
  // 证据多了会超出索引上限被截掉：按 JD（没有就按岗位名）挑最相关的 40 条
  const keep = await topK(
    red(`${job.title}\n${job.industry}\n${jd}`),
    allEvidence.map((e) => ({ id: e.id, text: red(evidenceText(e)) })),
    40,
  );
  const evidence = keep ? allEvidence.filter((e) => keep.has(e.id)) : allEvidence;
  let n = 0;
  let v = 0;
  for (const c of cards) {
    index.push(`${red(c.company)} · ${red(c.role)}［${cardTag(c)}］`);
    for (const d of c.details) {
      const id = `L${++n}`;
      lines.push({ id, text: d, cardId: c.id });
      index.push(`  ${id} ${red(d)}`);
    }
    for (const e of evidence.filter((x) => x.cardId === c.id)) {
      const id = `V${++v}`;
      lines.push({ id, text: e.quote, cardId: c.id });
      index.push(`  ${id} ${red([e.action, e.result].filter(Boolean).join("，") || e.quote.slice(0, 80))}`);
    }
  }
  // 个人笔记类资料（日报、面试准备）不能当匹配证据
  docs.filter((d) => !withEvidence.has(d.id) && !/日报|日记|面试准备/.test(d.name)).forEach((d, i) => {
    const id = `D${i + 1}`;
    docIdx.push({ id, doc: d });
    index.push(`${id} [${d.category ?? "资料"}] ${red(d.name)} —— ${red(d.text.replace(/\s+/g, " ").slice(0, 150))}`);
  });

  const r = await chatJson<{ reasons?: { need?: string; ref?: string }[]; gaps?: { need?: string }[] }>(
    PROMPT,
    `岗位：${job.company} · ${job.title}\n行业：${job.industry || "未注明"}\n${jd ? `JD：\n${jd.slice(0, 2000)}` : "（还没有 JD）"}\n\n素材索引：\n${index.join("\n").slice(0, 12000)}`,
  ).catch(() => null);
  if (!r) return null;
  const reasons: MatchReason[] = [];
  for (const x of r.reasons ?? []) {
    const ref = String(x.ref ?? "").trim();
    const need = restore(String(x.need ?? ""), map).trim().slice(0, 20);
    if (!need) continue;
    const line = lines.find((l) => l.id === ref);
    const doc = docIdx.find((d) => d.id === ref)?.doc;
    // 核对：引用的编号必须存在，展示的是原句 / 资料名，不是模型写的话
    if (line) reasons.push({ need, have: line.text, cardId: line.cardId, source: "AI 分析" });
    else if (doc) reasons.push({ need, have: `${doc.category ?? "资料"}《${doc.name}》`, cardId: doc.cardId ?? undefined, source: "AI 分析" });
    if (reasons.length >= 3) break;
  }
  // 差距只在有 JD 时才可信；和对上的点重名的去掉
  const gaps = jd
    ? [...new Set((r.gaps ?? []).map((g) => restore(String(g.need ?? ""), map).trim().slice(0, 20)))].filter((g) => g && !reasons.some((x) => x.need === g)).slice(0, 2)
    : [];
  const saved: Insight = { jobId: job.id, reasons, gaps, basis, v: INSIGHT_V, at: new Date().toISOString() };
  await saveInsight(saved);
  return insightView(saved);
}
