import { llmConfig } from "@/lib/extract";
import { fetchRecruitingMails, mailConfig } from "@/lib/mail";
import { applyMail } from "@/lib/mail-apply";
import { processMails } from "@/lib/mail-process";
import { readTracker, updateTracker } from "@/lib/tracker-store";

// 每天自动同步的时间点
const AUTO_TIMES = ["12:00", "15:00", "19:00"];

/**
 * 同步邮件：读取上次同步之后的新邮件（第一次读最近 N 天），
 * 只保留招聘相关邮件的标题、发件人、摘要和识别结果，等你确认后再更新投递进度。
 * auto=true 是后台定时器调用的：到了 AUTO_TIMES 里的时间点、且这个时间点还没跑过才同步，
 * 错过的时间点（比如项目没开）下次打开时补一次。
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { useLLM?: boolean; days?: number; auto?: boolean };
  const { days, auto } = body;
  let { useLLM } = body;

  if (auto) {
    if (!mailConfig().enabled) return Response.json({ skipped: true });
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const due = AUTO_TIMES.filter((t) => {
      const [h, m] = t.split(":").map(Number);
      return minutes >= h * 60 + m;
    }).pop();
    if (!due) return Response.json({ skipped: true });
    const slot = `${localDate(now)} ${due}`;
    // 先记下这个时间点：失败了也不在同一时间点反复重试，避免频繁登录被邮箱限制
    const claimed = await updateTracker((t) => {
      if (t.settings.lastMailAutoSlot === slot) return false;
      t.settings.lastMailAutoSlot = slot;
      return true;
    });
    if (!claimed) return Response.json({ skipped: true });
    useLLM = true;
  }

  const d = await readTracker();
  try {
    const { mails, maxUid, scanned } = await fetchRecruitingMails({
      sinceUid: d.settings.lastSyncUid,
      sinceDays: Math.min(Math.max(days ?? 30, 1), 180),
    });
    const known = [...new Set([...d.applications.map((a) => a.company), ...d.jobs.map((j) => j.company)])];
    const items = await processMails(mails, d.applications, known, Boolean(useLLM && llmConfig().enabled));
    const added = await updateTracker((t) => {
      const seen = new Set(t.mails.map((m) => m.messageId));
      const fresh = items.filter((m) => !seen.has(m.messageId));
      t.mails.unshift(...fresh.sort((a, b) => b.date.localeCompare(a.date)));
      // 投递成功的邮件不用确认，直接加进投递列表（同一家公司只保留一条）
      for (const m of [...fresh].reverse()) if (m.kind === "投递确认" && m.company) applyMail(t, m);
      t.settings.lastSyncUid = Math.max(t.settings.lastSyncUid ?? 0, maxUid);
      t.settings.lastSyncAt = new Date().toISOString();
      return fresh;
    });
    // 新来的面试邮件不再弹通知：首页每日简报里会列出"待确认的面试邮件"
    return Response.json({ scanned, recruiting: mails.length, added: added.length });
  } catch (e) {
    const msg = (e as Error).message;
    const hint = /auth|login|LOGIN|credentials|Invalid/i.test(msg)
      ? "登录失败：请确认 MAIL_PASS 填的是邮箱的「授权码」而不是登录密码，并且已在邮箱设置里开启 IMAP"
      : msg;
    return Response.json({ error: hint }, { status: 400 });
  }
}

function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
