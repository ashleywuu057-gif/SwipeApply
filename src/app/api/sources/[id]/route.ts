import { deleteSourceText, readLibrary, readSourceText, updateEvidence, updateLibrary } from "@/lib/store";
import { CATEGORIES, type Category } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const lib = await readLibrary();
  const source = lib.sources.find((s) => s.id === id);
  if (!source) return Response.json({ error: "未找到" }, { status: 404 });
  return Response.json({ source, text: await readSourceText(id) });
}

/** 修改分类或归属（每份资料只属于一个分类、一段经历） */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const { category, cardId } = (await req.json()) as { category?: Category; cardId?: string | null };
  const source = await updateLibrary((lib) => {
    const s = lib.sources.find((x) => x.id === id);
    if (!s) return null;
    if (category && CATEGORIES.includes(category)) s.category = category;
    if (cardId !== undefined) s.cardId = cardId && lib.cards.some((c) => c.id === cardId) ? cardId : null;
    if (s.category === "简历") s.cardId = null;
    return s;
  });
  if (!source) return Response.json({ error: "未找到" }, { status: 404 });
  return Response.json({ source });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await updateLibrary((lib) => {
    lib.sources = lib.sources.filter((s) => s.id !== id);
    for (const c of lib.cards) c.sourceIds = c.sourceIds.filter((s) => s !== id);
  });
  await deleteSourceText(id);
  // 从这份资料提炼的证据一起删掉
  await updateEvidence((list) => {
    const rest = list.filter((e) => e.sourceId !== id);
    list.length = 0;
    list.push(...rest);
  });
  return Response.json({ ok: true });
}
