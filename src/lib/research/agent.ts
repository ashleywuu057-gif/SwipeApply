import "server-only";
import { llmConfig, llmPost } from "../extract";
import { fetchPage, normForQuote } from "./fetch-page";
import { CHANNELS, classifySource, webSearch, type SearchHit } from "./search";
import type { Finding, Research } from "./types";

/**
 * 调研 agent（阶段 A）：只接触公开信息，拿不到你的素材库。
 * 循环：模型决定下一步（搜索 / 读网页 / 记录发现 / 结束）→ 程序执行工具 → 结果交还模型。
 * 约束：步数、搜索、阅读次数上限；每条发现的摘录必须出现在已读网页原文里，否则驳回。
 */
export const LIMITS = { steps: 24, searches: 12, reads: 10 };

export const SECTIONS = ["业务条线", "主要产品", "商业模式", "业务位置", "目标用户和市场", "近一年动态", "竞争格局", "增长和运营", "团队与招聘"] as const;

const SYSTEM = `你是求职调研助手，帮一名应届生在面试前调研目标公司的业务。你只能通过工具获取信息。

【调研对象】
1. 目标公司：弄清这个岗位所在的业务条线（电商 / 直播 / 广告 / AI / 游戏 / 本地生活 / 出海等）、该条线在公司的位置、主要产品，以及这条业务的商业模式、目标用户和市场、近一年动态、竞争格局、增长和运营打法、团队与招聘动向。
2. 参照产品（如果给了参照公司）：找出参照公司里和目标业务最相近的产品或业务，按同样的维度收集信息，用于竞品对比。

【渠道】按"官方公开资料 → 第三方渠道"的顺序找，并且有意识地覆盖不同渠道：
- 官方公开资料：官网、财报与交易所披露、官方公众号、CEO/高管访谈、产品发布会、招聘广告（同团队的其他 JD 最能反映业务重点）
- 第三方渠道：研究机构报告、头部行业媒体（晚点、36氪、虎嗅、财新等）、公众号深度文章、用户论坛
web_search 可以用 channel 参数指定渠道；近一年动态请用 freshness=oneYear。

【规则】
- 只记录读过的网页里写明的信息，不要凭印象补充，不要编造数字。
- record_finding 的 quote 必须从 read_page 返回的正文里原样复制（20~150 字），否则会被驳回。
- 优先采用官方和交易所披露、研究机构、头部媒体的信息；论坛和自媒体只作补充。
- 每个维度至少一条发现；目标公司优先，参照产品次之。
- 预算有限：搜索和阅读都有次数上限。信息够用了就调用 finish，不要为了凑数继续搜。
- 回复要简短，把篇幅留给工具调用。`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索，返回标题、网址、站点、日期和摘要。摘要不能直接当作依据，需要 read_page 读原文。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词，只写公司、产品、业务等公开信息" },
          channel: { type: "string", enum: CHANNELS, description: "想重点找的渠道" },
          freshness: { type: "string", enum: ["noLimit", "oneYear", "oneMonth"] },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description: "读取网页正文（最多返回 6000 字）。",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "record_finding",
      description: "记录一条发现。quote 必须是该网页正文里的原句。",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", enum: ["目标公司", "参照产品"] },
          section: { type: "string", enum: SECTIONS },
          claim: { type: "string", description: "一句话结论" },
          quote: { type: "string", description: "网页原文摘录" },
          url: { type: "string" },
        },
        required: ["subject", "section", "claim", "quote", "url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "调研结束。",
      parameters: { type: "object", properties: { note: { type: "string" } } },
    },
  },
];

