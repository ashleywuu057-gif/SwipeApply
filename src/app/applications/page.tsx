"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Application, EventKind, JobPosting, MailItem, MailKind, Stage } from "@/lib/tracker-types";
import type { Agenda } from "@/lib/agenda";
import { progressStats } from "@/lib/tracker-logic";
import { STAGES } from "@/lib/tracker-types";
import FunnelSankey from "@/components/FunnelSankey";

type Data = {
  applications: Application[];
  mails: MailItem[];
  jobs: JobPosting[];
  settings: { lastSyncAt?: string; myDirections: string[] };
  mailConfig: { enabled: boolean; user: string; host: string };
  llmEnabled: boolean;
};

const EVENT_KINDS: EventKind[] = ["测评", "笔试", "AI面", "面试", "HR面", "Offer", "未通过", "备注"];
const MAIL_KINDS: MailKind[] = ["投递确认", "测评", "笔试", "AI面", "面试", "HR面", "Offer", "未通过", "其他"];
const JSONH = { "Content-Type": "application/json" };

export default function ApplicationsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [useLLM, setUseLLM] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [newApp, setNewApp] = useState({ company: "", title: "", link: "" });
  const [now] = useState(() => Date.now());

  const [agenda, setAgenda] = useState<Agenda | null>(null);

  const load = useCallback(() => {
    fetch("/api/tracker")
      .then((r) => r.json())
      .then(setData);
    // 未来 30 天日程和待跟进：和首页简报共用 /api/agenda，两边保证一致
    fetch("/api/agenda")
      .then((r) => r.json())
      .then(setAgenda);
  }, []);
  useEffect(load, [load]);

  const upcoming = agenda?.items ?? [];

  /** 打勾划掉 / 取消（先在页面上改掉，接口返回后用最新的日程覆盖） */
  async function markDone(key: string, done: boolean) {
    setAgenda((a) => (a ? { ...a, items: a.items.map((i) => (i.key === key ? { ...i, done } : i)), followUps: a.followUps.filter((f) => `follow-${f.appId}` !== key) } : a));
    const r = await fetch("/api/agenda", { method: "POST", headers: JSONH, body: JSON.stringify({ key, done }) });
    if (r.ok) setAgenda(await r.json());
  }

  if (!data) return <p className="text-sm text-slate-500">加载中…</p>;
  const apps = data.applications;
  const pending = data.mails.filter((m) => m.status === "待确认");
  const todayStr = new Date(now).toDateString();
  const pendingToday = pending.filter((m) => new Date(m.date).toDateString() === todayStr);
  const done = data.mails.filter((m) => m.status !== "待确认" && m.kind !== "其他");
  const open = apps.find((a) => a.id === openId) ?? null;

  async function confirmToday() {
    const d = await (await fetch("/api/tracker/mail/bulk", { method: "POST" })).json();
    setSyncMsg(`已确认 ${d.done} 封${d.skipped.length ? `；${d.skipped.length} 封需要手动处理：${d.skipped.join("；")}` : ""}`);
    load();
  }

  async function sync() {
    setSyncing(true);
    setSyncMsg("正在读取邮箱…");
    const r = await fetch("/api/tracker/mail/sync", { method: "POST", headers: JSONH, body: JSON.stringify({ useLLM, days: 30 }) });
    const d = await r.json();
    setSyncMsg(r.ok ? `检查了 ${d.scanned} 封新邮件，其中招聘相关 ${d.recruiting} 封，新增 ${d.added} 封待处理` : d.error);
    setSyncing(false);
    load();
  }

  async function createApp() {
    const r = await fetch("/api/tracker/apps", { method: "POST", headers: JSONH, body: JSON.stringify(newApp) });
    if (r.ok) {
      setNewApp({ company: "", title: "", link: "" });
      setShowNew(false);
      load();
    }
  }

  return (
    // 宽屏下整页固定一屏：日程、邮件、漏斗各自在框内滚动
    <div className="mx-auto flex max-w-7xl flex-col lg:h-full">
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">我的投递</h1>
          <p className="mt-1 text-sm text-slate-500">
            {apps.length} 条投递 · {apps.filter((a) => ["测评", "笔试", "AI面", "面试", "HR面"].includes(a.stage)).length} 条进行中 ·{" "}
            {apps.filter((a) => a.stage === "Offer").length} 个 Offer
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/jobs" className="btn-ghost">
            去岗位库
          </Link>
          <button className="btn-primary" onClick={() => setShowNew(!showNew)}>
            手动新建投递
          </button>
        </div>
      </header>

      {showNew && (
        <div className="panel mt-4 grid shrink-0 gap-2 p-4 sm:grid-cols-[1fr_1fr_1.5fr_auto]">
          <input className="input" placeholder="公司 *" value={newApp.company} onChange={(e) => setNewApp({ ...newApp, company: e.target.value })} />
          <input className="input" placeholder="岗位" value={newApp.title} onChange={(e) => setNewApp({ ...newApp, title: e.target.value })} />
          <input className="input" placeholder="投递链接" value={newApp.link} onChange={(e) => setNewApp({ ...newApp, link: e.target.value })} />
          <button className="btn-primary" onClick={createApp}>
            新建
          </button>
        </div>
      )}

      <div className="mt-5 grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-2">
        {/* 近期日程 */}
        <section className="panel flex flex-col p-4 lg:min-h-0">
          <div className="flex shrink-0 items-center justify-between">
            <h2 className="font-medium">未来 30 天日程</h2>
            <a href="/api/tracker/ics" className="text-sm text-accent hover:underline">
              导出到日历 (.ics)
            </a>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
          {upcoming.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">暂无。确认邮件、手动添加带时间的事件，或岗位库里有明确截止日期的岗位后会出现在这里。</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {upcoming.map((u) => (
                <li key={u.key} id={u.key} className={`flex items-center gap-3 rounded text-sm ${u.done ? "opacity-50" : u.urgent ? "bg-red-50/60 -mx-1 px-1" : ""}`}>
                  <input
                    type="checkbox"
                    className="shrink-0 accent-accent"
                    checked={Boolean(u.done)}
                    onChange={(e) => markDone(u.key, e.target.checked)}
                    title={u.done ? "取消打勾" : u.kind === "网申截止" ? "已处理（投了或决定不投）" : "完成了，划掉"}
                  />
                  <span className={`w-28 shrink-0 font-mono text-xs text-slate-500 ${u.done ? "line-through" : ""}`}>{u.kind === "网申截止" ? fmtDay(u.at) : fmtTime(u.at)}</span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${u.kind === "网申截止" ? "bg-red-50 text-red-700" : "bg-accent-soft text-accent"}`}>{u.kind}</span>
                  {u.appId ? (
                    <button className={`min-w-0 flex-1 truncate text-left hover:text-accent ${u.done ? "line-through" : ""}`} onClick={() => setOpenId(u.appId!)}>
                      {u.company} {u.title && <span className="text-slate-500">· {u.title}</span>}
                    </button>
                  ) : (
                    <Link href={u.jobId ? `/apply/${u.jobId}` : "/jobs"} className={`min-w-0 flex-1 truncate hover:text-accent ${u.done ? "line-through" : ""}`} title="打开投递工作台">
                      {u.company} {u.title && <span className="text-slate-500">· {u.title}</span>}
                    </Link>
                  )}
                  {u.urgent && !u.done && <span className="shrink-0 text-[11px] font-medium text-red-600">24 小时内</span>}
                  {u.saved && <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">稍后再看</span>}
                  {u.prep && u.appId && (
                    <Link href={`/prep/${u.appId}`} className="shrink-0 text-xs text-accent hover:underline">
                      {u.prep === "ready" ? (u.practiced ? "再练一遍" : "准备好了 · 去练") : u.prep === "preparing" ? "准备中…" : "准备面试"}
                    </Link>
                  )}
                  {u.link && (
                    <a href={u.link} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-accent">
                      链接 ↗
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* 待跟进：没有具体时间，不混进按日期排的日程 */}
          {agenda && agenda.followUps.length > 0 && (
            <div id="follow-ups" className="mt-5 border-t border-slate-100 pt-3">
              <h3 className="text-sm font-medium">
                待跟进 <span className="text-xs font-normal text-slate-500">· 投递后两周以上没有新进展，一般这时已经有结果了，可以去官网查一下状态</span>
              </h3>
              <ul className="mt-2 space-y-1.5">
                {agenda.followUps.map((f) => (
                  <li key={f.appId} className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0 text-xs text-slate-500">{f.days} 天没动静</span>
                    <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{f.stage}</span>
                    <button className="min-w-0 flex-1 truncate text-left hover:text-accent" onClick={() => setOpenId(f.appId)}>
                      {f.company} {f.title && <span className="text-slate-500">· {f.title}</span>}
                    </button>
                    <button className="shrink-0 text-xs text-slate-500 hover:text-accent" onClick={() => markDone(`follow-${f.appId}`, true)} title="14 天内不再提醒；到时还没进展会再出现">
                      查过了
                    </button>
                  </li>
                ))}
              </ul>
              {agenda.undated > 0 && <p className="mt-2 text-xs text-slate-400">另有 {agenda.undated} 条进行中的投递没有任何日期（例如从表格导入的），判断不了要不要跟进。</p>}
            </div>
          )}
          </div>
        </section>

        {/* 邮件 */}
        <section className="panel flex flex-col p-4 lg:min-h-0">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium">
              招聘邮件 {pending.length > 0 && <span className="ml-1 rounded-full bg-red-500 px-1.5 text-xs text-white">{pending.length}</span>}
            </h2>
            {data.mailConfig.enabled && (
              <div className="flex items-center gap-3 text-sm">
                {data.llmEnabled && (
                  <label className="flex items-center gap-1 text-xs text-slate-600" title="规则识别不出类型、公司或时间的邮件，脱敏后发给模型补充识别">
                    <input type="checkbox" checked={useLLM} onChange={(e) => setUseLLM(e.target.checked)} />
                    用模型补充识别
                  </label>
                )}
                {pendingToday.length > 0 && (
                  <button className="btn-ghost py-1.5" onClick={confirmToday} title="按识别结果确认今天收到的邮件；识别不出类型或公司的会留下手动处理">
                    确认今天的 {pendingToday.length} 封
                  </button>
                )}
                <button className="btn-primary py-1.5" disabled={syncing} onClick={sync}>
                  {syncing ? "同步中…" : "同步邮件"}
                </button>
              </div>
            )}
          </div>
          {!data.mailConfig.enabled ? (
            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-600">
              还没有连接邮箱。在项目的 <code className="rounded bg-white px-1">.env.local</code> 里加上：
              <pre className="mt-1 rounded bg-white p-2 text-xs">{"MAIL_USER=你的邮箱@163.com\nMAIL_PASS=邮箱授权码（不是登录密码）"}</pre>
              然后重启项目。163、126、QQ、Gmail、Outlook 会自动识别服务器；网易邮箱的授权码在「设置 → POP3/SMTP/IMAP」里开启 IMAP 后获取。
              <br />
              邮件在你电脑上直接从邮箱读取，只保存招聘邮件的标题和摘要。
            </div>
          ) : (
            <>
              <p className="mt-1 shrink-0 text-xs text-slate-500">
                {data.mailConfig.user}
                {data.settings.lastSyncAt && ` · 上次同步 ${fmtTime(data.settings.lastSyncAt)}`}
              </p>
              {syncMsg && <p className="mt-2 shrink-0 text-xs text-accent">{syncMsg}</p>}
              <div className="mt-3 max-h-[28rem] min-h-0 flex-1 space-y-2 overflow-auto lg:max-h-none">
                {pending.map((m) => (
                  <MailRow key={m.id} mail={m} apps={apps} onDone={load} />
                ))}
                {pending.length === 0 && <p className="text-sm text-slate-500">没有待处理的邮件</p>}
              {done.length > 0 && (
                <button className="mt-2 text-xs text-slate-500 hover:text-accent" onClick={() => setShowDone(!showDone)}>
                  {showDone ? "收起" : `查看已处理的 ${done.length} 封`}
                </button>
              )}
              {showDone && (
                <ul className="mt-2 space-y-1 text-xs text-slate-500">
                  {done.map((m) => (
                    <li key={m.id} className="flex items-center gap-2">
                      <span className="w-12 shrink-0">{m.status}</span>
                      <span className="min-w-0 flex-1 truncate">{m.subject}</span>
                      <button
                        className="shrink-0 hover:text-accent"
                        onClick={async () => {
                          await fetch(`/api/tracker/mail/${m.id}`, { method: "POST", headers: JSONH, body: JSON.stringify({ action: "restore" }) });
                          load();
                        }}
                      >
                        重新处理
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              </div>
            </>
          )}
        </section>
      </div>

      {/* 投递漏斗（桑基图）：替代原来的看板列表 */}
      <section className="panel mt-4 flex h-72 shrink-0 flex-col p-4">
        <div className="flex shrink-0 items-center justify-between">
          <h2 className="font-medium">投递漏斗</h2>
          <button className="text-sm text-slate-500 hover:text-accent" onClick={() => setShowStats(true)}>
            哪类岗位推进得好
          </button>
        </div>
        <div className="mt-2 min-h-0 flex-1">{apps.length ? <FunnelSankey apps={apps} onOpen={setOpenId} /> : <p className="text-sm text-slate-500">还没有投递记录。</p>}</div>
      </section>

      {showStats && <ProgressPanel apps={apps} onClose={() => setShowStats(false)} />}

      {open && <Drawer key={open.id} app={open} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

/* ---------------- 哪类岗位推进得好 ---------------- */

function ProgressPanel({ apps, onClose }: { apps: Application[]; onClose: () => void }) {
  const s = useMemo(() => progressStats(apps), [apps]);
  if (!s.total) return null;
  const table = (title: string, rows: { key: string; n: number; advanced: number }[]) => (
    <div>
      <h3 className="text-sm font-medium text-slate-600">{title}</h3>
      <ul className="mt-2 space-y-1.5">
        {rows.map((r) => {
          const pct = Math.round((100 * r.advanced) / r.n);
          return (
            <li key={r.key} className="grid grid-cols-[5.5rem_1fr_6.5rem] items-center gap-2 text-sm">
              <span className="truncate">{r.key}</span>
              <span className="h-2 overflow-hidden rounded-full bg-slate-100">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%`, opacity: r.n < 5 ? 0.35 : 1 }} />
              </span>
              <span className="text-right text-xs text-slate-500">
                {r.advanced}/{r.n}
                {r.n < 5 ? " · 样本太少" : ` · ${pct}%`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20 p-4" onClick={onClose}>
    <div className="panel max-h-[85vh] w-full max-w-3xl overflow-y-auto bg-white p-5" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-start justify-between gap-3">
        <div className="font-medium">
          哪类岗位推进得好
          <span className="ml-2 text-sm font-normal text-slate-500">
            {s.total} 条投递里 {s.advanced} 条进入了测评或更后面的阶段
          </span>
        </div>
        <button className="text-sm text-slate-400 hover:text-slate-700" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        {table("按方向", s.byDirection)}
        {table("按行业", s.bySector)}
      </div>
      <p className="mt-4 text-xs text-slate-500">
        一个岗位可能同时属于几个方向或行业，所以各行加起来会多于总数。{" "}
        <a href="/api/tracker/dataset" className="text-accent hover:underline">
          导出全部数据（CSV）
        </a>
        ：投递记录和岗位流里的跳过、收藏都在里面，以后训练排序模型用。
      </p>
    </div>
    </div>
  );
}

