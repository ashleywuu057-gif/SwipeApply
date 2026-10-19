import { peekJd, getBrief, startBrief } from "@/lib/native/intel";
import { findJob } from "@/lib/native/jobs";

type Ctx = { params: Promise<{ jobId: string }> };

/** 轮询公司速览 */
export async function GET(_req: Request, { params }: Ctx) {
  const job = await findJob((await params).jobId);
  if (!job) return Response.json({ error: "岗位不存在" }, { status: 404 });
  const jd = await peekJd(job);
  return Response.json({ brief: await getBrief(job, jd.text) });
}

/** 重新生成 */
export async function POST(_req: Request, { params }: Ctx) {
  const job = await findJob((await params).jobId);
  if (!job) return Response.json({ error: "岗位不存在" }, { status: 404 });
  const jd = await peekJd(job);
  startBrief(job, jd.text, true);
  return Response.json({ ok: true });
}
