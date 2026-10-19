import { findByCompany } from "@/lib/mail-apply";
import { newId } from "@/lib/store";
import { snapshotOf } from "@/lib/tracker-logic";
import { updateTracker } from "@/lib/tracker-store";
import type { Application } from "@/lib/tracker-types";

/** 新建投递记录：从岗位库一键投递（jobId），或手动填写 */
export async function POST(req: Request) {
  const b = (await req.json()) as { jobId?: string; company?: string; title?: string; link?: string };
  const now = new Date().toISOString();
  const result = await updateTracker((d) => {
    const job = b.jobId ? d.jobs.find((j) => j.id === b.jobId) : undefined;
    if (job) {
      const existing = d.applications.find((a) => a.jobId === job.id || a.jobIds?.includes(job.id));
      if (existing) return existing;
    }
    const company = (job?.company ?? b.company ?? "").trim();
    if (!company) return null;
    // 同一家公司已经有投递记录：把这个岗位并进去，不新建
    const same = findByCompany(d.applications, company);
    if (same) {
      const title = (job?.title ?? b.title ?? "").trim();
      if (title && !same.title.split(" / ").includes(title)) same.title = same.title ? `${same.title} / ${title}` : title;
      if (job) same.jobIds = [...new Set([...(same.jobIds ?? (same.jobId ? [same.jobId] : [])), job.id])];
      if (!same.link) same.link = (job?.link ?? b.link ?? "").trim();
      same.updatedAt = now;
      return same;
    }
    const app: Application = {
      id: newId(),
      jobId: job?.id,
      company,
      title: (job?.title ?? b.title ?? "").trim(),
      link: (job?.link ?? b.link ?? "").trim(),
      stage: "已投递",
      appliedAt: now,
      events: [{ id: newId(), date: now, kind: "投递确认", title: "已投递", source: "手动" }],
      notes: "",
      updatedAt: now,
    };
    app.snapshot = snapshotOf(app, job, job ? "岗位流" : "手动");
    d.applications.push(app);
    return app;
  });
  if (!result) return Response.json({ error: "请填写公司" }, { status: 400 });
  return Response.json({ application: result });
}
