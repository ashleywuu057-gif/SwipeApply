import { updateTracker } from "@/lib/tracker-store";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const { enabled } = (await req.json()) as { enabled?: boolean };
  await updateTracker((d) => {
    const f = d.settings.feeds.find((x) => x.id === id);
    if (f && enabled !== undefined) f.enabled = enabled;
  });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await updateTracker((d) => {
    d.settings.feeds = d.settings.feeds.filter((f) => f.id !== id);
  });
  return Response.json({ ok: true });
}
