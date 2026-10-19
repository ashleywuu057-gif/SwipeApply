import { practiceStep } from "@/lib/prep";

type Ctx = { params: Promise<{ appId: string }> };

/** 模拟面试的一步：不带 sessionId 开始新的一场；带 answer 点评这一题并给出下一题 */
export async function POST(req: Request, { params }: Ctx) {
  const { appId } = await params;
  const b = (await req.json().catch(() => ({}))) as { sessionId?: string; answer?: string };
  try {
    const r = await practiceStep(appId, b);
    if ("error" in r) return Response.json(r, { status: 400 });
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
