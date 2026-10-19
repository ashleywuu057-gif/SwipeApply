import "server-only";
import { llmConfig } from "./extract";
import { restore } from "./redact";
import { buildPlanA, buildPlanB } from "./prep-plan";
import { addBizQuestions, ensureResearch } from "./prep-research";
import { readResearch } from "./research/store";
import { rank } from "./retrieve";
import { newId } from "./store";
import { normCompany } from "./tracker-logic";
import { readTracker } from "./tracker-store";
import type { Application, JobPosting, MailItem } from "./tracker-types";
import { ensureJd, startBrief } from "./native/intel";
import { findJob } from "./native/jobs";
import { chatJson, numbersOk } from "./native/llm";
import { buildPool, cardWeights, red, type Pool } from "./native/resume";
import { readBrief, readJd, readMemory, readPrep, savePrep, shared } from "./native/store";
import type { CompanyBrief, PrepData, PrepFeedback, PrepMatch, PrepPlan, PrepQuestion, PrepSession } from "./native/types";

/**
 * 面试准备：你确认一封面试邮件后，在后台把岗位、JD、公司速览、你最匹配的经历和一套题准备好，首页简报里提示你来练。
 * 模拟面试：AI 一次问一道，你答完它点评 + 指出你素材里能用上的条目 + 追问一次。
 * 防编造：题目和点评引用的素材编号都要核对存在；"参考说法"里的数字必须出现在它引用的素材里，否则标"待核对"。
 * 发给模型前脱敏；标了「仅本地」的经历不参与。
 */

export const INTERVIEW_KINDS = ["面试", "AI面", "HR面"] as const;
type Round = PrepData["round"];

const MATCHES = 8; // 准备材料里放几条最匹配的素材

/* ---------------- 找岗位 ---------------- */

/** 岗位名的"词"：中文按两字一组，英文按单词；去掉届别、校招这类每个岗位都有的词 */
function grams(s: string) {
  const t = s.toLowerCase().replace(/【[^】]*】|\d{2,4}届|校招|校园招聘|秋招|春招|实习|邀请|通知|面试|一面|二面|终面|笔试|测评/g, " ");
  const out = new Set<string>();
  for (const w of t.match(/[a-z]{2,}/g) ?? []) out.add(w);
  for (const seg of t.match(/[一-鿿]+/g) ?? []) for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2));
  return out;
}

/** 从邮件标题里取岗位名："【小鹏集团】AI产品经理 一面邀请" → "AI产品经理"（去掉公司名、面试轮次、邀请通知这类词） */
export function titleFromSubject(subject: string, company: string) {
  let t = subject.replace(/【[^】]*】|\[[^\]]*\]/g, " ");
  for (const w of [company, company.replace(/(集团|有限公司|股份|科技|公司)$/g, "")].filter((x) => x.length >= 2)) t = t.split(w).join(" ");
  t = t.replace(/(20\d{2}|\d{2})届|校园招聘|校招|秋招|春招|第?[一二三四五终]+[面轮]|面试|笔试|测评|邀请函?|通知|安排|提醒|确认|回复|您好|你好|[：:，,|｜\-—]/g, " ");
  return t.replace(/\s+/g, " ").trim().slice(0, 40);
}

/**
 * 投递记录对应的岗位：关联过就用；没关联的在岗位库里按公司找，用岗位名和邮件标题挑最像的那个。
 * 对不上、或者几个岗位一样像的时候不瞎猜：临时建一个（岗位名用投递记录的，没有就用邮件标题），只用来找 JD 和公司速览。
 */
async function jobFor(app: Application, hint = ""): Promise<JobPosting> {
  for (const id of [app.jobId, ...(app.jobIds ?? [])].filter(Boolean) as string[]) {
    const j = await findJob(id);
    if (j) return j;
  }
  const d = await readTracker();
  const c = normCompany(app.company);
  const titles = app.title.split(" / ").map((t) => t.trim()).filter(Boolean);
  const same = d.jobs.filter((j) => normCompany(j.company) === c && !j.siteOnly);
  const want = grams(`${titles.join(" ")} ${hint}`);
  const scored = same
    .map((j) => ({ j, s: [...grams(j.title)].filter((g) => want.has(g)).length }))
    .sort((a, b) => b.s - a.s);
  const exact = same.find((j) => titles.some((t) => j.title.includes(t) || t.includes(j.title)));
  const best = scored[0];
  const hit = exact ?? (best && best.s >= 2 && best.s > (scored[1]?.s ?? 0) ? best.j : undefined);
  if (hit) return hit;
  return {
    id: `prep-${app.id}`,
    company: app.company,
    title: titles[0] ?? titleFromSubject(hint, app.company),
    location: "",
    deadline: "",
    link: app.link,
    batch: [...`${app.title} ${hint}`.matchAll(/20\d{2}\s*届|校园招聘|校招|秋招|春招|实习/g)].map((m) => m[0]).join(" "), // 找 JD 时用来排除往年、实习/校招对不上的网页
    industry: "",
    note: "",
    directions: app.snapshot?.directions ?? [],
    overseas: app.snapshot?.overseas ?? false,
    source: "面试准备",
    starred: false,
    createdAt: new Date().toISOString(),
  };
}

