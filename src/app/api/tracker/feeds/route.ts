import { newId } from "@/lib/store";
import { updateTracker } from "@/lib/tracker-store";

/** 添加订阅源；也可以改每天自动更新的时间、开关联网搜索和 jobworthy、改找岗位的关键词 */
export async function POST(req: Request) {
  const b = (await req.json()) as { name?: string; url?: string; dailyTime?: string; webSearch?: boolean; jobworthy?: boolean; jobKeywords?: string[] };
  const settings = await updateTracker((d) => {
    if (b.dailyTime && /^\d{2}:\d{2}$/.test(b.dailyTime)) d.settings.dailyTime = b.dailyTime;
    if (typeof b.webSearch === "boolean") d.settings.webSearch = b.webSearch;
    if (typeof b.jobworthy === "boolean") d.settings.jobworthy = b.jobworthy;
    if (Array.isArray(b.jobKeywords)) d.settings.jobKeywords = b.jobKeywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 6);
    if (b.url?.trim()) {
      d.settings.feeds.push({ id: newId(), name: b.name?.trim() || b.url.trim(), url: b.url.trim(), enabled: true });
    }
    return d.settings;
  });
  return Response.json({ settings });
}
