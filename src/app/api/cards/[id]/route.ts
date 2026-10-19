import { readLibrary, updateLibrary } from "@/lib/store";
import type { ExperienceCard } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/** 卡片详情：卡片本身 + 归属这段经历的资料 + 来源简历 */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const lib = await readLibrary();
  const card = lib.cards.find((c) => c.id === id);
  if (!card) return Response.json({ error: "未找到" }, { status: 404 });
  return Response.json({
    card,
    materials: lib.sources.filter((s) => s.cardId === id),
    resumes: lib.sources.filter((s) => card.sourceIds.includes(s.id)),
    cards: lib.cards.map((c) => ({ id: c.id, label: `${c.company || "未填公司"} · ${c.role || "未填岗位"}` })),
  });
}

const EDITABLE: (keyof ExperienceCard)[] = ["type", "company", "role", "start", "end", "summary", "details", "localOnly", "warnings"];

export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  const patch = (await req.json()) as Partial<ExperienceCard>;
  const card = await updateLibrary((lib) => {
    const c = lib.cards.find((x) => x.id === id);
    if (!c) return null;
    for (const k of EDITABLE) if (k in patch) (c as unknown as Record<string, unknown>)[k] = patch[k];
    c.details = c.details.map((s) => s.trim()).filter(Boolean);
    c.updatedAt = new Date().toISOString();
    return c;
  });
  if (!card) return Response.json({ error: "未找到" }, { status: 404 });
  return Response.json({ card });
}

/** 删除卡片：归属它的资料不删，变成"不属于具体经历" */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await updateLibrary((lib) => {
    lib.cards = lib.cards.filter((c) => c.id !== id);
    for (const s of lib.sources) if (s.cardId === id) s.cardId = null;
  });
  return Response.json({ ok: true });
}
