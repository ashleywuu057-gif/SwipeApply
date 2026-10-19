import { setManualJd } from "@/lib/native/intel";
import { readBrief, readPrep } from "@/lib/native/store";
import { INTERVIEW_KINDS, startPrep } from "@/lib/prep";
import { researchAlive } from "@/lib/prep-research";
import { readResearch } from "@/lib/research/store";
import { readTracker } from "@/lib/tracker-store";

type Ctx = { params: Promise<{ appId: string }> };

/** 准备页数据：准备材料 + 公司速览 + 深度调研（进度或报告）+ 投递记录里最近一场面试的时间 */
export async function GET(_req: Request, { params }: Ctx) {
  const { appId } = await params;
  const [prep, d] = await Promise.all([readPrep(appId), readTracker()]);
  const app = d.applications.find((a) => a.id === appId);
  if (!app && !prep) return Response.json({ error: "投递记录不存在" }, { status: 404 });
  const brief = prep ? await readBrief(prep.company) : null;
  const r = prep?.researchId ? await readResearch(prep.researchId) : null;
  const research = r
    ? {
        id: r.id,
        status: r.status,
        // 服务重启后没跑完的调研会停在中间状态
        stalled: r.status !== "完成" && r.status !== "失败" && !researchAlive(r.id),
        error: r.error,
        last: r.trace.at(-1)?.text ?? "",
        usage: r.usage,
        report: r.report ?? null,
        sources: r.sources,
      }
    : null;
  return Response.json({ prep, brief, research, app: app ? { id: app.id, company: app.company, title: app.title, stage: app.stage } : null });
}

/** 开始（或重新）准备：从「我的投递」或首页简报手动点进来时用 */
export async function POST(req: Request, { params }: Ctx) {
  const { appId } = await params;
  const b = (await req.json().catch(() => ({}))) as { round?: string; jd?: string };
  const d = await readTracker();
  const app = d.applications.find((a) => a.id === appId);
  if (!app) return Response.json({ error: "投递记录不存在" }, { status: 404 });
  // 最近一封面试类邮件（有的话带上时间和链接）
  const mail = d.mails
    .filter((m) => m.applicationId === app.id && m.status === "已应用" && INTERVIEW_KINDS.includes(m.kind as (typeof INTERVIEW_KINDS)[number]))
    .sort((x, y) => y.date.localeCompare(x.date))[0];
  const round = INTERVIEW_KINDS.find((k) => k === b.round);
  // 你贴的真实 JD：记在这场准备对应的岗位上（手动的不会被自动搜索覆盖）
  if (b.jd?.trim()) {
    const prep = await readPrep(appId);
    if (prep) await setManualJd(prep.jobId, b.jd);
  }
  void startPrep(app, { mail, round }).catch((e) => console.error("[prep]", e));
  return Response.json({ ok: true });
}
