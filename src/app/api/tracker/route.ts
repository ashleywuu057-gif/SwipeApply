import { llmConfig } from "@/lib/extract";
import { resumeKeywords } from "@/lib/campus-search";
import { searchConfig } from "@/lib/job-search";
import { readLibrary } from "@/lib/store";
import { mailConfig } from "@/lib/mail";
import { applyMail, mergeDuplicateApps } from "@/lib/mail-apply";
import { readTracker, updateTracker } from "@/lib/tracker-store";
import { DIRECTIONS, SECTORS, type Direction, type Sector } from "@/lib/tracker-types";

/** P2 全部数据 + 邮箱、模型的配置状态（不返回密码） */
export async function GET() {
  let d = await readTracker();
  // 整理旧数据：同一家公司的多条投递合并成一条；待确认的"投递成功"邮件直接加进列表
  const pendingReceipts = d.mails.some((m) => m.status === "待确认" && m.kind === "投递确认" && m.company);
  if (pendingReceipts || mergeDuplicateApps(structuredClone(d))) {
    d = await updateTracker((t) => {
      for (const m of t.mails) if (m.status === "待确认" && m.kind === "投递确认" && m.company) applyMail(t, m);
      mergeDuplicateApps(t);
      return t;
    });
  }
  const mail = mailConfig();
  return Response.json({
    ...d,
    mailConfig: { enabled: mail.enabled, user: mail.user, host: mail.host },
    llmEnabled: llmConfig().enabled,
    searchEnabled: searchConfig().enabled,
    resumeKeywords: resumeKeywords((await readLibrary()).cards.map((c) => c.role ?? "")),
  });
}

/** 保存"我的方向""我的行业"（只改传了的那个） */
export async function PUT(req: Request) {
  const { myDirections, mySectors } = (await req.json()) as { myDirections?: Direction[]; mySectors?: Sector[] };
  const settings = await updateTracker((d) => {
    if (myDirections) d.settings.myDirections = myDirections.filter((x) => DIRECTIONS.includes(x));
    if (mySectors) d.settings.mySectors = mySectors.filter((x) => SECTORS.includes(x));
    return d.settings;
  });
  return Response.json({ settings });
}
