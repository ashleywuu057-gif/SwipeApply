import "server-only";
import { llmConfig } from "./extract";
import { chatJson, numbersOk } from "./native/llm";
import { buildContext, redact, restore } from "./redact";
import { newId, readLibrary, readSourceText, updateEvidence } from "./store";
import type { Evidence, ExperienceCard, SourceDoc } from "./types";

/**
 * 从复盘、工作文档里提炼证据条目（问题 → 行动 → 结果 + 规模），给写简历和岗位匹配用。
 * 两道核对，任一不通过就丢掉这条：
 *   1. quote 必须能在原文里逐字找到（忽略空白和标点）
 *   2. 问题、行动、结果、规模里的数字，必须都在 quote 里出现过
 * 角色词（主导/负责/参与/协助）只有 quote 里真写了才保留。
 * 发给模型前先脱敏；标了「仅本地」的经历和它下面的资料不处理。
 */

const CHUNK = 3000; // 每次发给模型的字数
const MAX_CHUNKS = 20; // 一份资料最多处理这么多段（约 6 万字）
const ROLES = ["主导", "负责", "参与", "协助"] as const;

/** 这份资料要不要提炼：挂在经历下的复盘和工作文档；简历深挖这种跨多段经历的，让模型判断属于哪段 */
export function eligible(src: SourceDoc, cards: ExperienceCard[]) {
  // 代码、数据、图片写不进简历，不提炼
  if (/\.(py|ipynb|js|ts|sql|r|csv|tsv|json|ya?ml|png|jpe?g|gif|webp)$/i.test(src.name)) return false;
  if (/深挖/.test(src.name)) return true;
  if (src.category !== "项目复盘" && src.category !== "工作源文件") return false;
  const card = cards.find((c) => c.id === src.cardId);
  return Boolean(card && !card.localOnly);
}

const PROMPT = `你帮一名求职者从 TA 自己写的复盘、工作文档里，提炼能写进简历的经历证据。
只输出 JSON：
{"items":[{"exp":"E1","quote":"原文片段","problem":"要解决的问题","action":"TA 做了什么","result":"结果","role":"主导|负责|参与|协助|","scope":{"users":"","team":"","money":"","market":"","stage":""}}]}

规则：
1. 只提炼 TA 本人做过的事，每条必须有 action（TA 做了什么）。行业知识、学习笔记、别人的做法、泛泛的方法论、单独一行数据结果都不要。
2. 宁少勿碎：同一次分析、同一个项目的问题、做法和结果，合成一条，不要一行数据拆一条。例如一份实验分析报告，通常只提炼成"做了什么分析 + 核心结论"一到两条。
3. quote 必须从原文里逐字复制连续的一到三句（或连续几行），不超过 200 字，不改一个字；其余字段都只能用 quote 里有的信息。
4. problem、action、result 各不超过 40 字，可以精简措辞，但不能加入 quote 里没有的事实、数字、职责或成果；quote 里没有的留空字符串。
5. role：quote 里明确写了"主导""负责""参与""协助"之一才填那个词，否则留空。不要推断。
6. scope：用户规模、团队人数、金额、市场、产品阶段，quote 里有才填，原样抄写。
7. exp：这条属于下面哪段经历，填编号。一份资料可能同时讲好几段经历，每条单独判断：先看原文前面给出的「所在章节」和原文里的标题——某家公司标题下的子项目、调研、玩具项目，都算那段经历；再看原文里提到的公司、项目、业务。确实不属于列表里任何一段（例如课程作业）或看不出来的，填空字符串，不要硬套。
8. 这一段最多 5 条，挑信息量最大的；没有值得提炼的就输出 {"items":[]}。
9. 【人名1】【敏感词1】这类占位符保持原样。`;

type Raw = { exp?: string; quote?: string; problem?: string; action?: string; result?: string; role?: string; scope?: Record<string, unknown> };

