import "server-only";
import { buildPool } from "./native/resume";
import { readMemory, readPrep, savePrep } from "./native/store";
import { buildPlanB } from "./prep-plan";
import type { PrepData } from "./native/types";
import { normForQuote } from "./research/fetch-page";
import { buildReport } from "./research/report";
import { isRunning, runResearch } from "./research/run";
import { searchConfig } from "./research/search";
import { listResearch, readResearch, saveResearch } from "./research/store";
import type { Research } from "./research/types";
import { newId, readLibrary } from "./store";
import { normCompany } from "./tracker-logic";

/**
 * 面试准备里的深度调研：确认面试邮件后，在找 JD 之后自动发起（复用 /research 的调研 agent 和报告）。
 * - 同一公司同一岗位 14 天内调研过：JD 没变直接复用；JD 变了只按新 JD 重写报告，不重新联网
 * - 一次只跑一个（批量确认多封面试邮件时排队），面试在 24 小时内的预算减半
 * - 调研完成后，报告里的"业务题预判"并进这场面试的题目
 */

const REUSE_MS = 14 * 86400000;
const QUICK = { steps: 12, searches: 6, reads: 5 };

const g = globalThis as unknown as { __prepResearchQueue?: Promise<unknown>; __prepResearchQueued?: Set<string> };
const queued = (g.__prepResearchQueued ??= new Set<string>());

function enqueue(id: string, task: () => Promise<void>) {
  queued.add(id);
  const run = (g.__prepResearchQueue ?? Promise.resolve()).then(async () => {
    queued.delete(id);
    await task();
  });
  g.__prepResearchQueue = run.catch((e) => console.error("[prep-research]", e));
}

/** 调研是否还在跑或在排队（服务重启后，没跑完的记录会停在中间状态） */
export function researchAlive(id: string) {
  return isRunning(id) || queued.has(id);
}

