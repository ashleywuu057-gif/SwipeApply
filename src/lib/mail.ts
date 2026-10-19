import "server-only";
import { isRecruiting } from "./tracker-logic";

/**
 * 通过 IMAP 读取邮箱（在本机直连邮箱服务器，不经过任何第三方）。
 * 账号和授权码写在 .env.local 里，不存进 data 文件夹。
 * 先只取发件人和标题，判断是招聘邮件才下载正文。
 */
export const MAIL_PRESETS: Record<string, string> = {
  "163.com": "imap.163.com",
  "126.com": "imap.126.com",
  "yeah.net": "imap.yeah.net",
  "qq.com": "imap.qq.com",
  "foxmail.com": "imap.qq.com",
  "gmail.com": "imap.gmail.com",
  "outlook.com": "outlook.office365.com",
  "hotmail.com": "outlook.office365.com",
};

export function mailConfig() {
  const user = process.env.MAIL_USER?.trim() ?? "";
  const pass = process.env.MAIL_PASS?.trim() ?? "";
  const domain = user.split("@")[1]?.toLowerCase() ?? "";
  const host = process.env.MAIL_IMAP_HOST?.trim() || MAIL_PRESETS[domain] || "";
  const port = Number(process.env.MAIL_IMAP_PORT || 993);
  const secure = process.env.MAIL_IMAP_SECURE !== "false";
  return { enabled: Boolean(user && pass && host), user, pass, host, port, secure };
}

export interface RawMail {
  uid: number;
  messageId: string;
  from: string;
  subject: string;
  date: string;
  text: string;
}

const MAX_BODIES = 200;

export async function fetchRecruitingMails(opts: { sinceUid?: number; sinceDays: number }): Promise<{ mails: RawMail[]; maxUid: number; scanned: number }> {
  const cfg = mailConfig();
  if (!cfg.enabled) throw new Error("还没有配置邮箱，见 README 里的「邮箱同步」");
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    clientInfo: { name: "jobprep", version: "0.1.0" }, // 网易邮箱要求客户端先表明身份
  });

  const mails: RawMail[] = [];
  let maxUid = opts.sinceUid ?? 0;
  let scanned = 0;
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const since = new Date(Date.now() - opts.sinceDays * 86400000);
    const query = opts.sinceUid ? { uid: `${opts.sinceUid + 1}:*` } : { since };
    const uids = ((await client.search(query, { uid: true })) || []).filter((u) => !opts.sinceUid || u > opts.sinceUid);

    // 1. 只看发件人和标题
    const candidates: number[] = [];
    if (uids.length) {
      for await (const msg of client.fetch(uids.join(","), { envelope: true, uid: true }, { uid: true })) {
        scanned++;
        maxUid = Math.max(maxUid, msg.uid);
        const env = msg.envelope;
        const from = env?.from?.[0] ? `${env.from[0].name ?? ""} <${env.from[0].address ?? ""}>` : "";
        if (isRecruiting(from, env?.subject ?? "", "")) candidates.push(msg.uid);
      }
    }

    // 2. 是招聘邮件的才下载正文
    const take = candidates.slice(-MAX_BODIES);
    if (take.length) {
      for await (const msg of client.fetch(take.join(","), { source: true, uid: true }, { uid: true })) {
        if (!msg.source) continue;
        const p = await simpleParser(msg.source);
        const text = (p.text || (typeof p.html === "string" ? htmlText(p.html) : "")).slice(0, 8000);
        mails.push({
          uid: msg.uid,
          messageId: p.messageId ?? `uid-${msg.uid}`,
          from: p.from?.text ?? "",
          subject: p.subject ?? "",
          date: (p.date ?? new Date()).toISOString(),
          text,
        });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }
  return { mails, maxUid, scanned };
}

function htmlText(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>/gi, " $1 ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n");
}