/** SQL、代码行：写不进简历，发给模型前去掉，模型摘出来的也不要 */
function looksLikeCode(s: string) {
  const t = s.trim();
  if (/^(select|from|where|and|or|left join|join|group by|order by|with|union|having|on|as|,)\b/i.test(t)) return true;
  if (/\b(select|from|join|group by)\b.*\b(from|where|on|by)\b/i.test(t)) return true;
  if (/(^|\s)(def|import|return|const|let|function)\s/.test(t) || /[{};]\s*$/.test(t)) return true;
  const sym = (t.match(/[()_=,'"`<>[\]{}*]/g) ?? []).length;
  return t.length >= 12 && sym / t.length > 0.12 && !/[一-鿿]{6}/.test(t);
}

/**
 * 忽略空白和标点后比较，PDF、Word 转出来的换行和全半角标点不影响。
 * 先做 NFKC：有些 PDF 转出来的是长得一样的"康熙部首"字符（⽬⼒⾃），模型抄写时会写成普通的"目力自"。
 * PDF 里还会夹着看不见的控制字符（\u0001 之类），模型抄写时不会带上，也一并忽略。
 */
const norm = (s: string) => s.normalize("NFKC").replace(/[\s\p{P}\p{S}\p{C}]/gu, "");

/**
 * 按段落切成小块，每块带上它所在的章节（面包屑：经历 › 小节 › 小标题）。
 * 例如一块从「2.3 表情包」中间开始，模型也能看到上面的「2. 某研究院」，知道这是哪段经历。
 *
 * 一级（经历）只认两种：提到了某段经历的公司名（"1. 某咨询公司""某外企："），或者接着上一个一级编号往下数（"3. 快手"之后的"4. tiktok"）。
 * 这样正文里的编号列表（"1. 市场规模"）、编号问句不会被当成经历。
 */
function chunks(text: string, companies: string[]) {
  const out: { text: string; context: string }[] = [];
  let l1 = "";
  let n1 = 0;
  let l2 = "";
  let l3 = "";
  let cur = "";
  let context = "";
  const names = companies.map((c) => c.trim().toLowerCase()).filter((c) => c.length >= 2);
  let fence = false;
  for (const para of text.split(/\n+/)) {
    // 代码块和 SQL 行不发给模型
    if (para.trim().startsWith("```")) {
      fence = !fence;
      continue;
    }
    if (fence || looksLikeCode(para)) continue;
    if (cur && cur.length + para.length > CHUNK) {
      out.push({ text: cur, context });
      cur = "";
    }
    if (!cur) context = [l1, l2, l3].filter(Boolean).join(" › ");
    cur += (cur ? "\n" : "") + para.slice(0, CHUNK * 2);

    const t = para.trim();
    if (!t || t.length > 30 || /[?？]/.test(t)) continue;
    const top = t.match(/^(\d+)[.、．]\s*(\S.*)$/);
    const sub = t.match(/^\d+\.\d+(\.\d+)*\s*\S/);
    // 标题和卡片上的公司名互相包含都算（卡片写"北京某某研究院"，标题写"某某研究院"）
    const core = t.replace(/^\d+[.、．]\s*|[：:]$/g, "").trim().toLowerCase();
    const namesCompany = names.some((c) => t.toLowerCase().includes(c) || (core.length >= 2 && c.includes(core)));
    if ((top && (namesCompany || Number(top[1]) === n1 + 1)) || (!top && !sub && namesCompany)) {
      l1 = t;
      n1 = top ? Number(top[1]) : n1;
      l2 = l3 = "";
    } else if (sub) {
      l2 = t;
      l3 = "";
    } else if (/^([一二三四五六七八九十]+[、.．].{1,20}|.{2,14}[：:])$/.test(t) || top) l3 = t;
  }
  if (cur.trim()) out.push({ text: cur, context });
  return out.slice(0, MAX_CHUNKS);
}

/** 核对一条模型输出，通过就返回证据条目，否则返回丢弃的原因 */
export function verify(r: Raw, original: string, cardId: string, sourceId: string): Evidence | string {
  const quote = String(r.quote ?? "").trim();
  if (norm(quote).length < 10) return "原文片段太短";
  if (!norm(original).includes(norm(quote))) return "原文里找不到这段片段";
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const scope: Evidence["scope"] = {};
  for (const k of ["users", "team", "money", "market", "stage"] as const) {
    const v = s(r.scope?.[k]);
    if (v) scope[k] = v;
  }
  const fields = { problem: s(r.problem).slice(0, 80), action: s(r.action).slice(0, 80), result: s(r.result).slice(0, 80) };
  if (!fields.action) return "没有 TA 做了什么（只有结果或数据）";
  if (looksLikeCode(quote)) return "是代码";
  const n = numbersOk([fields.problem, fields.action, fields.result, ...Object.values(scope)].join(" "), quote);
  if (!n.ok) return `出现了原文片段里没有的数字：${n.extra.join("、")}`;
  const role = ROLES.find((x) => x === s(r.role) && quote.includes(x)) ?? "";
  return { id: newId(), cardId, sourceId, quote, ...fields, scope, role, createdAt: new Date().toISOString() };
}

/** 提炼一份资料，结果覆盖这份资料之前的证据（你隐藏过的、原文还在的条目保持隐藏） */
export async function extractEvidence(sourceId: string): Promise<{ kept: number; dropped: string[]; unassigned: string[] } | { error: string }> {
  if (!llmConfig().enabled) return { error: "还没有配置 LLM_API_KEY" };
  const lib = await readLibrary();
  const src = lib.sources.find((s) => s.id === sourceId);
  if (!src) return { error: "资料不存在" };
  if (!eligible(src, lib.cards)) return { error: "只提炼挂在经历下的项目复盘、工作源文件，以及简历深挖" };
  const cloud = lib.cards.filter((c) => !c.localOnly && (c.company || c.role));
  const fixed = src.cardId ? cloud.find((c) => c.id === src.cardId) : undefined;
  if (src.cardId && !fixed) return { error: "所属经历标了仅本地，或者还没填公司和岗位，不提炼" };

  const original = await readSourceText(sourceId);
  const ctx = buildContext(lib.settings, [original, src.name, ...cloud.flatMap((c) => [c.company, c.role])]);
  const map: Record<string, string> = {};
  const red = (t: string) => redact(t, ctx, map).text;
  const alias = new Map(cloud.map((c, i) => [`E${i + 1}`, c.id]));
  const exps = cloud.map((c, i) => `E${i + 1} ${red(c.company)} · ${red(c.role)}（${c.start}–${c.end}）`).join("\n");

  const kept: Evidence[] = [];
  const dropped: string[] = [];
  const unassigned: string[] = [];
  const seen = new Set<string>();
  const parts = chunks(original, cloud.map((c) => c.company));
  // 发给模型的文字去掉了代码行，模型摘的片段可能跨过被去掉的行：原文和"模型看到的文字"里能找到都算
  const checkText = `${original}\n${parts.map((p) => p.text).join("\n")}`;
  // 三段一起发，其余排队
  for (let i = 0; i < parts.length; i += 3) {
    const results = await Promise.all(
      parts.slice(i, i + 3).map((p) =>
        chatJson<{ items?: Raw[] }>(
          PROMPT,
          `资料：${red(src.name)}${fixed ? `\n这份资料属于：${red(fixed.company)} · ${red(fixed.role)}（exp 一律填 E${[...alias].findIndex(([, id]) => id === fixed.id) + 1}）` : ""}\n\n经历列表：\n${exps}\n\n${p.context ? `所在章节（这段原文前面最近的标题）：${red(p.context)}\n\n` : ""}原文：\n${red(p.text)}`,
          0,
        ).catch(() => null),
      ),
    );
    for (const r of results)
      for (const item of r?.items ?? []) {
        const x = restore(item, map);
        const cardId = fixed?.id ?? alias.get(String(x.exp ?? "").trim());
        if (!cardId) {
          // 不属于现有经历：不硬挂，留给你看要不要新建卡片（原文找得到的才留）
          const q = String(x.quote ?? "").trim();
          if (norm(q).length >= 10 && norm(checkText).includes(norm(q)) && unassigned.length < 20) unassigned.push(q);
          continue;
        }
        const v = verify(x, checkText, cardId, sourceId);
        if (typeof v === "string") dropped.push(`${v}：${String(x.quote ?? "").slice(0, 30)}`);
        else if (!seen.has(norm(v.quote))) {
          seen.add(norm(v.quote));
          kept.push(v);
        }
      }
  }

  await updateEvidence((list) => {
    const hidden = new Set(list.filter((e) => e.sourceId === sourceId && e.hidden).map((e) => norm(e.quote)));
    for (const e of kept) if (hidden.has(norm(e.quote))) e.hidden = true;
    const rest = list.filter((e) => e.sourceId !== sourceId);
    list.length = 0;
    list.push(...rest, ...kept);
  });
  return { kept: kept.length, dropped, unassigned };
}

/** 后台跑一批（导入确认后、补跑全部时用），一份一份来，出错不影响其他 */
export async function extractMany(sourceIds: string[]) {
  const out: Record<string, Awaited<ReturnType<typeof extractEvidence>>> = {};
  for (const id of sourceIds) out[id] = await extractEvidence(id).catch((e) => ({ error: (e as Error).message }));
  return out;
}
