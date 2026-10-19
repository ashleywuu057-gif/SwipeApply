import { ensureJd, setManualJd } from "@/lib/native/intel";
import { findJob } from "@/lib/native/jobs";

type Ctx = { params: Promise<{ jobId: string }> };

/** 手动粘贴 JD（官网是动态页面、抓不到时） */
export async function PUT(req: Request, { params }: Ctx) {
  const { text } = (await req.json()) as { text: string };
  return Response.json({ jd: await setManualJd((await params).jobId, text ?? "") });
}

/** 重新找一遍（直接下载 → 浏览器打开 → 联网搜索） */
export async function POST(_req: Request, { params }: Ctx) {
  const job = await findJob((await params).jobId);
  if (!job) return Response.json({ error: "岗位不存在" }, { status: 404 });
  return Response.json({ jd: await ensureJd(job, { force: true }) });
}
