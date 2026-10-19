import "server-only";
import { readTracker } from "../tracker-store";
import type { JobPosting } from "../tracker-types";
import { readLibrary } from "../store";
import { roleWants } from "./feed";
import { pickRole, resumeRoleWords, splitRoles } from "./role-focus";
import { SAMPLE_JOBS } from "./samples";
import { readMemory } from "./store";

/** 岗位库为空时用示例岗位 */
export async function allJobs(): Promise<{ jobs: JobPosting[]; sample: boolean }> {
  const d = await readTracker();
  if (d.jobs.length) return { jobs: d.jobs, sample: false };
  return { jobs: SAMPLE_JOBS.map(stripJd), sample: true };
}

export async function findJob(jobId: string): Promise<JobPosting | null> {
  const d = await readTracker();
  const j = d.jobs.find((x) => x.id === jobId);
  if (j) return j;
  const s = SAMPLE_JOBS.find((x) => x.id === jobId);
  if (!s) return null;
  return stripJd(s);
}

/**
 * 同 findJob，但岗位名是一串大类（「开发/算法/产品/运营」）时换成最对口的那一个，和岗位流卡片上写的一致。
 * 返回的是副本，只用于显示、写简历、记录投递；不要拿它写回岗位库。
 */
export async function findJobForMe(jobId: string): Promise<JobPosting | null> {
  const job = await findJob(jobId);
  if (!job || !splitRoles(job.title).length) return job;
  const [d, mem, lib] = await Promise.all([readTracker(), readMemory(), readLibrary()]);
  const f = d.settings.todayFocus;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const wants = roleWants(mem, f && f.date === today ? f : undefined, d.settings.myDirections, now);
  return { ...job, title: pickRole(job.title, wants, resumeRoleWords(lib.cards.map((c) => c.role ?? ""))) };
}

function stripJd(s: (typeof SAMPLE_JOBS)[number]): JobPosting {
  const job: Partial<typeof s> = { ...s };
  delete job.jd;
  return job as JobPosting;
}
