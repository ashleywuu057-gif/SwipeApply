import { learnFromEdit } from "@/lib/native/agent";
import { peekJd, getBrief } from "@/lib/native/intel";
import { findJobForMe } from "@/lib/native/jobs";
import { checkBullet, generateResume } from "@/lib/native/resume";
import { readApply, readMemory, saveApply, shared, updateMemory } from "@/lib/native/store";
import { finishProgress, note, readProgress, startProgress, step } from "@/lib/native/progress";
import { jdPoints } from "@/lib/retrieve";
import type { JdInfo, Resume } from "@/lib/native/types";

type Ctx = { params: Promise<{ jobId: string }> };

/** 生成（或重新生成）定制简历 */
export async function POST(_req: Request, { params }: Ctx) {
  const jobId = (await params).jobId;
  const job = await findJobForMe(jobId);
  if (!job) return Response.json({ error: "岗位不存在" }, { status: 404 });
  try {
    // 同一个岗位同时来了两次请求（连点、开发模式下页面挂载两次）：共用同一次生成，不重复调模型
    const resume = await shared(`gen-resume:${jobId}`, async () => {
      startProgress(jobId);
      step(jobId, "读 JD");
      const jd = await peekJd(job);
      note(jobId, jdSummary(job.title, jd));
      const brief = await getBrief(job, jd.text);
      const r = await generateResume(job, jd.text, await readMemory(), brief.status === "ready" ? brief.businessLine : "");
      finishProgress(jobId);
      return r;
    });
    const state = await readApply(jobId);
    state.resume = resume;
    if (resume.gaps.length && !state.chat.length) {
      // AI 主动提问：JD 看重、素材里没证据的点
      state.chat.push({ role: "assistant", text: "我按这个 JD 挑了经历和句子，每一句都能对上你素材库里的原句。有几个点素材里没找到证据：", question: resume.gaps[0], actions: resume.gaps.slice(1) });
    }
    await saveApply(state);
    return Response.json({ state });
  } catch (e) {
    finishProgress(jobId);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** 生成到哪一步了（工作台等待时轮询） */
export async function GET(_req: Request, { params }: Ctx) {
  return Response.json({ steps: readProgress((await params).jobId) });
}

/** "读 JD" 这一步的说明：拆出了哪些要点；没抓到时说清楚按什么定制 */
function jdSummary(title: string, jd: JdInfo) {
  if (jd.status === "searching") return `JD 还在后台找，先按岗位名「${title}」定制`;
  if (jd.status !== "ok" || !jd.text.trim()) return `没抓到 JD，按岗位名「${title}」定制`;
  const points = jdPoints(jd.text);
  if (!points.length) return `JD 共 ${jd.text.length} 字`;
  const cut = (s: string) => (s.length > 14 ? `${s.slice(0, 14).replace(/[，,、；;：:\s]+$/, "")}…` : s);
  return `拆出 ${points.length} 个要点：${points.slice(0, 3).map(cut).join(" / ")}${points.length > 3 ? " 等" : ""}`;
}

/** 保存手动修改；如果改了一句，顺便看看能不能学到写作偏好 */
export async function PUT(req: Request, { params }: Ctx) {
  const jobId = (await params).jobId;
  const b = (await req.json()) as { resume: Resume; edit?: { before: string; after: string } };
  // 手动改的句子也要核对：数字不在依据里的标出来
  for (const e of b.resume.experiences)
    for (const x of e.bullets) {
      const c = checkBullet(x.text, x.source);
      if (c.status === "待核对") Object.assign(x, c);
      else if (x.status === "待核对") Object.assign(x, { status: "手动", issue: undefined });
    }
  const state = await readApply(jobId);
  state.resume = { ...b.resume, updatedAt: new Date().toISOString() };
  await saveApply(state);
  let suggestion: string | null = null;
  if (b.edit && b.edit.before !== b.edit.after) {
    const mem = await updateMemory((m) => {
      m.edits.push({ ...b.edit!, at: new Date().toISOString() });
      m.edits = m.edits.slice(-30);
      return m;
    });
    suggestion = await learnFromEdit(mem, b.edit.before, b.edit.after).catch(() => null);
  }
  return Response.json({ resume: state.resume, suggestion });
}
