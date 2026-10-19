import { buildApplyKitProfile } from "@/lib/applykit";

/**
 * 浏览器插件「投简助手」同步履历用（只在本机之间调用）。
 * ?url= 当前网申页地址：能对上岗位库里的岗位时，用这个岗位定制过的简历经历。
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url).searchParams.get("url");
    return Response.json(await buildApplyKitProfile(url));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
