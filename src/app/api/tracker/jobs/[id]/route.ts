import { updateTracker } from "@/lib/tracker-store";

type Ctx = { params: Promise<{ id: string }> };

/** 收藏 / 取消收藏 */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const { starred } = (await req.json()) as { starred?: boolean };
  const job = await updateTracker((d) => {
    const j = d.jobs.find((x) => x.id === id);
    if (j && starred !== undefined) j.starred = starred;
    return j ?? null;
  });
  if (!job) return Response.json({ error: "未找到" }, { status: 404 });
  return Response.json({ job });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await updateTracker((d) => {
    d.jobs = d.jobs.filter((j) => j.id !== id);
  });
  return Response.json({ ok: true });
}