const normTitle = (s: string) => s.toLowerCase().replace(/[（(【\[].*?[)）】\]]|\d{2,4}届|校招|秋招|春招|\s/g, "");
function sameJob(r: Research, p: PrepData) {
  if (r.applicationId === p.appId) return true;
  const a = normTitle(r.jobTitle);
  const b = normTitle(p.jobTitle ?? p.title);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

const emptyUsage = () => ({ steps: 0, searches: 0, reads: 0, accepted: 0, rejected: 0, promptTokens: 0, completionTokens: 0 });

/** 给这场面试找一份可复用的调研，没有就发起一份。返回调研 id；没法调研时返回原因 */
export async function ensureResearch(p: PrepData): Promise<{ id?: string; note?: string }> {
  if (!searchConfig().enabled) return { note: "没配置联网搜索（SEARCH_LLM_API_KEY），这次没做深度调研" };
  const jd = p.jd.text.trim();
  const now = Date.now();
  const same = (await listResearch()).filter((r) => normCompany(r.company) === normCompany(p.company) && sameJob(r, p));

  // 1. 正在跑的、或者 14 天内做完且 JD 一样的：直接用
  const live = same.find((r) => r.jd.trim() === jd && researchAlive(r.id));
  if (live) return { id: live.id };
  const fresh = same.filter((r) => r.status === "完成" && now - Date.parse(r.finishedAt ?? r.createdAt) < REUSE_MS);
  const exact = fresh.find((r) => r.jd.trim() === jd);
  if (exact) return { id: exact.id };

  // 2. 做过但 JD 变了（比如你贴了真实 JD），或者联网调研做完了、只是生成报告失败：沿用调研发现，只重写报告
  const base =
    fresh.find((r) => r.findings.length > 0) ??
    same.find((r) => r.status === "失败" && r.findings.length > 0 && !researchAlive(r.id) && now - Date.parse(r.createdAt) < REUSE_MS);
  if (base) {
    const r: Research = {
      ...base,
      id: newId(),
      jobTitle: p.jobTitle ?? p.title,
      jd,
      applicationId: p.appId,
      from: "面试准备",
      status: "生成报告",
      error: undefined,
      report: undefined,
      trace: [
        ...base.trace,
        { at: new Date().toISOString(), kind: "阶段", text: base.status === "失败" ? "上次联网调研做完了、生成报告失败：沿用调研发现，重新生成报告" : "JD 变了：沿用之前的调研发现，按新 JD 重新生成报告" },
      ],
      createdAt: new Date().toISOString(),
      finishedAt: undefined,
    };
    await saveResearch(r);
    enqueue(r.id, async () => {
      try {
        const lib = await readLibrary();
        r.report = await buildReport(r, lib.cards, lib.settings);
        r.status = "完成";
        r.finishedAt = new Date().toISOString();
      } catch (e) {
        r.status = "失败";
        r.error = (e as Error).message;
      }
      await saveResearch(r);
      await mergeIntoPrep(p.appId, r.id);
    });
    return { id: r.id };
  }

  // 3. 新发起
  const soon = p.scheduledAt && Date.parse(p.scheduledAt) - now < 86400000 && Date.parse(p.scheduledAt) > now;
  const r: Research = {
    id: newId(),
    company: p.company,
    jobTitle: p.jobTitle ?? p.title,
    jd,
    applicationId: p.appId,
    from: "面试准备",
    budget: soon ? QUICK : undefined,
    status: "排队中",
    trace: soon ? [{ at: new Date().toISOString(), kind: "阶段", text: "面试在 24 小时内，调研预算减半，保证来得及" }] : [],
    sources: [],
    findings: [],
    usage: emptyUsage(),
    createdAt: new Date().toISOString(),
  };
  await saveResearch(r);
  enqueue(r.id, async () => {
    await runResearch(r);
    await mergeIntoPrep(p.appId, r.id);
  });
  return { id: r.id };
}

/** 把调研报告里的业务题加进题目（最多 3 道，已有的不重复）。改的是传进来的 p，调用方负责保存 */
export function addBizQuestions(p: PrepData, r: Research) {
  const have = new Set(p.questions.map((q) => normForQuote(q.q)));
  const norm = (s: string) => normForQuote(s);
  let n = p.questions.filter((q) => q.from === "调研").length;
  for (const b of r.report?.bizQuestions ?? []) {
    if (n >= 3) break;
    if (have.has(norm(b.q))) continue;
    // 报告里建议用的原句，能对上这场准备挑出的素材就标上
    const refs = b.use.map((u) => p.matches.find((m) => norm(m.text) === norm(u.quote))?.ref).filter((v): v is string => Boolean(v));
    p.questions.push({ id: newId(), q: b.q, focus: "业务题", refs: [...new Set(refs)], from: "调研" });
    have.add(norm(b.q));
    n++;
  }
}

/** 调研跑完后并进准备材料；准备还在进行中就等它做完（最多 5 分钟） */
async function mergeIntoPrep(appId: string, researchId: string) {
  const r = await readResearch(researchId);
  if (r?.status !== "完成") return;
  for (let i = 0; i < 60; i++) {
    const p = await readPrep(appId);
    if (!p || p.researchId !== researchId || p.status === "failed") return;
    if (p.status === "ready") {
      // 准备稿的"二、公司业务"要等调研做完才能写（一次模型调用，几十秒）
      let business: NonNullable<PrepData["plan"]>["business"];
      if (p.plan && !p.plan.error && !p.plan.business) {
        const pool = await buildPool(await readMemory());
        business = await buildPlanB(p, p.plan, r, pool).catch((e) => {
          console.error("[prep-plan]", e);
          return undefined;
        });
      }
      // 写之前重新读一次，免得覆盖这段时间里你练题的记录
      const latest = await readPrep(appId);
      if (!latest || latest.researchId !== researchId) return;
      const before = latest.questions.length;
      addBizQuestions(latest, r);
      if (business && latest.plan) latest.plan.business = business;
      if (business || latest.questions.length > before) await savePrep(latest);
      return;
    }
    await new Promise((ok) => setTimeout(ok, 5000));
  }
}
