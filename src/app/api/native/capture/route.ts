import { normCompany } from "@/lib/tracker-logic";
import { jdFromText, setManualJd } from "@/lib/native/intel";
import { allJobs, findJob } from "@/lib/native/jobs";

/**
 * 剪藏 JD：你在浏览器里打开岗位页，点书签栏的「剪藏 JD」，页面文字带到这里，选好对应的岗位保存。
 * 这样登录后才能看的、动态加载的页面也能拿到。
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const hint = `${u.searchParams.get("title") ?? ""} ${u.searchParams.get("url") ?? ""} ${u.searchParams.get("text")?.slice(0, 3000) ?? ""}`.toLowerCase();
  const { jobs } = await allJobs();
  const scored = jobs
    .map((j) => {
      const c = normCompany(j.company);
      let score = 0;
      if (c.length >= 2 && hint.includes(c)) score += 3;
      if (j.company && hint.includes(j.company.toLowerCase())) score += 3;
      if (j.title && hint.includes(j.title.toLowerCase())) score += 2;
      try {
        if (j.link && hint.includes(new URL(j.link).host)) score += 2;
      } catch {}
      return { id: j.id, label: `${j.company} · ${j.title}`, score };
    })
    .sort((a, b) => b.score - a.score);
  return Response.json({ jobs: scored });
}

export async function POST(req: Request) {
  const b = (await req.json()) as { jobId: string; selected?: string; text?: string; url?: string };
  const job = await findJob(b.jobId);
  if (!job) return Response.json({ error: "岗位不存在" }, { status: 404 });
  // 选中了文字就原样保存；没选就从整页里挑出这个岗位的职责和要求
  let text = (b.selected ?? "").trim();
  if (!text) {
    text = await jdFromText(b.text ?? "", job);
    if (!text) return Response.json({ error: "这一页里没找到这个岗位的职责和要求。可以先用鼠标选中 JD 那段文字，再点一次「剪藏 JD」" }, { status: 400 });
  }
  const jd = await setManualJd(job.id, text, "剪藏", b.url);
  return Response.json({ jd });
}