async function waitBrief(job: JobPosting, jd: string): Promise<CompanyBrief | null> {
  startBrief(job, jd);
  for (let i = 0; i < 40; i++) {
    const b = await readBrief(job.company);
    if (b && b.status !== "generating") return b;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return readBrief(job.company);
}

/* ---------------- 准备材料 ---------------- */

const labelOf = (pool: Pool, cardId?: string) => {
  const c = pool.cards.find((x) => x.id === cardId);
  return c ? `${c.company} · ${c.role}` : "";
};

/** 按 JD 挑你最匹配的简历原句和资料证据：每个 JD 要点先各挑一条，同一段经历最多 3 条（向量不可用时按关键词） */
async function pickMatches(pool: Pool, query: string): Promise<PrepMatch[]> {
  const local = new Set(pool.cards.filter((c) => c.localOnly).map((c) => c.id));
  const cands = pool.lines.filter((l) => (l.kind === "卡片原句" || l.kind === "资料证据") && !(l.cardId && local.has(l.cardId)));
  const r = await rank(red(pool, query), cands.map((l) => ({ id: l.id, text: red(pool, l.embed ?? l.text), group: l.cardId })), { k: MATCHES, perGroup: 3, groupWeight: cardWeights(pool, query.split("\n")[0]) });
  return r.ranked
    .map((x) => cands.find((l) => l.id === x.id)!)
    .map((l) => ({ ref: l.id, label: labelOf(pool, l.cardId), text: l.text, note: l.note }));
}

const Q_PROMPT = (round: Round) => `你是一位资深面试官，帮一名应届生准备一场${round}。根据岗位 JD、公司速览和 TA 的素材，出 6~8 道最可能被问到的题。
只输出 JSON：{"questions":[{"q":"题目，像面试官当面问的一句话","focus":"考察点，10 字以内","refs":["M1","M3"]}]}
要求：
- 第一题是自我介绍（结合这个岗位）
- 2~3 道深挖 TA 最匹配的经历：点名具体项目，问做了什么、为什么这样做、结果如何衡量
- 1~2 道业务题：结合公司业务和 JD 的核心职责
- 1 道行为题（协作、冲突、失败等）
- 1 道"为什么选我们 / 这个岗位"
${round === "HR面" ? "- 这是 HR 面：多问动机、稳定性、职业规划、期望，少问业务细节\n" : round === "AI面" ? "- 这是 AI 面：通常是结构化的行为题和情景题，题目要能在 2~3 分钟内答完\n" : ""}- refs 填回答这道题可以用上的素材编号（只能用下面给出的 M 编号，没有就空数组）
- 【人名1】这类占位符保持原样`;

/** 准备一场面试（同一条投递同时只跑一次） */
export function startPrep(app: Application, opts: { mail?: MailItem; round?: Round } = {}) {
  return shared(`prep:${app.id}`, () => runPrep(app, opts));
}

async function runPrep(app: Application, opts: { mail?: MailItem; round?: Round }): Promise<PrepData> {
  const old = await readPrep(app.id);
  const now = new Date().toISOString();
  const round = (opts.round ?? (opts.mail?.kind as Round) ?? old?.round ?? "面试") as Round;
  const job = await jobFor(app, opts.mail?.subject ?? "");
  const p: PrepData = {
    appId: app.id,
    company: app.company,
    title: app.title || job.title,
    jobTitle: job.id.startsWith("prep-") ? undefined : job.title,
    round,
    scheduledAt: opts.mail?.scheduledAt ?? old?.scheduledAt,
    link: opts.mail?.link ?? old?.link,
    mailId: opts.mail?.id ?? old?.mailId,
    jobId: job.id,
    status: "preparing",
    step: "找 JD",
    jd: { text: "" },
    researchId: old?.researchId,
    matches: [],
    questions: [],
    sessions: old?.sessions ?? [], // 重新准备时保留练过的记录
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
  };
  await savePrep(p);
  try {
    if (!llmConfig().enabled) throw new Error("还没有配置 LLM_API_KEY");
    // 临时岗位每次都重新找（岗位名可能变了，找 JD 失败的缓存 6 小时内不会自己重试）；你手动贴的 JD 不覆盖
    const cachedJd = await readJd(job.id);
    const jd = await ensureJd(job, { force: job.id.startsWith("prep-") && cachedJd?.by !== "手动" }).catch(() => null);
    p.jd = { text: jd?.status === "ok" ? jd.text : "", url: jd?.url, by: jd?.by, warn: jd?.status === "ok" ? jd.warn : undefined };
    // 深度调研在后台排队跑（几分钟），不等它；速览先顶上
    const rs = await ensureResearch(p).catch((e): { id?: string; note?: string } => ({ note: `深度调研没能启动：${(e as Error).message}` }));
    p.researchId = rs.id;
    p.researchNote = rs.note;
    p.step = "生成公司速览";
    await savePrep(p);
    const brief = await waitBrief(job, p.jd.text);

    p.step = "挑你最匹配的经历";
    await savePrep(p);
    const pool = await buildPool(await readMemory());
    const query = `${p.title}\n${brief?.businessLine ?? ""}\n${p.jd.text}`;
    p.matches = await pickMatches(pool, query);

    p.step = "出题";
    await savePrep(p);
    const mats = p.matches.map((m, i) => `M${i + 1} [${red(pool, m.label)}] ${red(pool, m.text)}${m.note ? `（${red(pool, m.note)}）` : ""}`).join("\n");
    const r = await chatJson<{ questions?: { q?: string; focus?: string; refs?: string[] }[] }>(
      Q_PROMPT(round),
      [
        `岗位：${p.company} · ${p.title}`,
        p.jd.text ? `JD：\n${red(pool, p.jd.text.slice(0, 2500))}` : "（没有找到 JD，按岗位名和公司业务出题）",
        brief?.status === "ready" ? `公司速览：${brief.intro}\n业务条线：${brief.businessLine}\n产品：${brief.products.map((x) => x.name).join("、")}` : "",
        `TA 的素材：\n${mats}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      0.4,
    );
    const refOf = (m: string) => {
      const i = Number(String(m).replace(/^M/, "")) - 1;
      return p.matches[i]?.ref;
    };
    p.questions = (r?.questions ?? [])
      .map((x): PrepQuestion => ({ id: newId(), q: restore(String(x.q ?? ""), pool.map).trim(), focus: restore(String(x.focus ?? ""), pool.map).trim(), refs: (x.refs ?? []).map(refOf).filter((v): v is string => Boolean(v)) }))
      .filter((x) => x.q)
      .slice(0, 8);
    if (!p.questions.length) throw new Error("模型没有出题，请稍后重新准备");
    // 复用的调研已经做完的话，业务题预判现在就并进来；还在跑的，跑完会自己并进来
    const research = p.researchId ? await readResearch(p.researchId) : null;
    if (research?.status === "完成") addBizQuestions(p, research);

    // 准备稿：失败了不影响其余材料，页面上显示原因
    p.step = "写准备稿";
    await savePrep(p);
    p.plan = await buildPlanA(p, pool, brief).catch(
      (e): PrepPlan => ({ materials: [], points: [], deepDive: [], risks: [], pitch: { whyRole: "", intro: "", focus: [], ask: [] }, error: (e as Error).message, at: new Date().toISOString() }),
    );
    if (research?.status === "完成" && !p.plan.error) p.plan.business = await buildPlanB(p, p.plan, research, pool).catch(() => undefined);
    p.status = "ready";
    p.step = undefined;
    await savePrep(p);
    return p;
  } catch (e) {
    p.status = "failed";
    p.error = (e as Error).message;
    p.step = undefined;
    await savePrep(p);
    return p;
  }
}

/** "周四 19:00 " / "10月9日 14:00 " / ""（7 天内写星期几） */
export function whenText(at?: string) {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const days = (d.getTime() - Date.now()) / 86400000;
  const day = days >= -1 && days < 7 ? `周${"日一二三四五六"[d.getDay()]}` : `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${day} ${hm} `;
}

/* ---------------- 模拟面试 ---------------- */

const FB_PROMPT = `你是面试官，正在对一名应届生做模拟面试。TA 刚回答了一道题，请点评。
只输出 JSON：
{"good":"答得好的地方，一两句","missing":"缺了什么，一两句","use":["M2"],"followUp":"一句追问，不需要就留空","sample":"参考说法，两三句，没有合适素材就留空"}
字段说明：
- good：答得好的地方；实在没有就写"没有明显亮点"
- missing：按「问题/背景 → 行动 → 结果」看哪一环弱或没说，或者没答到考察点
- followUp：抓住回答里最值得深挖或最含糊的地方追问一句
- sample：用 TA 自己的素材把这题答得更好的说法
规则：
- use 只能填下面给出的 M 编号：TA 回答里没提到、但对这题有用的素材；没有就空数组
- sample 只能用 TA 的回答和引用的素材里有的事实和数字，不能编造经历、数字或职责；不能把"参与"说成"负责""主导"
- 点评要具体，不说空话；语气像认真的面试官，不客套
- 【人名1】这类占位符保持原样`;

/** 模拟面试的一步：没有 sessionId 就开始新的一场；带 answer 就点评这一题、给出下一题（或追问、或总结） */
export async function practiceStep(appId: string, input: { sessionId?: string; answer?: string }): Promise<{ prep: PrepData; session: PrepSession } | { error: string }> {
  const p = await readPrep(appId);
  if (!p || p.status !== "ready") return { error: "还没有准备好" };
  let s = p.sessions.find((x) => x.id === input.sessionId);
  if (!s) {
    s = { id: newId(), startedAt: new Date().toISOString(), turns: [{ qid: p.questions[0].id, question: p.questions[0].q, followUp: false }], done: false };
    p.sessions.push(s);
    await savePrep(p);
    return { prep: p, session: s };
  }
  const turn = s.turns.at(-1)!;
  const answer = input.answer?.trim();
  if (s.done || turn.answer || !answer) return { prep: p, session: s };

  const pool = await buildPool(await readMemory()); // 只用来脱敏
  const q = p.questions.find((x) => x.id === turn.qid);
  const mats = p.matches.map((m, i) => `M${i + 1} [${red(pool, m.label)}] ${red(pool, m.text)}`).join("\n");
  const ask = () =>
    chatJson<{ good?: string; missing?: string; use?: string[]; followUp?: string; sample?: string }>(
      FB_PROMPT,
      [
        `岗位：${p.company} · ${p.title}（${p.round}）`,
        `题目：${red(pool, turn.question)}${q ? `（考察点：${q.focus}）` : ""}`,
        `TA 的回答：\n${red(pool, answer).slice(0, 3000)}`,
        `TA 的素材：\n${mats}`,
        turn.followUp ? "（这已经是追问，followUp 留空）" : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      0.3,
    );
  // 模型偶尔返回不了合法 JSON：再试一次；还不行就报错，你的回答不丢，可以重新提交
  let r = await ask();
  if (!r?.good && !r?.missing) r = await ask();
  if (!r?.good && !r?.missing) throw new Error("面试官这次没给出点评，请重新提交一次（你的回答还在输入框里）");
  const back = (t?: string) => restore(String(t ?? ""), pool.map).trim();
  const use = (r?.use ?? []).map((m) => p.matches[Number(String(m).replace(/^M/, "")) - 1]?.ref).filter((v): v is string => Boolean(v));
  const fb: PrepFeedback = { good: back(r?.good), missing: back(r?.missing), use: [...new Set(use)] };
  const sample = back(r?.sample);
  if (sample) {
    // 数字只能来自你的回答和它建议用上的素材
    const basis = [answer, ...fb.use.map((ref) => p.matches.find((m) => m.ref === ref)?.text ?? "")].join("\n");
    const n = numbersOk(sample, basis);
    fb.sample = n.ok ? { text: sample, status: "可用" } : { text: sample, status: "待核对", issue: `出现了你的回答和素材里没有的数字：${n.extra.join("、")}` };
  }
  turn.answer = answer;
  turn.feedback = fb;

  const follow = back(r?.followUp);
  const asked = new Set(s.turns.filter((t) => !t.followUp).map((t) => t.qid));
  const next = p.questions.find((x) => !asked.has(x.id));
  if (follow && !turn.followUp) s.turns.push({ qid: turn.qid, question: follow, followUp: true });
  else if (next) s.turns.push({ qid: next.id, question: next.q, followUp: false });
  else {
    s.done = true;
    s.summary = await summarize(p, s, pool).catch(() => "");
  }
  await savePrep(p);
  return { prep: p, session: s };
}

async function summarize(p: PrepData, s: PrepSession, pool: Pool) {
  const log = s.turns
    .filter((t) => t.answer)
    .map((t, i) => `${i + 1}. ${t.followUp ? "（追问）" : ""}${red(pool, t.question)}\n回答：${red(pool, t.answer!).slice(0, 600)}\n点评：${red(pool, `${t.feedback?.good ?? ""} ${t.feedback?.missing ?? ""}`)}`)
    .join("\n\n");
  const r = await chatJson<{ summary?: string }>(
    `你是面试官，模拟面试结束了。根据整场问答写一段总结，只输出 JSON：{"summary":"三部分，每部分一两句：整体表现；最需要改进的两点；面试前最值得再准备的一件事"}。具体，不客套。【人名1】这类占位符保持原样。`,
    `岗位：${p.company} · ${p.title}（${p.round}）\n\n${log}`,
    0.3,
  );
  return restore(String(r?.summary ?? ""), pool.map).trim();
}
