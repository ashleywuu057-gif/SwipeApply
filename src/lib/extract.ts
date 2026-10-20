import "server-only";
import "./free-proxy"; // 没填自己的 Key 时走免费额度（必须在读 LLM_* 配置之前）
import type { CardType, Category, DraftCard, ExperienceCard } from "./types";
import { CARD_TYPES, CATEGORIES } from "./types";
import { newId } from "./store";
import { restore } from "./redact";
import { Agent, fetch as undiciFetch } from "undici";

/* ================= 模型配置与调用 ================= */

export function llmConfig() {
  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseUrl = (process.env.LLM_BASE_URL?.trim() || "https://api.deepseek.com/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL?.trim() || "deepseek-flash";
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {}
  return { enabled: Boolean(apiKey), apiKey, baseUrl, model, host };
}

/**
 * 调模型接口。连 DeepSeek 时建连常常要 7–12 秒，Node 默认 10 秒建连超时会直接报 fetch failed，
 * 所以这里把建连超时放宽到 30 秒；连不上、连接被重置或服务端临时繁忙时，最多再试 2 次。
 */
const llmAgent = new Agent({ connect: { timeout: 30000 } });
const RETRY_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]);
const RETRY_STATUS = new Set([429, 502, 503, 504]);

export async function llmPost(body: Record<string, unknown>, timeoutMs = 120000) {
  const cfg = llmConfig();
  if (!cfg.enabled) throw new Error("未配置 LLM_API_KEY");
  return postJson(`${cfg.baseUrl}/chat/completions`, cfg.apiKey!, cfg.host, body, timeoutMs);
}

