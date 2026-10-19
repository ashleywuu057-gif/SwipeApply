import "server-only";
import { llmConfig } from "../extract";
import { fetchPage, normForQuote } from "../research/fetch-page";
import { searchConfig, webSearch } from "../research/search";
import { readLibrary, readSourceText } from "../store";
import type { JobPosting } from "../tracker-types";
import { runToolLoop, type Msg, type ToolDef } from "./llm";
import { aliasOf, buildPool, BULLET_FORMAT, bulletFormat, checkBullet, factFrom, makeBullet, MAX_BULLETS, MIN_BULLETS, poolForModel, red, selectEvidence } from "./resume";
import { restore } from "../redact";
import type { ChatMsg, CompanyBrief, Fact, MemoryData, Resume } from "./types";

/**
 * 投递工作台里的 agent：你用语音或文字说一句，它自己决定调用哪些工具——
 * 查素材库、改某一条、增删经历、查公司、改速览、反问你、记住你补充的事实。
 * 每个改简历的工具都过核对（依据原句、数字），不通过就驳回让它重来。
 */

const MAX_STEPS = 8;
const FORMAT_REJECT = "驳回：格式要写成「关键词：详细介绍」，关键词固定 4 个汉字，是动作或能力（例如 数据分析、策略设计），后面跟全角冒号。请按这个格式重写。";

const SYSTEM = `你是用户的求职搭档，正在和用户一起完成一次投递：左边是目标公司的速览，右边是针对这个岗位定制的简历。
用户会用口语（可能是语音转文字，有错字）提修改意见或问问题。你通过工具直接动手修改，而不是只给建议。

【改简历的规则】
- 每条 bullet 都要有依据（素材编号 L*/F*/S*）。可以调整措辞、语序、突出 JD 关键词；不能加入依据里没有的事实、数字、职责或成果
- 改写后的数字必须在依据里出现过，否则工具会驳回
- ${BULLET_FORMAT.replace(/\n   /g, "\n  ")}
  不是这个格式的，工具会驳回
- 每段经历 2~3 条 bullet：已经 3 条时要加就先删一条关系弱的；只剩 2 条时不能再删，要么改写，要么整段移出
- 简历要正好写满一页 A4：用户要"精简"时优先把句子写短、或换掉整段，不要删到只剩大片空白；用户要"扩写"时注意别超过一页（页面上会提醒）
- 用户要"扩写"：从同一段经历里再挑依据加 bullet，或者用 search_library 在复盘和工作文档里找更多细节；找不到就如实说，并用 ask_user 问用户
- 用户要"精简"：把句子写短，或删掉和 JD 关系弱的 bullet（每段至少留 2 条）
- 需要用户补充信息时（例如 JD 要游戏经历、素材里没有），调用 ask_user 提一个具体的问题，然后结束这一轮
- 用户回答了你之前的问题、说出了关于自己的新事实时，先用 save_fact 记下（quote 必须是用户原话），再据此修改简历
- 用户表达了通用的写作偏好（例如"别用'赋能'这种词""数字放前面"），调用 suggest_writing_pref，用户确认后以后都会遵守

【关于公司的问题】
- 先看左边的速览；不够时${"{SEARCH}"}
- 用户要求修改或展开速览时，用 update_brief

【回复】
- 做完之后用一两句话告诉用户你改了什么、为什么；不要复述整份简历
- 【人名1】这类占位符是脱敏后的名字，保持原样`;

export interface AgentResult {
  reply: string;
  resume: Resume;
  brief: CompanyBrief;
  actions: string[];
  question?: string;
  suggestion?: { kind: "writing"; text: string };
  facts: Fact[];
}