/* ---------------- 一封待确认的邮件 ---------------- */

function MailRow({ mail, apps, onDone }: { mail: MailItem; apps: Application[]; onDone: () => void }) {
  const [kind, setKind] = useState<MailKind>(mail.kind);
  const [company, setCompany] = useState(mail.company);
  const [time, setTime] = useState(mail.scheduledAt ?? "");
  const [target, setTarget] = useState(mail.applicationId ?? (mail.company ? "new" : ""));
  const [err, setErr] = useState("");

  async function act(action: "apply" | "ignore") {
    const r = await fetch(`/api/tracker/mail/${mail.id}`, {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ action, kind, company, scheduledAt: time, applicationId: target }),
    });
    if (!r.ok) return setErr((await r.json()).error);
    onDone();
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{mail.subject}</div>
          <div className="truncate text-xs text-slate-400">
            {fmtTime(mail.date)} · {mail.from} · 识别：{mail.by}
          </div>
        </div>
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-slate-500">{mail.snippet}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select className="rounded-md border border-slate-300 px-1.5 py-1 text-xs" value={kind} onChange={(e) => setKind(e.target.value as MailKind)}>
          {MAIL_KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <input className="w-24 rounded-md border border-slate-300 px-1.5 py-1 text-xs" placeholder="公司" value={company} onChange={(e) => setCompany(e.target.value)} />
        <input type="datetime-local" className="rounded-md border border-slate-300 px-1.5 py-1 text-xs" value={time} onChange={(e) => setTime(e.target.value)} />
        <select className="max-w-44 rounded-md border border-slate-300 px-1.5 py-1 text-xs" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">选择对应的投递…</option>
          {apps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.company}
              {a.title ? ` · ${a.title}` : ""}
            </option>
          ))}
          <option value="new">＋ 新建投递记录</option>
        </select>
        {mail.link && (
          <a href={mail.link} target="_blank" rel="noreferrer" className="text-xs text-accent">
            链接 ↗
          </a>
        )}
        <span className="ml-auto flex gap-2">
          <button className="text-xs text-slate-400 hover:text-slate-700" onClick={() => act("ignore")}>
            忽略
          </button>
          <button className="rounded-md bg-accent px-2.5 py-1 text-xs text-white" onClick={() => act("apply")}>
            确认
          </button>
        </span>
      </div>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  );
}

