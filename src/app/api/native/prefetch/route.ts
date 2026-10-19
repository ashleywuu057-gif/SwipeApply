import { ensureInsight } from "@/lib/native/insight";
import { ensureJd, startBrief } from "@/lib/native/intel";
import { findJobForMe } from "@/lib/native/jobs";
import { once, readJd, shared } from "@/lib/native/store";
import type { InsightView } from "@/lib/native/types";

/**
 * 预取：卡片翻到最上面时，在后台抓 JD、生成公司速览、让 AI 分析匹配理由，右滑进工作台时基本是现成的。
 * 最上面那张会等 AI 的匹配理由（最多 40 秒；找 JD 要浏览器打开、联网搜索时会慢一些），返回后前端直接更新卡片背面；其余的只在后台跑。
 */
export async function POST(req: Request) {
  const { jobIds } = (await req.json()) as { jobIds: string[] };
  const insights: Record<string, InsightView> = {};
  const jds: Record<string, string> = {};
  const ids = (jobIds ?? []).slice(0, 3);
  for (const [i, id] of ids.entries()) {
    const job = await findJobForMe(id);
    if (!job || job.source === "示例") continue;
    const work = async () => {
      const jd = await shared(`jd:${id}`, () => ensureJd(job)); // 和工作台共用同一次查找
      startBrief(job, jd.text);
      return ensureInsight(job, jd.status === "ok" ? jd.text : "");
    };
    if (i === 0) {
      const r = await Promise.race([shared(`prefetch:${id}`, work).catch(() => null), new Promise<null>((ok) => setTimeout(() => ok(null), 40000))]);
      if (r) insights[id] = r;
      const jd = await readJd(id);
      if (jd?.status === "ok") jds[id] = jd.text.slice(0, 400);
    } else once(`prefetch:${id}`, work);
  }
  return Response.json({ insights, jds });
}
