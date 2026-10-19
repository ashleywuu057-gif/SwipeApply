import { applyMail } from "@/lib/mail-apply";
import { INTERVIEW_KINDS, startPrep } from "@/lib/prep";
import { updateTracker } from "@/lib/tracker-store";
import type { Application, MailItem } from "@/lib/tracker-types";

/**
 * 批量确认：把今天收到（按本机日期）的待确认邮件，按识别结果全部确认。
 * 识别不出类型或公司的会跳过，留给你手动处理。
 */
export async function POST() {
  const today = new Date().toDateString();
  const interviews: { app: Application; mail: MailItem }[] = [];
  const result = await updateTracker((d) => {
    let done = 0;
    const skipped: string[] = [];
    for (const m of d.mails) {
      if (m.status !== "待确认" || new Date(m.date).toDateString() !== today) continue;
      const r = applyMail(d, m);
      if ("error" in r) skipped.push(`${m.subject}（${r.error}）`);
      else {
        done++;
        if (INTERVIEW_KINDS.includes(m.kind as (typeof INTERVIEW_KINDS)[number])) interviews.push({ app: r.application, mail: m });
      }
    }
    return { done, skipped };
  });
  // 面试邮件：后台准备面试材料（首页简报里能看到进度）
  for (const x of interviews) void startPrep(x.app, { mail: x.mail }).catch((e) => console.error("[prep]", e));
  return Response.json(result);
}
