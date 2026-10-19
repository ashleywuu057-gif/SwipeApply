import { POST as submitJob } from "@/app/api/native/apply/[jobId]/submit/route";
import { matchJob } from "@/lib/applykit";
import { findByCompany } from "@/lib/mail-apply";
import { newId } from "@/lib/store";
import { snapshotOf } from "@/lib/tracker-logic";
import { readTracker, updateTracker } from "@/lib/tracker-store";

/**
 * 你在「投简助手」里确认「已在官网提交」后，插件通知这里：记进我的投递，算一次有效投递。
 * 对得上岗位库里的岗位，就和投递工作台里点「已提交」一样处理；对不上的按公司记一条。
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { company?: string; role?: string; sourceUrl?: string | null; canonicalUrl?: string | null };
  // 真实网申页不可能在本机：来自 127.0.0.1 / localhost 的是插件演示页或自动化测试，不记进「我的投递」
  if ([b.sourceUrl, b.canonicalUrl].some((u) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(u ?? "")))
    return Response.json({ ok: false, ignored: "本机演示页的提交不记录" });
  const d = await readTracker();
  const job = matchJob(b.canonicalUrl, d.jobs) ?? matchJob(b.sourceUrl, d.jobs);
  if (job) {
    await submitJob(new Request("http://localhost/"), { params: Promise.resolve({ jobId: job.id }) });
    return Response.json({ ok: true, matched: { id: job.id, company: job.company, title: job.title } });
  }
  const company = b.company?.trim();
  if (!company) return Response.json({ error: "没有公司名，也对不上岗位库里的岗位" }, { status: 400 });
  const now = new Date().toISOString();
  const role = b.role?.trim() ?? "";
  await updateTracker((t) => {
    let app = findByCompany(t.applications, company);
    if (!app) {
      app = { id: newId(), company, title: role, link: b.sourceUrl ?? "", stage: "已投递", appliedAt: now, events: [], notes: "", updatedAt: now };
      app.snapshot = snapshotOf(app, undefined, "插件");
      t.applications.push(app);
    } else if (role && !app.title.split(" / ").includes(role)) app.title = app.title ? `${app.title} / ${role}` : role;
    app.events.push({ id: newId(), date: now, kind: "投递确认", title: `投简助手：已在官网提交${role ? ` ${role}` : ""}`, source: "手动" });
    app.updatedAt = now;
  });
  return Response.json({ ok: true, matched: null });
}
