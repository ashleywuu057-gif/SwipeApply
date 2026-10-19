import { newId } from "@/lib/store";
import { directionsOf, isOverseas, parseDeadline } from "@/lib/tracker-logic";
import { mergeJobs, rowsToJobs, tablesFrom, type Row } from "@/lib/job-import";
import { updateTracker } from "@/lib/tracker-store";
import type { JobPosting } from "@/lib/tracker-types";

/**
 * 导入共享的秋招表格（CSV / Excel，飞书、腾讯文档都可以导出），或手动添加一条岗位。
 * 重复的岗位（公司 + 岗位 + 链接相同）不会重复导入。
 */
export async function POST(req: Request) {
  const type = req.headers.get("content-type") ?? "";
  let incoming: JobPosting[] = [];
  const errors: string[] = [];

  if (type.includes("multipart/form-data")) {
    const form = await req.formData();
    for (const f of form.getAll("files").filter((x): x is File => x instanceof File)) {
      const buf = Buffer.from(await f.arrayBuffer());
      const ext = f.name.toLowerCase().split(".").pop();
      try {
        if (!["csv", "xlsx"].includes(ext ?? "")) throw new Error("只支持 .csv 和 .xlsx");
        const sheets: Row[][] = await tablesFrom(f.name, buf);
        let got = 0;
        for (const rows of sheets) {
          const r = rowsToJobs(rows, f.name);
          got += r.jobs.length;
          incoming.push(...r.jobs);
          if (r.error && sheets.length === 1) errors.push(`${f.name}：${r.error}`);
        }
        if (!got && sheets.length > 1) errors.push(`${f.name}：所有工作表都没找到表头`);
      } catch (e) {
        errors.push(`${f.name}：${(e as Error).message}`);
      }
    }
  } else {
    const b = (await req.json()) as Partial<JobPosting>;
    if (!b.company?.trim()) return Response.json({ error: "请填写公司" }, { status: 400 });
    const title = b.title?.trim() || "（未写岗位）";
    incoming = [
      {
        id: newId(),
        company: b.company.trim(),
        title,
        location: b.location?.trim() ?? "",
        deadline: b.deadline?.trim() ?? "",
        deadlineAt: b.deadline ? parseDeadline(b.deadline) : undefined,
        link: b.link?.trim() || b.jdUrl?.trim() || "",
        ...(b.jdUrl?.trim() ? { jdUrl: b.jdUrl.trim() } : {}),
        batch: b.batch?.trim() ?? "",
        industry: b.industry?.trim() ?? "",
        note: b.note?.trim() ?? "",
        directions: directionsOf(title, b.note ?? ""),
        overseas: isOverseas(title, b.note ?? "", b.location ?? ""),
        source: "手动",
        starred: false,
        createdAt: new Date().toISOString(),
      },
    ];
  }

  const result = await updateTracker((d) => mergeJobs(d.jobs, incoming));
  return Response.json({ ...result, errors });
}