/** 带建连超时和重试的 POST（模型对话、向量接口共用） */
export async function postJson(url: string, apiKey: string, host: string, body: Record<string, unknown>, timeoutMs = 120000) {
  for (let attempt = 1; ; attempt++) {
    const last = attempt === 3;
    try {
      const res = await undiciFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: llmAgent,
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        if (!last && RETRY_STATUS.has(res.status)) {
          await sleep(attempt * 2000);
          continue;
        }
        // 免费额度用完（中转返回 402）：直接显示中转给的那句话
        if (res.status === 402) {
          let msg = "";
          try {
            msg = JSON.parse(text)?.error?.message ?? "";
          } catch {}
          throw new Error(msg || "今天的免费额度用完了，明天再来，或者在 .env.local 里填自己的 Key");
        }
        throw new Error(`模型调用失败 ${res.status}: ${text}`);
      }
      return (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (last || !code || !RETRY_CODES.has(code)) {
        if (code && RETRY_CODES.has(code)) throw new Error(`连不上模型服务（${host}，${code}），已重试 ${attempt} 次，请检查网络`);
        throw e;
      }
      await sleep(attempt * 2000);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 输出较长的调用（调研报告、面试准备稿）用的输出上限。deepseek-flash 是推理模型，思考用的 token 也算在 max_tokens 里，
 * 设小了会把思考和正文一起截断（实测 1500 时 1498 个都花在思考上），所以要给得很宽。
 */
export const LONG_OUTPUT = 32768;

/**
 * 让模型只输出 JSON。maxTokens：输出较长的调用要给足（见 LONG_OUTPUT），否则会被截断成解析不了的半截 JSON。
 * 被截断（finish_reason = length）时重试一次；还是截断就报错说明原因，不悄悄返回 null。
 */
export async function chatJson(system: string, user: string, opts: { maxTokens?: number } = {}): Promise<Record<string, unknown> | null> {
  for (let attempt = 1; ; attempt++) {
    const json = await llmPost({
      model: llmConfig().model,
      temperature: 0,
      response_format: { type: "json_object" },
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }, opts.maxTokens ? 300000 : undefined); // 长输出（含思考）可能超过默认的 2 分钟
    const choice = json.choices?.[0];
    const out = parseJsonLoose(choice?.message?.content ?? "");
    if (out || choice?.finish_reason !== "length") return out;
    if (attempt >= 2) throw new Error("模型输出太长被截断了（超过输出长度上限），请稍后重试");
  }
}

function parseJsonLoose(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

const HEAD = 3000; // 分类和归属只需要看开头

/* ================= 1. 资料分类 ================= */

const CLASSIFY_PROMPT = `你是求职资料整理助手。判断用户这份资料属于哪一类，只输出 JSON：{"category":"简历|业务知识|项目复盘|工作源文件"}
分类定义：
- 简历：个人简历，列有教育背景、多段实习/项目/比赛经历和时间。
- 业务知识：行业、业务或概念知识的学习笔记，例如广告投放知识、AI 基础概念、行业研究笔记。不以"我做了什么"为主。
- 项目复盘：对自己某段经历的复盘、反思、经验教训，或整理的面试可能被问到的问题和回答。
- 工作源文件：工作中的实际产出，例如 PRD、需求文档、方案、数据分析报告、周报、策划案。
资料中的【敏感词1】等是脱敏占位符，忽略即可。只输出 JSON。`;

/** section：文件被切分后，传入小节标题，只判断这一节 */
export async function classifyWithLLM(name: string, note: string, redacted: string, section?: string): Promise<Category> {
  const out = await chatJson(
    CLASSIFY_PROMPT,
    `【文件名】${name}\n${section ? `【这是文件中的一个小节，标题】${section}\n` : ""}${note ? `【用户说明】${note}\n` : ""}【${section ? "小节内容" : "资料开头"}】\n${redacted.slice(0, HEAD)}`,
  );
  const c = out?.category as Category;
  if (section && c === "简历") return classifyWithRules(section, redacted, false);
  return CATEGORIES.includes(c) ? c : classifyWithRules(section ?? name, redacted, !section);
}

export function classifyWithRules(name: string, text: string, allowResume = true): Category {
  const n = name.toLowerCase();
  if (allowResume && /简历|resume|\bcv\b/.test(n)) return "简历";
  if (/复盘|面试|面经|q&a|qa/.test(n)) return "项目复盘";
  if (/prd|需求|方案|报告|周报|月报|策划|分析|brief/.test(n)) return "工作源文件";
  if (/\.(py|ipynb|sql|js|ts|r|java|sh|csv|json|ya?ml|html|css|pptx)$/.test(n)) return "工作源文件";

  const head = text.slice(0, HEAD * 2);
  const ranges = head.match(new RegExp(RANGE_RE.source, "g"))?.length ?? 0;
  const score = {
    简历: ranges * 2 + count(head, /教育背景|教育经历|实习经历|工作经历|项目经历|专业技能|Education/g) * 2,
    项目复盘: count(head, /复盘|反思|教训|面试|Q[:：]|问[:：]|答[:：]|STAR|追问/g),
    工作源文件: count(head, /PRD|需求|版本|功能列表|用户故事|验收|数据来源|结论|环比|同比|周报|目标[:：]/g),
  };
  if (allowResume && score.简历 >= 6) return "简历";
  const best = (Object.entries(score) as [Category, number][])
    .filter(([k]) => k !== "简历")
    .sort((a, b) => b[1] - a[1])[0];
  return best[1] >= 2 ? best[0] : "业务知识";
}

function count(s: string, re: RegExp) {
  return s.match(re)?.length ?? 0;
}

/* ================= 2. 从简历识别经历（只取原句） ================= */

type RawCard = Partial<Pick<ExperienceCard, "type" | "company" | "role" | "start" | "end">> & { details?: string[] };

const RESUME_PROMPT = `你是求职资料整理助手。用户给你一份简历（敏感信息已替换为【敏感词1】这类占位符）。
请识别其中每一段实习 / 项目 / 比赛经历，输出 JSON：
{"cards":[{"type":"实习|项目|比赛","company":"公司或组织","role":"岗位或角色","start":"YYYY.MM","end":"YYYY.MM 或 至今","details":["简历中这段经历下的原句"]}]}
硬性规则：
1. details 必须逐字复制简历原文中的句子，不改写、不合并、不总结、不补充。可以去掉行首的项目符号。
2. 不要编造任何信息；原文没有的字段留空字符串。
3. 占位符原样保留。
4. 教育背景、技能、证书不算经历，不要输出。
5. 只输出 JSON。`;

export async function extractCardsWithLLM(redacted: string, map: Record<string, string>): Promise<RawCard[]> {
  const out = await chatJson(RESUME_PROMPT, redacted.slice(0, 24000));
  const cards = Array.isArray(out?.cards) ? (out!.cards as RawCard[]) : [];
  return restore(cards, map);
}

const DATE = String.raw`(\d{4})\s*[.\-/年]\s*(\d{1,2})\s*月?`;
const RANGE_RE = new RegExp(`${DATE}\\s*[-–—~～至到]+\\s*(?:${DATE}|(至今|现在|今|Present|present|Now))`);
const SECTION_RE = /^(实习|工作|项目|比赛|竞赛|校园|学生工作|社团|教育|获奖|荣誉|技能|个人|专业)(经历|经验|背景|证书|评价|总结|技能)?[:：]?$/;
const BULLET_RE = /^[\s•·●○▪■◆\-*–—]+/;

export function extractCardsWithRules(text: string): RawCard[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const cards: RawCard[] = [];
  let cur: RawCard | null = null;

  lines.forEach((line, i) => {
    const m = line.match(RANGE_RE);
    if (m) {
      let header = line.replace(m[0], "").replace(/[|｜丨,，]/g, " ").trim();
      if (header.length < 2 && i > 0) {
        header = lines[i - 1];
        if (cur?.details?.at(-1) === header.replace(BULLET_RE, "")) cur.details.pop();
      }
      if (/大学|学院|University|College|本科|硕士/.test(header)) {
        cur = null; // 教育经历不算
        return;
      }
      const parts = header.split(/\s+/).filter(Boolean);
      cur = {
        type: guessType(header),
        company: parts[0] ?? "",
        role: parts.slice(1).join(" "),
        start: `${m[1]}.${m[2].padStart(2, "0")}`,
        end: m[5] ? "至今" : `${m[3]}.${m[4].padStart(2, "0")}`,
        details: [],
      };
      cards.push(cur);
    } else if (SECTION_RE.test(line.replace(/^#+\s*/, ""))) {
      cur = null;
    } else if (cur) {
      const d = line.replace(BULLET_RE, "").trim();
      if (d.length >= 4) cur.details!.push(d);
    }
  });
  return cards;
}

function guessType(s: string): CardType {
  if (/比赛|大赛|竞赛|挑战赛|case/i.test(s)) return "比赛";
  if (/项目|课题|研究/.test(s)) return "项目";
  return "实习";
}

/* ================= 3. 资料归属到哪段经历 ================= */

export interface Experience {
  ref: { kind: "card" | "draft"; id: string };
  company: string;
  role: string;
  localOnly: boolean;
}

/** 本地关键词匹配：资料里出现了哪家公司名，就归到哪段经历（同公司多段经历时再比岗位） */
export function matchLocally(name: string, text: string, exps: Experience[]): Experience | null {
  const hay = (name + "\n" + text).toLowerCase();
  const scored = exps
    .filter((e) => e.company.trim().length >= 2)
    .map((e) => {
      const c = hay.split(e.company.toLowerCase()).length - 1;
      const r = e.role && hay.includes(e.role.toLowerCase()) ? 1 : 0;
      return { e, score: c > 0 ? c * 10 + r : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored[1] && scored[1].score === scored[0].score) return null; // 分不出来，交给模型或用户
  return scored[0].e;
}

const MATCH_PROMPT = `你是求职资料整理助手。下面是用户的经历列表（带编号）和一份资料的开头（敏感信息已替换为占位符）。
判断这份资料是关于哪一段经历的。只输出 JSON：{"index": 编号} ；如果资料是通用知识、不针对某段具体经历，或无法判断，输出 {"index": null}。`;

export async function matchWithLLM(
  name: string,
  redactedHead: string,
  redactedList: string,
  size: number,
): Promise<number | null> {
  const out = await chatJson(MATCH_PROMPT, `【经历列表】\n${redactedList}\n\n【文件名】${name}\n【资料开头】\n${redactedHead}`);
  const idx = out?.index;
  return typeof idx === "number" && idx >= 0 && idx < size ? idx : null;
}

/* ================= 标准化、核对、合并 ================= */

export function normalize(raw: RawCard, sourceId: string, sourceText: string): DraftCard {
  const details = (raw.details ?? []).map(str).filter(Boolean);
  const card: DraftCard = {
    draftId: newId(),
    type: CARD_TYPES.includes(raw.type as CardType) ? (raw.type as CardType) : "实习",
    company: str(raw.company),
    role: str(raw.role),
    start: str(raw.start),
    end: str(raw.end),
    summary: (details[0] ?? "").slice(0, 60),
    details,
    localOnly: false,
    sourceIds: [sourceId],
    warnings: [],
  };
  card.warnings = verbatimCheck(card.details, sourceText);
  return card;
}

function str(v: unknown) {
  return typeof v === "string" ? v.trim() : "";
}

/** 卡片描述必须是简历原句：找不到原句的列出来，提醒核对 */
export function verbatimCheck(details: string[], sourceText: string): string[] {
  const norm = (s: string) => s.replace(/[\s•·●○▪■◆\-*–—,，.。;；:：、]/g, "");
  const src = norm(sourceText);
  const missing = details.filter((d) => norm(d) && !src.includes(norm(d)));
  return missing.length ? [`以下描述在简历原文中找不到原句，可能被改写过：${missing.map((m) => `「${m.slice(0, 30)}」`).join("")}`] : [];
}

export function cardKey(c: { company: string; role: string }) {
  const n = (s: string) =>
    s
      .toLowerCase()
      .replace(/(股份有限公司|有限责任公司|有限公司|科技|集团|公司)/g, "")
      .replace(/[\s（）()·.\-]/g, "");
  return `${n(c.company)}|${n(c.role)}`;
}

/** 多份简历（如中英文版）里的同一段经历合并 */
export function mergeDrafts(drafts: DraftCard[]): DraftCard[] {
  const byKey = new Map<string, DraftCard>();
  for (const d of drafts) {
    const k = cardKey(d);
    const hit = k === "|" ? undefined : byKey.get(k);
    if (!hit) {
      byKey.set(k === "|" ? d.draftId : k, d);
      continue;
    }
    hit.details = uniq([...hit.details, ...d.details]);
    hit.sourceIds = uniq([...hit.sourceIds, ...d.sourceIds]);
    hit.warnings = uniq([...hit.warnings, ...d.warnings]);
    hit.summary ||= d.summary;
    hit.start ||= d.start;
    hit.end ||= d.end;
  }
  return [...byKey.values()];
}

export function uniq<T>(a: T[]) {
  return [...new Set(a)];
}
