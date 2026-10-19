import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { normCompany } from "../tracker-logic";
import type { ChatMsg, CompanyBrief, InsightView, JdInfo, MatchReason, MemoryData, PrepData, Resume } from "./types";

/**
 * 新版的数据也只存在本机：
 * data/memory.json              AI 的长期记忆（滑动记录、岗位偏好、写作偏好、补充事实、简历抬头）
 * data/native/jd/<jobId>.json   抓到的 JD
 * data/native/company/<公司>.json 公司速览缓存
 * data/native/apply/<jobId>.json 每个岗位的定制简历和对话
 * data/native/insight/<jobId>.json AI 分析的匹配理由（卡片背面"为什么推给你"）
 */
const DATA = path.join(process.cwd(), "data");
const MEM_FILE = path.join(DATA, "memory.json");
const DIR = path.join(DATA, "native");

const EMPTY: MemoryData = {
  swipes: [],
  rules: [],
  writing: [],
  facts: [],
  edits: [],
  profile: { nickname: "", name: "", phone: "", email: "", education: "", extra: "" },
};

export async function readMemory(): Promise<MemoryData> {
  try {
    const d = JSON.parse(await fs.readFile(MEM_FILE, "utf8")) as Partial<MemoryData>;
    return { ...structuredClone(EMPTY), ...d, profile: { ...EMPTY.profile, ...(d.profile ?? {}) } };
  } catch {
    return structuredClone(EMPTY);
  }
}

let memChain: Promise<unknown> = Promise.resolve();
export async function updateMemory<T>(fn: (m: MemoryData) => T | Promise<T>): Promise<T> {
  const run = memChain.then(async () => {
    const m = await readMemory();
    const r = await fn(m);
    await writeJson(MEM_FILE, m);
    return r;
  });
  memChain = run.catch(() => undefined);
  return run;
}

async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function safe(id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error("非法 id");
  return id;
}

/** 公司名做文件名：去掉标点，中文保留 */
export function companyKey(company: string) {
  const k = (normCompany(company) || company).replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 60);
  return k || "unknown";
}

export const readJd = (jobId: string) => readJson<JdInfo>(path.join(DIR, "jd", `${safe(jobId)}.json`));
export const saveJd = (jd: JdInfo) => writeJson(path.join(DIR, "jd", `${safe(jd.jobId)}.json`), jd);

export interface Insight {
  jobId: string;
  reasons: MatchReason[];
  gaps?: string[]; // JD 看重、素材里找不到证据的点（只有按 JD 分析时才有）
  basis: string; // 分析时用了哪些信息（岗位名 / JD）
  v?: number; // 分析版本，低于当前版本的缓存会重算
  at: string;
}
/** 当前分析版本：2 = 同时找差距；3 = 牵强证据规则 + 经历标签（缓存里版本更低的会重算） */
export const INSIGHT_V = 3;
/** 给岗位流用：只有当前版本、按 JD 分析的缓存才算"知道差距" */
export function insightView(x: Insight): InsightView {
  return { reasons: x.reasons, gaps: x.basis === "JD" && (x.v ?? 1) >= INSIGHT_V ? (x.gaps ?? []) : null };
}
export const readInsight = (jobId: string) => readJson<Insight>(path.join(DIR, "insight", `${safe(jobId)}.json`));
export const saveInsight = (x: Insight) => writeJson(path.join(DIR, "insight", `${safe(x.jobId)}.json`), x);

export const readBrief = (company: string) => readJson<CompanyBrief>(path.join(DIR, "company", `${companyKey(company)}.json`));
export const saveBrief = (b: CompanyBrief) => writeJson(path.join(DIR, "company", `${companyKey(b.company)}.json`), b);

export const readPrep = (appId: string) => readJson<PrepData>(path.join(DIR, "prep", `${safe(appId)}.json`));
export const savePrep = (p: PrepData) => writeJson(path.join(DIR, "prep", `${safe(p.appId)}.json`), { ...p, updatedAt: new Date().toISOString() });

export interface ApplyState {
  jobId: string;
  resume: Resume | null;
  chat: ChatMsg[];
  companyChat: ChatMsg[];
  submittedAt?: string;
  applicationId?: string;
}
export async function readApply(jobId: string): Promise<ApplyState> {
  return (await readJson<ApplyState>(path.join(DIR, "apply", `${safe(jobId)}.json`))) ?? { jobId, resume: null, chat: [], companyChat: [] };
}
export const saveApply = (s: ApplyState) => writeJson(path.join(DIR, "apply", `${safe(s.jobId)}.json`), s);

/** 同一时间每个任务只跑一次（跨路由共享，放在 globalThis 上）；再次调用拿到的是同一个 Promise */
function running() {
  const g = globalThis as unknown as { __nativeJobs?: Map<string, Promise<unknown>> };
  g.__nativeJobs ??= new Map();
  return g.__nativeJobs;
}
export function shared<T>(key: string, job: () => Promise<T>): Promise<T> {
  const m = running();
  const cur = m.get(key) as Promise<T> | undefined;
  if (cur) return cur;
  const p = job().finally(() => m.delete(key));
  m.set(key, p);
  return p;
}
export function once(key: string, job: () => Promise<unknown>) {
  if (running().has(key)) return false;
  shared(key, job).catch((e) => console.error(`[${key}]`, e));
  return true;
}
export function isRunning(key: string) {
  return running().has(key);
}
