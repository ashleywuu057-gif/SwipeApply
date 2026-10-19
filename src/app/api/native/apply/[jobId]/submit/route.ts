import { findByCompany } from "@/lib/mail-apply";
import { newId } from "@/lib/store";
import { updateTracker } from "@/lib/tracker-store";
import { findJobForMe } from "@/lib/native/jobs";
import { INSIGHT_V, readApply, readInsight, saveApply, updateMemory } from "@/lib/native/store";
import { evidenceScore } from "@/lib/native/score";
import { snapshotOf } from "@/lib/tracker-logic";

type Ctx = { params: Promise<{ jobId: string }> };

/** 你在官网提交之后：写进「我的投递」（同一家公司只保留一条），这份简历存档 */
export async function POST(_req: Request, { params }: Ctx) {
  const jobId = (await params).jobId;
  const job = await findJobForMe(jobId);
  if (!job) return Response.json({ error: "岗位不存在" }, { status: 404 });
  const now = new Date().toISOString();
  const state = await readApply(jobId);

  let applicationId: string | undefined;
  if (job.source !== "示例") {
    // 记下投递时的匹配情况，以后看哪类岗位推进得好
    const ins = await readInsight(jobId);
    const byJd = ins?.basis === "JD" && (ins.v ?? 1) >= INSIGHT_V;
    const snapshot = snapshotOf(job, job, "岗位流", {
      reasonCount: ins?.reasons.length,
      gapCount: byJd ? (ins.gaps?.length ?? 0) : undefined,
      score: byJd ? evidenceScore(ins.reasons.length, ins.gaps?.length ?? 0) : undefined,
      resumeBy: state.resume?.by,
    });
    applicationId = await updateTracker((d) => {
      let app = findByCompany(d.applications, job.company);
      if (!app) {
        app = { id: newId(), jobId: job.id, jobIds: [job.id], company: job.company, title: job.title, link: job.link, stage: "已投递", appliedAt: now, events: [], notes: "", updatedAt: now, snapshot };
        d.applications.push(app);
      } else {
        app.jobIds = [...new Set([...(app.jobIds ?? (app.jobId ? [app.jobId] : [])), job.id])];
        if (!app.title.split(" / ").includes(job.title)) app.title = app.title ? `${app.title} / ${job.title}` : job.title;
        if (!app.link) app.link = job.link;
        app.snapshot ??= snapshot;
        app.updatedAt = now;
      }
      app.events.push({ id: newId(), date: now, kind: "备注", title: `在投递工作台定制简历并投递：${job.title}`, source: "手动" });
      return app.id;
    });
  }
  state.submittedAt = now;
  state.applicationId = applicationId;
  await saveApply(state);
  await updateMemory((m) => {
    const s = m.swipes.find((x) => x.jobId === jobId);
    if (s) s.action = "apply";
  });
  return Response.json({ ok: true, applicationId, sample: job.source === "示例" });
}
