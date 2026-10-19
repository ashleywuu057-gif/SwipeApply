import { upcomingDeadlines } from "@/lib/tracker-logic";
import { readTracker } from "@/lib/tracker-store";

/** 导出日历（.ics）：还没到的测评 / 笔试 / 面试，以及还没投递的网申截止；可导入手机日历、Outlook、飞书日历 */
export async function GET() {
  const d = await readTracker();
  const now = new Date();
  const stamp = fmt(now);
  const events = d.applications.flatMap((a) =>
    a.events
      .filter((e) => e.scheduledAt && new Date(e.scheduledAt) >= new Date(now.getTime() - 86400000))
      .map((e) => {
        const start = new Date(e.scheduledAt!);
        const end = new Date(start.getTime() + (e.kind === "笔试" ? 120 : 60) * 60000);
        return [
          "BEGIN:VEVENT",
          `UID:${e.id}@jobprep`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${fmtLocal(start)}`,
          `DTEND:${fmtLocal(end)}`,
          `SUMMARY:${esc(`${a.company} ${e.kind}${a.title ? `（${a.title}）` : ""}`)}`,
          e.link ? `URL:${esc(e.link)}` : "",
          `DESCRIPTION:${esc(`${e.title}${e.link ? `\n${e.link}` : ""}`)}`,
          "BEGIN:VALARM",
          "TRIGGER:-PT30M",
          "ACTION:DISPLAY",
          `DESCRIPTION:${esc(`${a.company} ${e.kind} 30 分钟后开始`)}`,
          "END:VALARM",
          "END:VEVENT",
        ]
          .filter(Boolean)
          .join("\r\n");
      }),
  );
  // 还没投递的网申截止（全天事件，截止前一天提醒）
  const ddls = upcomingDeadlines(d.jobs, d.applications, d.settings.myDirections, now).map(({ job }) => {
    const day = job.deadlineAt!.replace(/-/g, "");
    const next = new Date(new Date(job.deadlineAt!).getTime() + 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    return [
      "BEGIN:VEVENT",
      `UID:ddl-${job.id}@jobprep`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day}`,
      `DTEND;VALUE=DATE:${next}`,
      `SUMMARY:${esc(`【网申截止】${job.company} ${job.title}`)}`,
      job.link ? `URL:${esc(job.link)}` : "",
      "BEGIN:VALARM",
      "TRIGGER:-PT15H",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(`${job.company} 网申明天截止`)}`,
      "END:VALARM",
      "END:VEVENT",
    ]
      .filter(Boolean)
      .join("\r\n");
  });
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//jobprep//CN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:求职日程", ...events, ...ddls, "END:VCALENDAR"].join("\r\n");
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="jobprep.ics"',
    },
  });
}

const p = (n: number) => String(n).padStart(2, "0");
/** 用本地时间（不带 Z），日历软件按手机/电脑所在时区显示 */
function fmtLocal(d: Date) {
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
}
function fmt(d: Date) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function esc(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
