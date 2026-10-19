import { profileFileSchema } from '../shared/schemas';
import type { ApplicationRecord, ProfileFile } from '../shared/types';

/**
 * SwipeApply桥接（jobprep 本地改动，非 ApplyKit 上游代码）。
 * SwipeApply是跑在本机的网页应用（http://localhost:3000）：
 * - 从它同步履历：简历抬头、固定的教育经历、经历卡片（当前网申页对得上岗位时，用这个岗位定制过的简历）
 * - 你在这里确认「已在官网提交」后通知它，记进「我的投递」
 * 只访问本机地址，数据不出你的电脑。
 */

const ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

async function call(path: string, init?: RequestInit): Promise<Response> {
  let last: unknown = null;
  for (const origin of ORIGINS) {
    try {
      return await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(15000) });
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`连不上SwipeApply（请先打开 localhost:3000）：${(last as Error)?.message ?? ''}`);
}

export interface JobprepProfile {
  file: ProfileFile;
  job: { id: string; company: string; title: string } | null;
}

export async function fetchJobprepProfile(targetUrl: string | null): Promise<JobprepProfile> {
  const res = await call(`/api/applykit/profile${targetUrl ? `?url=${encodeURIComponent(targetUrl)}` : ''}`);
  const body = (await res.json()) as { file?: unknown; job?: JobprepProfile['job']; error?: string };
  if (!res.ok || !body.file) throw new Error(body.error ?? `SwipeApply返回 ${res.status}`);
  const parsed = profileFileSchema.safeParse(body.file);
  if (!parsed.success) throw new Error(`SwipeApply的履历格式不对：${parsed.error.issues[0]?.message ?? ''}`);
  return { file: parsed.data as ProfileFile, job: body.job ?? null };
}

/** 确认已提交后通知SwipeApply；失败不影响插件里的记录 */
export function notifyJobprepSubmitted(record: ApplicationRecord): void {
  // 本机演示页 / 自动化测试页（127.0.0.1:4173）上的"提交"不是真实投递，不能写进你的「我的投递」
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(record.sourceUrl ?? '')) return;
  void call('/api/applykit/submitted', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: record.company,
      role: record.role,
      sourceUrl: record.sourceUrl,
      canonicalUrl: record.canonicalUrl,
    }),
  }).catch(() => undefined);
}