/* ---------------- 投递详情侧栏 ---------------- */

function Drawer({ app, onClose, onChanged }: { app: Application; onClose: () => void; onChanged: () => void }) {
  const [notes, setNotes] = useState(app.notes);
  const [ev, setEv] = useState<{ kind: EventKind; title: string; scheduledAt: string; link: string }>({ kind: "面试", title: "", scheduledAt: "", link: "" });

  async function patch(body: object) {
    await fetch(`/api/tracker/apps/${app.id}`, { method: "PATCH", headers: JSONH, body: JSON.stringify(body) });
    onChanged();
  }

  async function remove() {
    if (!confirm(`删除「${app.company}」这条投递记录？`)) return;
    await fetch(`/api/tracker/apps/${app.id}`, { method: "DELETE" });
    onClose();
    onChanged();
  }

  const events = [...app.events].sort((a, b) => (b.scheduledAt ?? b.date).localeCompare(a.scheduledAt ?? a.date));

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/20" onClick={onClose}>
      <aside className="h-full w-full max-w-md overflow-auto bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{app.company}</h2>
            <p className="text-sm text-slate-500">
              {app.title || "（未填岗位）"}
              {app.appliedAt && ` · 投递于 ${fmtDate(app.appliedAt)}`}
            </p>
            {app.link && (
              <a href={app.link} target="_blank" rel="noreferrer" className="text-xs text-accent">
                投递链接 ↗
              </a>
            )}
          </div>
          <button className="text-xl leading-none text-slate-400 hover:text-slate-700" onClick={onClose}>
            ×
          </button>
        </div>

        <Link href={`/prep/${app.id}`} className="btn-primary mt-4 w-full">
          准备面试 · 模拟面试
        </Link>

        <label className="label mt-5">当前状态</label>
        <div className="flex flex-wrap gap-1.5">
          {STAGES.map((s: Stage) => (
            <button
              key={s}
              onClick={() => patch({ stage: s })}
              className={`rounded-full px-2.5 py-1 text-xs ${app.stage === s ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
            >
              {s}
            </button>
          ))}
        </div>

        <label className="label mt-5">时间线</label>
        <ul className="space-y-2">
          {events.map((e) => (
            <li key={e.id} className="group rounded-lg border border-slate-200 p-2.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="rounded bg-accent-soft px-1.5 py-0.5 text-xs text-accent">{e.kind}</span>
                <span className="text-xs text-slate-400">{e.source}</span>
                <span className="ml-auto text-xs text-slate-400">{fmtDate(e.date)}</span>
                <button className="hidden text-xs text-slate-300 hover:text-red-600 group-hover:inline" onClick={() => patch({ removeEventId: e.id })}>
                  删除
                </button>
              </div>
              <div className="mt-1">{e.title}</div>
              {e.scheduledAt && <div className="mt-0.5 text-xs text-amber-700">时间：{fmtTime(e.scheduledAt)}</div>}
              {e.link && (
                <a href={e.link} target="_blank" rel="noreferrer" className="mt-0.5 block truncate text-xs text-accent">
                  {e.link}
                </a>
              )}
            </li>
          ))}
        </ul>

        <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3">
          <div className="text-xs font-medium text-slate-500">手动添加事件</div>
          <div className="flex gap-2">
            <select className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-sm" value={ev.kind} onChange={(e) => setEv({ ...ev, kind: e.target.value as EventKind })}>
              {EVENT_KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <input className="input py-1" placeholder="说明，如「业务一面」" value={ev.title} onChange={(e) => setEv({ ...ev, title: e.target.value })} />
          </div>
          <div className="flex gap-2">
            <input type="datetime-local" className="input py-1" value={ev.scheduledAt} onChange={(e) => setEv({ ...ev, scheduledAt: e.target.value })} />
            <input className="input py-1" placeholder="链接（可选）" value={ev.link} onChange={(e) => setEv({ ...ev, link: e.target.value })} />
          </div>
          <button
            className="btn-primary w-full py-1.5"
            onClick={() => {
              patch({ addEvent: { kind: ev.kind, title: ev.title || ev.kind, scheduledAt: ev.scheduledAt || undefined, link: ev.link || undefined } });
              setEv({ kind: "面试", title: "", scheduledAt: "", link: "" });
            }}
          >
            添加
          </button>
        </div>

        <label className="label mt-5">备注</label>
        <textarea
          className="input h-28"
          placeholder="面试官问了什么、自己答得怎么样、下一步要准备什么"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== app.notes && patch({ notes })}
        />

        <button className="mt-6 text-xs text-slate-400 hover:text-red-600" onClick={remove}>
          删除这条投递记录
        </button>
      </aside>
    </div>
  );
}

function fmtTime(s: string) {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const w = "日一二三四五六"[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()} 周${w} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtDate(s: string) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : `${d.getMonth() + 1}/${d.getDate()}`;
}


function fmtDay(s: string) {
  const d = new Date(s);
  return `${d.getMonth() + 1}/${d.getDate()} 周${"日一二三四五六"[d.getDay()]} 截止`;
}
