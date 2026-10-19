import { findJob } from "@/lib/native/jobs";
import { updateTracker } from "@/lib/tracker-store";

type Ctx = { params: Promise<{ jobId: string }> };

/** 你在投递工作台点「确认简历，去投递」：记下正在投这个岗位，插件同步履历时用它的定制简历 */
export async function POST(_req: Request, { params }: Ctx) {
  const jobId = (await params).jobId;
  const job = await findJob(jobId);
  if (!job) return Response.json({ error: "岗位不存在" }, { status: 404 });
  await updateTracker((d) => {
    d.settings.activeApply = { jobId, at: new Date().toISOString() };
  });
  return Response.json({ ok: true });
}
