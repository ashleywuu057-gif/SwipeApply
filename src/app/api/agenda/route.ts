import { buildAgenda, setAgendaDone } from "@/lib/agenda";

/** 待办：未来 30 天日程、待跟进、待确认邮件（「我的投递」和首页简报共用） */
export async function GET() {
  return Response.json(await buildAgenda());
}

/** 打勾划掉 / 取消：{ key, done }。key 是日程条目的 key，待跟进用 "follow-投递id" */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { key?: string; done?: boolean };
  if (!b.key || typeof b.key !== "string" || b.key.length > 100) return Response.json({ error: "缺少 key" }, { status: 400 });
  await setAgendaDone(b.key, b.done !== false);
  return Response.json(await buildAgenda());
}
