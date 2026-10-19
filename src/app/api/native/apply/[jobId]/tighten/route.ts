import { tightenBullets } from "@/lib/native/resume";
import { readApply, readMemory, saveApply } from "@/lib/native/store";

type Ctx = { params: Promise<{ jobId: string }> };

/** 收短最后一行只有几个字的 bullet（哪几条、压到多少字由前端按真实排版量出来） */
export async function POST(req: Request, { params }: Ctx) {
  const jobId = (await params).jobId;
  const b = (await req.json().catch(() => ({}))) as { items?: { id: string; maxLen: number }[] };
  const state = await readApply(jobId);
  if (!state.resume) return Response.json({ error: "还没有简历" }, { status: 400 });
  try {
    const r = await tightenBullets(state.resume, (b.items ?? []).slice(0, 20), await readMemory());
    if (r.changed) {
      state.resume = r.resume;
      await saveApply(state);
    }
    return Response.json({ state, changed: r.changed, kept: r.kept });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