type Msg = { role: string; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; [k: string]: unknown };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export async function runResearchAgent(
  r: Research,
  ctx: { blockedTerms: string[]; save: () => Promise<void> },
): Promise<void> {
  const cfg = llmConfig();
  if (!cfg.enabled) throw new Error("还没有配置 LLM_API_KEY");
  const L = r.budget ?? LIMITS;

  const pages = new Map<string, { text: string; norm: string; sourceId: number }>();
  const hits = new Map<string, SearchHit>();
  const log = (kind: Research["trace"][number]["kind"], text: string) => r.trace.push({ at: new Date().toISOString(), kind, text });

  const task = [
    `目标公司：${r.company}`,
    r.jobTitle ? `岗位：${r.jobTitle}` : "",
    r.jd ? `JD：\n${r.jd.slice(0, 3000)}` : "",
    r.refCompany ? `参照公司：${r.refCompany}（找出其中和目标业务最相近的产品或业务做对比）` : "参照公司：无（只调研目标公司）",
    `预算：最多 ${L.searches} 次搜索、${L.reads} 次阅读、${L.steps} 步。`,
  ]
    .filter(Boolean)
    .join("\n");
  const messages: Msg[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task },
  ];

  let nudged = 0;
  for (let step = 1; step <= L.steps; step++) {
    r.usage.steps = step;
    const json = await llmPost({ model: cfg.model, temperature: 0.2, messages, tools: TOOLS, tool_choice: "auto" });
    r.usage.promptTokens += json.usage?.prompt_tokens ?? 0;
    r.usage.completionTokens += json.usage?.completion_tokens ?? 0;
    const msg: Msg = json.choices?.[0]?.message ?? { role: "assistant", content: "" };
    messages.push(msg); // 原样放回（包括模型的思考内容），多轮工具调用需要

    if (typeof msg.content === "string" && msg.content.trim()) log("思考", msg.content.trim().slice(0, 300));
    const calls = msg.tool_calls ?? [];
    if (!calls.length) {
      if (++nudged > 1) break;
      messages.push({ role: "user", content: "请继续调用工具；信息足够了就调用 finish。" });
      continue;
    }

    let finished = false;
    for (const call of calls) {
      let args: Record<string, string> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {}
      let out = "";
      try {
        out = await execTool(call.function.name, args);
      } catch (e) {
        out = `出错：${(e as Error).message}`;
        log("错误", `${call.function.name}：${(e as Error).message}`);
      }
      if (call.function.name === "finish") finished = true;
      messages.push({ role: "tool", tool_call_id: call.id, content: `${out}\n\n${progress(step)}` });
    }
    compact(messages);
    await ctx.save();
    if (finished) break;
  }

  // ---------- 工具实现 ----------

  async function execTool(name: string, a: Record<string, string>): Promise<string> {
    switch (name) {
      case "web_search": {
        if (r.usage.searches >= L.searches) return "搜索次数已用完，请基于已读内容记录发现，然后 finish。";
        const q = (a.query ?? "").trim();
        const leak = ctx.blockedTerms.find((t) => t.length >= 2 && q.includes(t));
        if (leak) {
          log("驳回", `搜索词里含有素材库里的敏感词，已拦截：${q}`);
          return "这个搜索词包含不应外传的词，已拦截。请只用公司、产品、业务等公开名称搜索。";
        }
        r.usage.searches++;
        log("搜索", `${q}${a.channel && a.channel !== "不限" ? `（渠道：${a.channel}）` : ""}${a.freshness && a.freshness !== "noLimit" ? `（${a.freshness}）` : ""}`);
        const list = await webSearch(q, { channel: a.channel === "不限" ? undefined : a.channel, freshness: a.freshness });
        list.forEach((h) => hits.set(h.url, h));
        if (!list.length) return "没有搜到结果，换个说法试试。";
        return list.map((h, i) => `${i + 1}. ${h.title} | ${h.site}${h.date ? ` | ${h.date}` : ""}\n${h.url}\n${h.snippet}`).join("\n\n");
      }
      case "read_page": {
        const url = (a.url ?? "").trim();
        const cached = pages.get(url);
        if (cached) return `（已读过）\n${cached.text.slice(0, 6000)}`;
        if (r.usage.reads >= L.reads) return "阅读次数已用完，请基于已读内容记录发现，然后 finish。";
        r.usage.reads++;
        const page = await fetchPage(url);
        const hit = hits.get(url);
        const cls = classifySource(url, hit && hit.site.includes(r.company) ? [new URL(url).host] : []);
        const source = {
          id: r.sources.length + 1,
          url,
          title: page.title || hit?.title || url,
          site: hit?.site || new URL(url).host,
          date: page.date || hit?.date,
          ...cls,
        };
        r.sources.push(source);
        pages.set(url, { text: page.text, norm: normForQuote(page.text), sourceId: source.id });
        log("阅读", `[${source.id}] ${source.title}（${source.site} · ${source.channel} · 可信度 ${source.tier}）`);
        return `来源编号 [${source.id}]，${source.channel}，可信度 ${source.tier}\n${page.text.slice(0, 6000)}${page.text.length > 6000 ? "\n（正文较长，只显示前 6000 字）" : ""}`;
      }
      case "record_finding": {
        const page = pages.get((a.url ?? "").trim());
        if (!page) {
          r.usage.rejected++;
          log("驳回", `「${a.claim}」：这个网页还没读过`);
          return "驳回：这个网址还没有用 read_page 读过。只能引用读过的网页。";
        }
        const q = normForQuote(a.quote ?? "");
        if (q.length < 8 || !page.norm.includes(q)) {
          r.usage.rejected++;
          log("驳回", `「${a.claim}」：摘录在原文里找不到`);
          return "驳回：quote 在网页原文里找不到。请从正文里原样复制一段（20~150 字）。";
        }
        const f: Finding = {
          id: r.findings.length + 1,
          subject: a.subject === "参照产品" ? "参照产品" : "目标公司",
          section: SECTIONS.includes(a.section as (typeof SECTIONS)[number]) ? a.section : "业务条线",
          claim: (a.claim ?? "").slice(0, 200),
          quote: (a.quote ?? "").slice(0, 300),
          sourceId: page.sourceId,
        };
        r.findings.push(f);
        r.usage.accepted++;
        log("记录", `${f.subject} · ${f.section}：${f.claim} [${f.sourceId}]`);
        return `已记录（发现 #${f.id}）。`;
      }
      case "finish":
        log("结束", a.note ? a.note.slice(0, 200) : "调研结束");
        return "好的。";
      default:
        return "没有这个工具。";
    }
  }

  /** 每次工具结果后附上进度，帮助模型判断还缺什么、什么时候停 */
  function progress(step: number) {
    const have = (subject: string) =>
      SECTIONS.filter((s) => r.findings.some((f) => f.subject === subject && f.section === s));
    const missing = SECTIONS.filter((s) => !have("目标公司").includes(s));
    return [
      `【进度】第 ${step}/${L.steps} 步；搜索 ${r.usage.searches}/${L.searches}；阅读 ${r.usage.reads}/${L.reads}`,
      `目标公司已覆盖：${have("目标公司").join("、") || "无"}；还缺：${missing.join("、") || "无"}`,
      r.refCompany ? `参照产品已覆盖：${have("参照产品").join("、") || "无"}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/** 控制上下文长度：较早的网页正文替换成占位说明（需要时可以再 read_page，会走缓存） */
function compact(messages: Msg[]) {
  const toolIdx = messages.map((m, i) => (m.role === "tool" && typeof m.content === "string" && m.content.length > 1500 ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIdx.slice(0, -2)) {
    const c = messages[i].content as string;
    messages[i].content = c.slice(0, 300) + "\n……（较早的正文已省略；需要引用请重新 read_page，不消耗次数）\n" + c.slice(c.lastIndexOf("【进度】"));
  }
}
