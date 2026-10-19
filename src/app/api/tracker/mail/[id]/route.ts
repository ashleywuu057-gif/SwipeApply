import { applyMail } from "@/lib/mail-apply";
import { INTERVIEW_KINDS, startPrep } from "@/lib/prep";
import { updateTracker } from "@/lib/tracker-store";
import type { MailKind } from "@/lib/tracker-types";

type Ctx = { params: Promise<{ id: string }> };

type Body = {
  action: "apply" | "ignore" | "restore";
  applicationId?: string; // 应用到哪条投递；"new" = 新建一条
  kind?: MailKind;
  company?: string;
  scheduledAt?: string;
};

/** 确认一封邮件：写进对应投递的时间线，并推进状态；或忽略 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const b = (await req.json()) as Body;
  const result = await updateTracker((d) => {
    const m = d.mails.find((x) => x.id === id);
    if (!m) return { error: "未找到邮件" };
    if (b.action === "ignore") {
      m.status = "已忽略";
      return { mail: m };
    }
    if (b.action === "restore") {
      m.status = "待确认";
      return { mail: m };
    }
    // 允许确认前修改识别结果
    if (b.kind) m.kind = b.kind;
    if (b.company !== undefined) m.company = b.company;
    if (b.scheduledAt !== undefined) m.scheduledAt = b.scheduledAt || undefined;
    const r = applyMail(d, m, b.applicationId);
    if ("error" in r) return r;
    return { mail: m, application: r.application };
  });
  if ("error" in result) return Response.json(result, { status: 400 });
  // 确认的是面试邮件：后台准备面试材料，不等它，确认马上返回
  if (b.action === "apply" && "application" in result && result.application && INTERVIEW_KINDS.includes(result.mail.kind as (typeof INTERVIEW_KINDS)[number]))
    void startPrep(result.application, { mail: result.mail }).catch((e) => console.error("[prep]", e));
  return Response.json(result);
}
