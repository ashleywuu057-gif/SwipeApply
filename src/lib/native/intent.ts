import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { llmConfig } from "../extract";
import { buildContext, redact } from "../redact";
import { readLibrary } from "../store";
import { normCompany } from "../tracker-logic";
import { readTracker } from "../tracker-store";
import type { JobPosting } from "../tracker-types";
import { chatJson, smallModel } from "./llm";
import { prefGuide, RULES_SHAPE, type Raw } from "./say";

/**
 * 统一入口的意图识别：首页对话框里的一句话，先判断想做什么，再交给对应的环节。
 *   prefs   调整推荐 → 一句话设偏好
 *   resume  改简历   → 打开对应岗位的工作台，把这句话交给工作台 Agent
 *   company 问公司   → 公司速览
 *   fact    补充经历 → 记为补充事实，之后写简历都能用
 *   other   其他     → 说明能做什么
 * 一次快模型调用输出参数包，在本地核对；模型出错时退回关键词规则。没把握时反问，不猜。
 * 是「调整推荐」时同一次调用顺便把偏好规则拆好（prefs），省掉第二次调用。
 */

export const INTENTS = ["prefs", "resume", "company", "fact", "other"] as const;
export type Intent = (typeof INTENTS)[number];

export interface IntentPack {
  intent: Intent;
  confidence: number; // 0~1
  company: string; // 想投 / 想了解的目标公司（不是 TA 自己的经历公司）
  experience: string; // 提到的 TA 自己的某段经历，例如"快手那段"
  by: "AI" | "规则";
  prefs?: { rules?: Raw[]; unclear?: string }; // intent 是 prefs 时模型顺便拆好的规则（还没核对，见 say.ts 的 checkRules）
}

const PROMPT = (mine: string[], targets: string[], now: Date) => `你在一个求职工具首页的对话框后面，判断用户这句话想做什么。只输出 JSON：
{"intent":"prefs|resume|company|fact|other","confidence":0到1的数字,"company":"目标公司或空字符串","experience":"提到的自己的经历或空字符串",${RULES_SHAPE}}

意图：
- prefs：调整推荐哪些岗位（方向、城市、公司、行业、海外等），例如"别推 To B""这周只看上海的""多推出海"
- resume：修改简历，例如"快手那段写得更数据化""精简到一页""突出数据分析能力"
- company：了解一家公司，例如"米哈游最近在做什么""小红书的商业化是哪个部门"
- fact：告诉你一段自己的经历或技能事实，例如"我在字节实习时用过 SQL 做留存分析"
- other：以上都不是

字段：
- company：用户想投或想了解的目标公司，原样照抄用户的说法
- experience：用户提到的自己的某段经历（例如"快手那段"里的"快手"）
- TA 自己的经历所在公司：${mine.length ? mine.join("、") : "（未知）"}。提到这些公司时，通常是在说自己的经历，填 experience，不填 company
- TA 最近在投的公司：${targets.length ? targets.join("、") : "（还没有）"}
- 拿不准属于哪个意图时，confidence 低于 0.6

intent 是 prefs 时，同时把这句话拆成偏好规则填进 rules / unclear；其他意图 rules 写 []、unclear 写空字符串。
${prefGuide(now)}`;

export async function classifyIntent(text: string, ctx: { mine: string[]; targets: string[] }, now = new Date()): Promise<IntentPack> {
  if (llmConfig().enabled) {
    try {
      const r = await chatJson<{ intent?: string; confidence?: number; company?: string; experience?: string; rules?: Raw[]; unclear?: string }>(PROMPT(ctx.mine, ctx.targets, now), text.slice(0, 300), 0, undefined, smallModel());
      const intent = INTENTS.find((i) => i === r?.intent);
      if (intent) {
        const conf = Number(r?.confidence);
        return {
          intent,
          confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
          company: String(r?.company ?? "").trim().slice(0, 30),
          experience: String(r?.experience ?? "").trim().slice(0, 30),
          by: "AI",
          prefs: intent === "prefs" && Array.isArray(r?.rules) ? { rules: r.rules, unclear: r.unclear } : undefined,
        };
      }
    } catch {
      // 退回规则
    }
  }
  return byRules(text, ctx);
}

/** 没有模型或模型出错时：按关键词判断 */
function byRules(text: string, ctx: { mine: string[]; targets: string[] }): IntentPack {
  const t = text.trim();
  const hit = (list: string[]) => list.find((c) => c && t.includes(c)) ?? "";
  const target = hit(ctx.targets);
  const intent: Intent = /简历|扩写|精简|改写|改一下|写得|突出|bullet|一页/i.test(t)
    ? "resume"
    : /^我(在|做过|用过|会|有|参与|负责|主导)/.test(t)
      ? "fact"
      : /推|别看|只看|多看|少看|不要|不想看|方向|城市|岗位/.test(t)
        ? "prefs"
        : target || /公司|在做什么|怎么样|业务|产品线|部门/.test(t)
          ? "company"
          : "other";
  return { intent, confidence: 0.5, company: target, experience: hit(ctx.mine), by: "规则" };
}

/** 识别要用的上下文：TA 的经历公司（先脱敏）、最近打开过工作台的目标公司 */
export async function intentContext() {
  const lib = await readLibrary();
  const cards = lib.cards.filter((c) => !c.localOnly);
  const rctx = buildContext(lib.settings, cards.map((c) => c.company));
  const map: Record<string, string> = {};
  const mine = [...new Set(cards.map((c) => redact(c.company, rctx, map).text).filter((c) => c && !/【/.test(c)))];
  const recent = await recentJobs();
  return { mine, targets: [...new Set(recent.map((j) => j.company))].slice(0, 12), recent };
}

/** 打开过工作台（有定制简历）的岗位，最近改过的在前 */
export async function recentJobs(): Promise<JobPosting[]> {
  const dir = path.join(process.cwd(), "data", "native", "apply");
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const stamped = await Promise.all(
    files.filter((f) => f.endsWith(".json")).map(async (f) => ({ id: f.slice(0, -5), at: (await fs.stat(path.join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  const { jobs } = await readTracker();
  return stamped
    .sort((a, b) => b.at - a.at)
    .map((s) => jobs.find((j) => j.id === s.id))
    .filter((j): j is JobPosting => Boolean(j));
}

/** 按公司名找岗位：打开过工作台的优先，其次岗位库里的具体岗位 */
export async function jobsOfCompany(company: string, recent: JobPosting[]): Promise<JobPosting[]> {
  const k = normCompany(company);
  if (k.length < 2) return [];
  const same = (j: JobPosting) => {
    const c = normCompany(j.company);
    return c.length >= 2 && (c.includes(k) || k.includes(c));
  };
  const opened = recent.filter(same);
  const { jobs } = await readTracker();
  const rest = jobs.filter((j) => same(j) && !j.siteOnly && !opened.some((o) => o.id === j.id));
  return [...opened, ...rest];
}
