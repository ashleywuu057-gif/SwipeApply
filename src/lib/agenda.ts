import "server-only";
import { readMemory, readPrep } from "./native/store";
import { INTERVIEW_KINDS } from "./prep";
import { normCompany, upcomingDeadlines } from "./tracker-logic";
import { readTracker, updateTracker } from "./tracker-store";
import type { Application } from "./tracker-types";

/**
 * 待办：「我的投递」的未来 30 天日程、首页每日简报都从这里读，保证两边一致。
 * - 日程：测评 / 笔试 / 面试（确认过的邮件，带时间）+ 还没投的网申截止（标星、你的方向、岗位流里「稍后再看」的）
 * - 待跟进：投递后两周没有任何进展的公司（没有具体时间，不混进日程）
 */

const isInterview = (kind: string) => (INTERVIEW_KINDS as readonly string[]).includes(kind);
const ACTIVE = new Set(["已投递", "测评", "笔试", "AI面", "面试", "HR面"]);
const FOLLOW_UP_DAYS = 14;

export interface AgendaItem {
  key: string;
  kind: string; // 面试 / AI面 / HR面 / 测评 / 笔试 / 网申截止
  at: string; // 本地时间 YYYY-MM-DDTHH:mm
  company: string;
  title: string;
  link?: string;
  appId?: string;
  jobId?: string;
  saved?: boolean; // 岗位流里点了「稍后再看」
  urgent: boolean; // 24 小时内
  prep?: "ready" | "preparing" | "failed" | "none"; // 面试类：准备材料的状态
  practiced?: boolean; // 面试类：练过至少一遍
  done?: boolean; // 你打勾划掉了
}

export interface FollowUp {
  appId: string;
  company: string;
  title: string;
  stage: string;
  lastAt: string;
  days: number;
}

export interface Agenda {
  items: AgendaItem[];
  followUps: FollowUp[];
  undated: number; // 进行中但没有任何日期（例如从表格导入），判断不了要不要跟进
  pendingMails: { total: number; interviews: number };
}

/** 最后一次有动静的时间：投递、时间线事件、阶段变化里最晚的一个 */
function lastActivity(a: Application): string {
  const dates = [a.appliedAt, ...a.events.map((e) => e.date), ...(a.stageLog ?? []).map((s) => s.at)].filter(Boolean);
  return dates.sort().at(-1) ?? "";
}

export async function buildAgenda(now = new Date()): Promise<Agenda> {
  const [d, mem] = await Promise.all([readTracker(), readMemory()]);
  const from = now.getTime() - 3600000;
  const to = now.getTime() + 30 * 86400000;
  const urgent = (t: number) => t - now.getTime() <= 86400000;

  // 1. 测评 / 笔试 / 面试
  const items: AgendaItem[] = [];
  for (const a of d.applications)
    for (const e of a.events) {
      if (!e.scheduledAt) continue;
      const t = new Date(e.scheduledAt).getTime();
      if (t < from || t > to) continue;
      const item: AgendaItem = { key: e.id, kind: e.kind, at: e.scheduledAt, company: a.company, title: a.title, link: e.link, appId: a.id, urgent: urgent(t) };
      if (isInterview(e.kind)) {
        const p = await readPrep(a.id);
        item.prep = p?.status ?? "none";
        item.practiced = Boolean(p?.sessions.some((s) => s.turns.some((x) => x.answer)));
      }
      items.push(item);
    }

  // 2. 网申截止：标星 / 你的方向（原有规则）+ 岗位流里「稍后再看」的
  const saved = new Set(mem.swipes.filter((s) => s.action === "save").map((s) => s.jobId));
  const seen = new Set<string>();
  const addDeadline = (jobId: string, company: string, title: string, deadlineAt: string, link: string) => {
    if (seen.has(jobId)) return;
    seen.add(jobId);
    const at = `${deadlineAt}T23:59`;
    items.push({ key: `ddl-${jobId}`, kind: "网申截止", at, company, title, link, jobId, saved: saved.has(jobId), urgent: urgent(new Date(at).getTime()) });
  };
  for (const { job } of upcomingDeadlines(d.jobs, d.applications, d.settings.myDirections ?? [], now)) addDeadline(job.id, job.company, job.title, job.deadlineAt!, job.link);
  const applied = new Set(d.applications.flatMap((a) => [a.jobId, ...(a.jobIds ?? [])]).filter(Boolean));
  const appliedCompanies = new Set(d.applications.map((a) => normCompany(a.company)));
  const today = localDate(now);
  const until = localDate(new Date(to));
  for (const j of d.jobs)
    if (saved.has(j.id) && j.deadlineAt && j.deadlineAt >= today && j.deadlineAt <= until && !applied.has(j.id) && !appliedCompanies.has(normCompany(j.company)))
      addDeadline(j.id, j.company, j.title, j.deadlineAt, j.link);

  items.sort((x, y) => x.at.localeCompare(y.at));
  const doneMap = d.settings.agendaDone ?? {};
  for (const i of items) if (doneMap[i.key]) i.done = true;

  // 3. 待跟进：进行中、没有已安排的下一步、两周没动静；点过「查过了」的 14 天内不再提醒
  const followUps: FollowUp[] = [];
  let undated = 0;
  for (const a of d.applications) {
    if (!ACTIVE.has(a.stage)) continue;
    const checked = doneMap[followKey(a.id)];
    if (checked && now.getTime() - new Date(checked).getTime() < FOLLOW_UP_DAYS * 86400000) continue;
    if (a.events.some((e) => e.scheduledAt && new Date(e.scheduledAt).getTime() >= from)) continue;
    const last = lastActivity(a);
    if (!last) {
      undated++;
      continue;
    }
    const days = Math.floor((now.getTime() - new Date(last).getTime()) / 86400000);
    if (days >= FOLLOW_UP_DAYS) followUps.push({ appId: a.id, company: a.company, title: a.title, stage: a.stage, lastAt: last, days });
  }
  followUps.sort((x, y) => y.days - x.days);

  const pending = d.mails.filter((m) => m.status === "待确认");
  return {
    items,
    followUps,
    undated,
    pendingMails: { total: pending.length, interviews: pending.filter((m) => isInterview(m.kind)).length },
  };
}

export const followKey = (appId: string) => `follow-${appId}`;
const DONE_TTL = 60 * 86400000;

/** 打勾 / 取消打勾（日程条目用它的 key，待跟进用 followKey）。顺带清掉 60 天前的记录 */
export async function setAgendaDone(key: string, done: boolean) {
  await updateTracker((d) => {
    const m = { ...(d.settings.agendaDone ?? {}) };
    if (done) m[key] = new Date().toISOString();
    else delete m[key];
    const cutoff = Date.now() - DONE_TTL;
    for (const [k, at] of Object.entries(m)) if (new Date(at).getTime() < cutoff) delete m[k];
    d.settings.agendaDone = m;
  });
}

function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
