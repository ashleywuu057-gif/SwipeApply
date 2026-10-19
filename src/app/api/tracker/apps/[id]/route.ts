import { newId } from "@/lib/store";
import { nextStage } from "@/lib/tracker-logic";
import { updateTracker } from "@/lib/tracker-store";
import { STAGES, type EventKind, type Stage } from "@/lib/tracker-types";

type Ctx = { params: Promise<{ id: string }> };

type Body = {
  stage?: Stage;
  notes?: string;
  title?: string;
  link?: string;
  addEvent?: { kind: EventKind; title: string; scheduledAt?: string; link?: string };
  removeEventId?: string;
};

/** 改状态、备注；手动添加 / 删除时间线事件 */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const b = (await req.json()) as Body;
  const app = await updateTracker((d) => {
    const a = d.applications.find((x) => x.id === id);
    if (!a) return null;
    if (b.stage && STAGES.includes(b.stage)) a.stage = b.stage;
    if (b.notes !== undefined) a.notes = b.notes;
    if (b.title !== undefined) a.title = b.title;
    if (b.link !== undefined) a.link = b.link;
    if (b.addEvent) {
      a.events.push({ id: newId(), date: new Date().toISOString(), source: "手动", ...b.addEvent });
      if (!b.stage) a.stage = nextStage(a.stage, b.addEvent.kind);
    }
    if (b.removeEventId) a.events = a.events.filter((e) => e.id !== b.removeEventId);
    a.updatedAt = new Date().toISOString();
    return a;
  });
  if (!app) return Response.json({ error: "未找到" }, { status: 404 });
  return Response.json({ application: app });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await updateTracker((d) => {
    d.applications = d.applications.filter((a) => a.id !== id);
    for (const m of d.mails) if (m.applicationId === id) m.applicationId = undefined;
  });
  return Response.json({ ok: true });
}
