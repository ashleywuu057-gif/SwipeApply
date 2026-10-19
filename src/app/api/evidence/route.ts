import { eligible, extractMany } from "@/lib/evidence";
import { readEvidence, readLibrary, updateEvidence } from "@/lib/store";

/** 某段经历下的证据条目（含隐藏的），附来源文件名 */
export async function GET(req: Request) {
  const cardId = new URL(req.url).searchParams.get("cardId");
  const [list, lib] = await Promise.all([readEvidence(), readLibrary()]);
  const names = new Map(lib.sources.map((s) => [s.id, s.name]));
  const items = list.filter((e) => !cardId || e.cardId === cardId).map((e) => ({ ...e, sourceName: names.get(e.sourceId) ?? "（资料已删除）" }));
  const eligibleSources = lib.sources.filter((s) => eligible(s, lib.cards) && (!cardId || s.cardId === cardId)).map((s) => s.id);
  return Response.json({ items, eligibleSources });
}

/** 重新提炼：指定资料，或某段经历下的全部资料，或 all = 全部符合条件的资料 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { sourceIds?: string[]; cardId?: string; all?: boolean };
  const lib = await readLibrary();
  const ids = b.sourceIds?.length
    ? b.sourceIds
    : lib.sources.filter((s) => eligible(s, lib.cards) && (b.all || (b.cardId && s.cardId === b.cardId))).map((s) => s.id);
  if (!ids.length) return Response.json({ error: "没有可以提炼的资料：需要是挂在这段经历下的项目复盘或工作源文件" }, { status: 400 });
  return Response.json({ results: await extractMany(ids) });
}

/** 隐藏 / 取消隐藏一条 */
export async function PATCH(req: Request) {
  const b = (await req.json()) as { id: string; hidden: boolean };
  const ok = await updateEvidence((list) => {
    const e = list.find((x) => x.id === b.id);
    if (e) e.hidden = Boolean(b.hidden);
    return Boolean(e);
  });
  return ok ? Response.json({ ok }) : Response.json({ error: "条目不存在" }, { status: 404 });
}
