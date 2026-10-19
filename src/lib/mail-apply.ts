import "server-only";
import { newId } from "./store";
import { nextStage, normCompany, snapshotOf } from "./tracker-logic";
import type { Application, EventKind, MailItem, TrackerData } from "./tracker-types";

/**
 * 确认一封邮件：写进对应投递的时间线并推进状态。
 * target：投递记录 id；"new" = 按邮件里的公司新建一条；不传就用识别出的匹配结果，匹配不到时按公司新建。
 */
export function applyMail(d: TrackerData, m: MailItem, target?: string): { application: Application } | { error: string } {
  if (m.kind === "其他") return { error: "请先选择邮件类型" };

  let app: Application | undefined;
  const id = target === "new" ? undefined : (target ?? m.applicationId);
  if (id) app = d.applications.find((a) => a.id === id);
  if (!app && (target === "new" || target === undefined)) {
    if (!m.company) return { error: "请先填写公司" };
    // 同一家公司只保留一条投递记录
    app = findByCompany(d.applications, m.company);
  }
  if (!app && (target === "new" || target === undefined)) {
    const now = new Date().toISOString();
    app = { id: newId(), company: m.company, title: "", link: "", stage: "已投递", appliedAt: m.date, events: [], notes: "", updatedAt: now };
    app.snapshot = snapshotOf(app, undefined, "邮件");
    d.applications.push(app);
  }
  if (!app) return { error: "请选择对应的投递记录" };

  if (!app.events.some((e) => e.mailId === m.id)) {
    app.events.push({
      id: newId(),
      date: m.date,
      kind: m.kind as EventKind,
      title: m.subject,
      scheduledAt: m.scheduledAt,
      link: m.link,
      source: "邮件",
      mailId: m.id,
    });
  }
  app.stage = nextStage(app.stage, m.kind as EventKind);
  app.updatedAt = new Date().toISOString();
  m.applicationId = app.id;
  m.status = "已应用";
  return { application: app };
}

export function findByCompany(apps: Application[], company: string) {
  const c = normCompany(company);
  if (c.length < 2) return undefined;
  return apps.find((a) => normCompany(a.company) === c);
}

const RANK: Record<string, number> = { 已投递: 1, 测评: 2, 笔试: 3, AI面: 4, 面试: 5, HR面: 6, Offer: 7 };

/**
 * 同一家公司的多条投递合并成一条：时间线合并，岗位名拼在一起，状态取进度最靠前的
 * （有 Offer 取 Offer；还有进行中的就取进行中里最靠后的一步；全部结束才算结束）。
 * 返回是否有改动。
 */
export function mergeDuplicateApps(d: TrackerData): boolean {
  const groups = new Map<string, Application[]>();
  for (const a of d.applications) {
    const k = normCompany(a.company) || a.id;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  let changed = false;
  const kept: Application[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      kept.push(list[0]);
      continue;
    }
    changed = true;
    const [main, ...rest] = [...list].sort((a, b) => a.appliedAt.localeCompare(b.appliedAt));
    for (const r of rest) {
      main.events.push(...r.events.filter((e) => !main.events.some((x) => x.mailId && x.mailId === e.mailId)));
      main.jobIds = [...new Set([...(main.jobIds ?? (main.jobId ? [main.jobId] : [])), ...(r.jobIds ?? []), ...(r.jobId ? [r.jobId] : [])])];
      if (r.title && !main.title.split(" / ").includes(r.title)) main.title = main.title ? `${main.title} / ${r.title}` : r.title;
      if (!main.link) main.link = r.link;
      if (r.notes) main.notes = main.notes ? `${main.notes}\n${r.notes}` : r.notes;
      for (const m of d.mails) if (m.applicationId === r.id) m.applicationId = main.id;
    }
    const stages = list.map((a) => a.stage);
    const active = stages.filter((s) => s in RANK && s !== "Offer");
    main.stage = stages.includes("Offer")
      ? "Offer"
      : active.length
        ? active.sort((a, b) => RANK[b] - RANK[a])[0]
        : list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].stage;
    main.updatedAt = new Date().toISOString();
    kept.push(main);
  }
  if (changed) d.applications = kept;
  return changed;
}