export async function runWorkspaceAgent(opts: {
  job: JobPosting;
  jd: string;
  brief: CompanyBrief;
  resume: Resume;
  history: ChatMsg[];
  message: string;
  mem: MemoryData;
}): Promise<AgentResult> {
  if (!llmConfig().enabled) throw new Error("对话修改需要先在 .env.local 配置 LLM_API_KEY；也可以直接点简历里的句子手动改");
  const { job, jd, mem } = opts;
  const resume: Resume = structuredClone(opts.resume);
  const brief: CompanyBrief = structuredClone(opts.brief);
  const pool = await buildPool(mem);
  const actions: string[] = [];
  const facts: Fact[] = [];
  let question: string | undefined;
  let suggestion: AgentResult["suggestion"];
  const canSearch = searchConfig().enabled;
  const readPages = new Map<string, { title: string; text: string }>();
  let searches = 0;

  // bullet 的短编号 B1、B2…（每轮重新编号）
  const bulletIds = new Map<string, string>();
  const expById = (e: string) => resume.experiences.find((x) => x.cardId === pool.alias.get(e.trim()));
  const findBullet = (b: string) => {
    const id = bulletIds.get(b.trim());
    for (const e of resume.experiences) {
      const i = e.bullets.findIndex((x) => x.id === id);
      if (i >= 0) return { e, i };
    }
    return null;
  };
  const lineById = (id: string) => pool.lines.find((l) => l.id === id.trim());
  const sourceIdOf = (text: string) => pool.lines.find((l) => l.text === text)?.id ?? "";
  const label = (cardId: string) => {
    const e = resume.experiences.find((x) => x.cardId === cardId);
    return e ? `${e.company}` : "";
  };

  function resumeView() {
    bulletIds.clear();
    let n = 0;
    const local = new Set(pool.cards.filter((c) => c.localOnly).map((c) => c.id));
    const exps = resume.experiences
      .filter((e) => !local.has(e.cardId))
      .map((e) => {
        const bl = e.bullets.map((b) => {
          const short = `B${++n}`;
          bulletIds.set(short, b.id);
          return `  ${short} ${red(pool, b.text)}  〔依据 ${sourceIdOf(b.source) || "（手动）"}${b.status === "待核对" ? `，待核对：${b.issue}` : ""}〕`;
        });
        return `${aliasOf(pool, e.cardId)} ${e.include ? "【已选】" : "【未选】"} ${red(pool, e.company)} · ${red(pool, e.role)}（${e.time}）\n${bl.join("\n")}`;
      });
    return `${exps.join("\n")}\n技能：${resume.skills.join("、") || "（无）"}`;
  }

  function briefView() {
    const refs = brief.refs.map((r) => `[${r.id}] ${r.title}（${r.site}）`).join("\n");
    return [
      `介绍：${brief.intro}`,
      `业务条线：${brief.businessLine}`,
      `产品：${brief.products.map((p) => `${p.name}：${p.desc}`).join("；")}`,
      `要点：${brief.facts.map((f) => f.text).join("；")}`,
      refs ? `来源：\n${refs}` : `（速览依据：${brief.basis}）`,
    ].join("\n");
  }

  const tools: ToolDef[] = [
    {
      name: "search_library",
      description: "在用户的素材库里查找（经历原句、补充事实、复盘笔记和工作文档）。返回带编号的原文句子，可以作为 bullet 的依据。",
      parameters: { type: "object", properties: { query: { type: "string", description: "关键词，空格分隔" } }, required: ["query"] },
    },
    {
      name: "rewrite_bullet",
      description: "改写一条 bullet。source 不填则沿用原来的依据。",
      parameters: { type: "object", properties: { bullet: { type: "string", description: "B 编号" }, text: { type: "string" }, source: { type: "string", description: "依据编号 L*/F*/S*" } }, required: ["bullet", "text"] },
    },
    {
      name: "add_bullet",
      description: "给某段经历加一条 bullet",
      parameters: { type: "object", properties: { exp: { type: "string", description: "E 编号" }, text: { type: "string" }, source: { type: "string" }, position: { type: "number", description: "插到第几条（从 1 开始），不填放最后" } }, required: ["exp", "text", "source"] },
    },
    { name: "remove_bullet", description: "删掉一条 bullet", parameters: { type: "object", properties: { bullet: { type: "string" } }, required: ["bullet"] } },
    {
      name: "set_experience",
      description: "选入或移出一段经历，或调整它的顺序",
      parameters: { type: "object", properties: { exp: { type: "string" }, include: { type: "boolean" }, position: { type: "number", description: "排到第几段（从 1 开始）" } }, required: ["exp"] },
    },
    { name: "set_skills", description: "设置技能列表（只写素材里有证据的）", parameters: { type: "object", properties: { skills: { type: "array", items: { type: "string" } } }, required: ["skills"] } },
    { name: "ask_user", description: "向用户提一个具体问题，然后结束这一轮", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
    {
      name: "save_fact",
      description: "把用户刚说的、关于自己的新事实存进素材库，之后可作为依据（返回 F 编号）",
      parameters: { type: "object", properties: { quote: { type: "string", description: "用户原话，必须逐字出自用户这一轮的消息" }, question: { type: "string", description: "对应你之前问的问题" } }, required: ["quote"] },
    },
    { name: "suggest_writing_pref", description: "建议记住一条通用写作偏好，等用户确认", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    {
      name: "update_brief",
      description: "修改左边的公司速览",
      parameters: {
        type: "object",
        properties: {
          field: { type: "string", enum: ["intro", "businessLine", "add_fact"] },
          text: { type: "string" },
          refs: { type: "array", items: { type: "number" }, description: "依据的来源编号" },
        },
        required: ["field", "text"],
      },
    },
  ];
  if (canSearch) {
    tools.push(
      { name: "web_search", description: "联网搜索公司的公开信息（最多 3 次）", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "read_page", description: "读网页正文，读过的网页会加入速览的来源", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    );
  }

  const lastUser = opts.message;

  async function exec(name: string, a: Record<string, unknown>): Promise<string | { stop: true; text: string }> {
    const s = (k: string) => restore(String(a[k] ?? ""), pool.map).trim();
    switch (name) {
      case "search_library": {
        const words = s("query").split(/[\s,，、]+/).filter((w) => w.length >= 1);
        if (!words.length) return "请给出关键词";
        const found = pool.lines.filter((l) => !pool.cards.find((c) => c.id === l.cardId)?.localOnly && words.some((w) => l.text.includes(w)));
        // 复盘笔记、工作文档（不含仅本地经历下的资料）
        const lib = await readLibrary();
        const local = new Set(pool.cards.filter((c) => c.localOnly).map((c) => c.id));
        let extra = 0;
        for (const src of lib.sources) {
          if (extra >= 8 || src.category === "简历" || (src.cardId && local.has(src.cardId))) continue;
          const text = await readSourceText(src.id);
          for (const line of text.split("\n")) {
            const t = line.trim();
            if (t.length < 8 || t.length > 200 || !words.some((w) => t.includes(w)) || pool.lines.some((l) => l.text === t)) continue;
            const id = `S${pool.lines.filter((l) => l.kind === "素材原文").length + 1}`;
            pool.lines.push({ id, text: t, cardId: src.cardId ?? undefined, kind: "素材原文" });
            found.push(pool.lines.at(-1)!);
            if (++extra >= 8) break;
          }
        }
        actions.push(`查了素材库：${words.join(" ")}（${found.length} 条）`);
        if (!found.length) return "素材库里没有找到相关内容。";
        return found
          .slice(0, 16)
          .map((l) => `${l.id} ${red(pool, l.text)}${l.cardId ? `（${red(pool, label(l.cardId) || "")}）` : ""}`)
          .join("\n");
      }
      case "rewrite_bullet": {
        const hit = findBullet(String(a.bullet ?? ""));
        if (!hit) return "没有这个 bullet 编号";
        const b = hit.e.bullets[hit.i];
        const src = a.source ? lineById(String(a.source)) : null;
        if (a.source && !src) return `依据编号 ${a.source} 不存在`;
        const source = src?.text ?? b.source;
        const f = bulletFormat(s("text"));
        if (!f.ok) return FORMAT_REJECT;
        const text = f.text;
        const c = checkBullet(text, source);
        if (c.status === "待核对") return `驳回：${c.issue}。请只用依据里有的信息改写。`;
        hit.e.bullets[hit.i] = { ...b, text, source, status: c.status, issue: undefined };
        actions.push(`改写了「${hit.e.company}」的一条：${text}`);
        return "已改写";
      }
      case "add_bullet": {
        const e = expById(String(a.exp ?? ""));
        if (!e) return "没有这个经历编号";
        const src = lineById(String(a.source ?? ""));
        if (!src) return `依据编号 ${a.source} 不存在，请先用 search_library 找依据`;
        const f = bulletFormat(s("text"));
        if (!f.ok) return FORMAT_REJECT;
        const text = f.text;
        const c = checkBullet(text, src.text);
        if (c.status === "待核对") return `驳回：${c.issue}`;
        if (e.bullets.length >= MAX_BULLETS) return `驳回：每段经历最多 ${MAX_BULLETS} 条。想加这条，先用 remove_bullet 删掉一条关系弱的，或者改写已有的一条`;
        if (e.bullets.some((x) => x.source === src.text)) return "这句依据已经用过了：扩写请换一条依据（可以用 search_library 找），或者改写已有的那条";
        const pos = Number(a.position) > 0 ? Math.min(Number(a.position) - 1, e.bullets.length) : e.bullets.length;
        e.bullets.splice(pos, 0, makeBullet(text, src.text));
        e.include = true;
        actions.push(`给「${e.company}」加了一条：${text}`);
        return "已添加";
      }
      case "remove_bullet": {
        const hit = findBullet(String(a.bullet ?? ""));
        if (!hit) return "没有这个 bullet 编号";
        if (hit.e.bullets.length <= MIN_BULLETS) return `驳回：每段经历至少 ${MIN_BULLETS} 条。可以改写这条，或者用 set_experience 把整段移出简历`;
        const [b] = hit.e.bullets.splice(hit.i, 1);
        actions.push(`删掉了「${hit.e.company}」的一条：${b.text}`);
        return "已删除";
      }
      case "set_experience": {
        const e = expById(String(a.exp ?? ""));
        if (!e) return "没有这个经历编号";
        if (typeof a.include === "boolean") {
          e.include = a.include;
          actions.push(`${a.include ? "选入" : "移出"}了经历「${e.company}」`);
        }
        if (Number(a.position) > 0) {
          resume.experiences = resume.experiences.filter((x) => x !== e);
          const included = resume.experiences.filter((x) => x.include);
          const before = included[Number(a.position) - 1];
          const idx = before ? resume.experiences.indexOf(before) : included.length ? resume.experiences.indexOf(included.at(-1)!) + 1 : 0;
          resume.experiences.splice(idx, 0, e);
          actions.push(`把「${e.company}」排到第 ${a.position} 段`);
        }
        return "已更新";
      }
      case "set_skills": {
        const list = (Array.isArray(a.skills) ? a.skills : []).map((x) => restore(String(x), pool.map).trim()).filter(Boolean);
        resume.skills = [...new Set(list)].slice(0, 10);
        actions.push(`技能改为：${resume.skills.join("、")}`);
        return "已更新";
      }
      case "ask_user": {
        question = s("question");
        return { stop: true, text: "已向用户提问，等待回答。" };
      }
      case "save_fact": {
        const quote = s("quote");
        // 核对：必须是用户这一轮的原话，不能是模型自己编的"事实"
        if (quote.length < 4 || !normForQuote(lastUser).includes(normForQuote(quote))) return "驳回：quote 必须逐字出自用户这一轮的消息";
        const f = factFrom(quote, s("question") || undefined, `${job.company} · ${job.title}`);
        facts.push(f);
        const id = `F${pool.lines.filter((l) => l.kind === "补充事实").length + 1}`;
        pool.lines.push({ id, text: f.text, kind: "补充事实" });
        actions.push(`记进素材库：${f.text}`);
        return `已保存为 ${id}，可以作为依据`;
      }
      case "suggest_writing_pref": {
        suggestion = { kind: "writing", text: s("text") };
        return "已提交给用户确认";
      }
      case "update_brief": {
        const text = s("text");
        const refs = (Array.isArray(a.refs) ? a.refs : []).map(Number).filter((n) => brief.refs.some((r) => r.id === n));
        if (canSearch && brief.basis === "联网" && !refs.length) return "驳回：联网速览的修改需要标注来源编号（先 web_search / read_page）";
        const field = String(a.field);
        if (field === "intro") brief.intro = text;
        else if (field === "businessLine") brief.businessLine = text;
        else if (field === "add_fact") brief.facts.push({ text, refs });
        else return "field 不对";
        brief.updatedAt = new Date().toISOString();
        actions.push(`更新了公司速览（${{ intro: "介绍", businessLine: "业务条线", add_fact: "要点" }[field]}）`);
        return "已更新";
      }
      case "web_search": {
        if (++searches > 3) return "搜索次数用完了，请基于已有信息回答";
        const q = s("query");
        const blocked = pool.settings.sensitiveTerms.find((t) => t.length >= 2 && q.includes(t));
        if (blocked) return "驳回：搜索词里有素材库的敏感词，只能搜公司和产品的公开信息";
        const hits = await webSearch(q, { count: 6 });
        actions.push(`联网搜索：${q}`);
        return hits.map((h, i) => `${i + 1}. ${h.title}（${h.site}）\n${h.url}`).join("\n") || "没有结果";
      }
      case "read_page": {
        const url = String(a.url ?? "");
        if (readPages.size >= 3) return "阅读次数用完了";
        const p = await fetchPage(url);
        readPages.set(url, p);
        let ref = brief.refs.find((r) => r.url === url);
        if (!ref) {
          ref = { id: brief.refs.length + 1, title: p.title || url, url, site: new URL(url).host.replace(/^www\./, "") };
          brief.refs.push(ref);
        }
        actions.push(`读了网页：${ref.title}`);
        return `来源编号 [${ref.id}]\n${p.text.slice(0, 4000)}`;
      }
    }
    return "未知工具";
  }

  const history = opts.history.slice(-10).map((m) => ({ role: m.role, content: red(pool, m.question ? `${m.text}\n（我问你：${m.question}）` : m.text) }));
  // 证据多时只列和 JD、你这句话最相关的，加上当前简历已经引用的；其余的模型可以用 search_library 查
  const cited = new Set(resume.experiences.flatMap((e) => e.bullets.map((b) => b.source)));
  const keep = await selectEvidence(
    pool,
    `${opts.message}\n${job.title}\n${jd}`,
    40,
    pool.lines.filter((l) => l.kind === "资料证据" && cited.has(l.text)).map((l) => l.id),
  );
  const writing = mem.writing.filter((w) => w.active).map((w) => `- ${w.text}`);
  const context = [
    `岗位：${job.company} · ${job.title}`,
    `JD：\n${jd || "（没有 JD）"}`,
    `公司速览：\n${briefView()}`,
    `当前简历（E=经历，B=bullet）：\n${resumeView()}`,
    `素材（依据编号）：\n${poolForModel(pool, keep)}${keep ? "\n（资料证据只列了和这个岗位最相关的一部分，找不到时用 search_library 查）" : ""}`,
    writing.length ? `用户的写作偏好：\n${writing.join("\n")}` : "",
    resume.gaps.length ? `之前发现的缺口：${resume.gaps.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: Msg[] = [
    { role: "system", content: SYSTEM.replace("{SEARCH}", canSearch ? "用 web_search 和 read_page 查，回答时标注来源编号" : "如实说明速览里没有，不要编造（目前没有配置联网搜索）") },
    { role: "user", content: `【工作台当前状态】\n${context}` },
    { role: "assistant", content: "好的，我看过了。" },
    ...history,
    { role: "user", content: red(pool, lastUser) },
  ];

  // 模型每轮都能看到最新的简历编号：改完一次后把新状态附在工具结果里太长，这里在 rewrite 之后不重编号，编号在一轮对话内保持稳定
  resumeView();
  const r = await runToolLoop({ messages, tools, exec, maxSteps: MAX_STEPS });
  resume.updatedAt = new Date().toISOString();
  return {
    reply: restore(r.reply || (question ? "" : actions.length ? "改好了。" : "嗯，我没有改动。"), pool.map),
    resume,
    brief,
    actions,
    question,
    suggestion,
    facts,
  };
}

/** 你手动改了一句：看看能不能总结出一条写作偏好（等你确认才会记住） */
export async function learnFromEdit(mem: MemoryData, before: string, after: string): Promise<string | null> {
  const known = mem.writing.map((w) => w.text);
  // 本地规则：删掉了常见的"黑话"
  const jargon = ["赋能", "抓手", "闭环", "打通", "沉淀", "助力", "深度参与", "全链路", "颗粒度", "对齐"];
  const removed = jargon.find((w) => before.includes(w) && !after.includes(w));
  if (removed) {
    const t = `不用"${removed}"这类互联网黑话`;
    return known.some((k) => k.includes(removed)) ? null : t;
  }
  if (!llmConfig().enabled || mem.edits.length < 2) return null;
  const { chatJson } = await import("./llm");
  const pool = await buildPool(mem); // 发给模型前先脱敏
  const r = await chatJson<{ pref?: string }>(
    `用户在修改自己的简历句子。根据最近几次修改，判断是否有一条稳定的、可以推广到以后的写作偏好（例如"数字放在句首""动词开头""不用第一人称"）。
只输出 JSON：{"pref":"一句话偏好"} ；没有明确规律就输出 {"pref":""}。不要重复已有偏好：${known.join("；") || "无"}`,
    mem.edits
      .slice(-5)
      .map((e, i) => `${i + 1}. 改前：${red(pool, e.before)}\n   改后：${red(pool, e.after)}`)
      .join("\n"),
  ).catch(() => null);
  const pref = r?.pref ? restore(r.pref, pool.map).trim() : "";
  return pref && !known.includes(pref) ? pref : null;
}
