"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sectorsOf } from "@/lib/tracker-logic";
import type { Application, Direction, JobPosting, Sector, TrackerSettings } from "@/lib/tracker-types";
import { DEFAULT_MY_SECTORS, DIRECTIONS, SECTORS } from "@/lib/tracker-types";

const PAGE = 100;

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobPosting[] | null>(null);
  const [apps, setApps] = useState<Application[]>([]);
  const [mine, setMine] = useState<Direction[]>([]);
  const [settings, setSettings] = useState<TrackerSettings | null>(null);
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [resumeKws, setResumeKws] = useState<string[]>([]);
  const [pasteFor, setPasteFor] = useState<string | null>(null);
  const [paste, setPaste] = useState({ title: "", url: "" });
  const [onlyNew, setOnlyNew] = useState(false);
  const [showAuto, setShowAuto] = useState(false);
  const [feed, setFeed] = useState({ name: "", url: "" });
  const [running, setRunning] = useState(false);
  const [now] = useState(() => Date.now());
  const [onlyMine, setOnlyMine] = useState(true);
  const [mySec, setMySec] = useState<Sector[]>(DEFAULT_MY_SECTORS);
  const [onlyMySec, setOnlyMySec] = useState(true);
  const [onlyOverseas, setOnlyOverseas] = useState(false);
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [hideExpired, setHideExpired] = useState(true);
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [msg, setMsg] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ company: "", title: "", location: "", deadline: "", link: "" });

  const load = useCallback(() => {
    fetch("/api/tracker")
      .then((r) => r.json())
      .then((d) => {
        setJobs(d.jobs);
        setApps(d.applications);
        setMine(d.settings.myDirections);
        setMySec(d.settings.mySectors ?? DEFAULT_MY_SECTORS);
        setSettings(d.settings);
        setSearchEnabled(Boolean(d.searchEnabled));
        setResumeKws(d.resumeKeywords ?? []);
      });
  }, []);
  useEffect(load, [load]);

  const today = new Date().toISOString().slice(0, 10);
  const appliedJobIds = new Set(apps.flatMap((a) => [a.jobId, ...(a.jobIds ?? [])]).filter(Boolean));

  const sectors = useMemo(() => new Map((jobs ?? []).map((j) => [j.id, sectorsOf(j)])), [jobs]);

  const shown = useMemo(() => {
    if (!jobs) return [];
    const kw = q.trim().toLowerCase();
    return jobs
      .filter((j) => !onlyMine || !mine.length || j.directions.some((d) => mine.includes(d)))
      .filter((j) => !onlyMySec || !mySec.length || (sectors.get(j.id) ?? []).some((s) => mySec.includes(s)))
      .filter((j) => !onlyOverseas || j.overseas)
      .filter((j) => !onlyStarred || j.starred)
      .filter((j) => !onlyNew || isNew(j, now))
      .filter((j) => !hideExpired || !j.deadlineAt || j.deadlineAt >= today)
      .filter((j) => !kw || [j.company, j.title, j.location, j.industry, j.note].join(" ").toLowerCase().includes(kw))
      .sort((a, b) => (a.deadlineAt ?? "9999").localeCompare(b.deadlineAt ?? "9999"));
  }, [jobs, mine, onlyMine, sectors, mySec, onlyMySec, onlyOverseas, onlyStarred, onlyNew, hideExpired, q, today, now]);

  async function saveMine(next: Direction[]) {
    setMine(next);
    await fetch("/api/tracker", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ myDirections: next }) });
  }

  async function saveSectors(next: Sector[]) {
    setMySec(next);
    await fetch("/api/tracker", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mySectors: next }) });
  }

  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    setMsg("导入中…");
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("files", f));
    const d = await (await fetch("/api/tracker/jobs", { method: "POST", body: fd })).json();
    setMsg(`新增 ${d.added} 条${d.dup ? `，跳过重复 ${d.dup} 条` : ""}${d.errors?.length ? `。${d.errors.join("；")}` : ""}`);
    load();
  }

  async function addManual() {
    const r = await fetch("/api/tracker/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    if (!r.ok) return setMsg((await r.json()).error);
    setForm({ company: "", title: "", location: "", deadline: "", link: "" });
    setShowAdd(false);
    load();
  }

  async function star(j: JobPosting) {
    await fetch(`/api/tracker/jobs/${j.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ starred: !j.starred }) });
    load();
  }

  async function apply(j: JobPosting) {
    await fetch("/api/tracker/apps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: j.id }) });
    setMsg(`已加入投递看板：${j.company} · ${j.title}`);
    load();
  }

  async function addFeed() {
    if (!feed.url.trim()) return;
    await fetch("/api/tracker/feeds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(feed) });
    setFeed({ name: "", url: "" });
    load();
  }

  async function setTime(t: string) {
    await fetch("/api/tracker/feeds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dailyTime: t }) });
    load();
  }

  async function saveFeedSettings(body: object) {
    await fetch("/api/tracker/feeds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    load();
  }

  /** 在官网找到的岗位链接贴回来：作为这家公司的一条具体岗位入库 */
  async function addPasted(j: JobPosting) {
    const url = paste.url.trim();
    if (!/^https?:\/\//.test(url)) return setMsg("请粘贴以 http 开头的岗位链接");
    await fetch("/api/tracker/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: j.company, title: paste.title.trim() || "（未写岗位）", jdUrl: url, location: j.location, deadline: j.deadline, batch: j.batch, industry: j.industry }),
    });
    setPaste({ title: "", url: "" });
    setPasteFor(null);
    setMsg(`已添加「${j.company}」的岗位`);
    load();
  }

  async function setWebSearch(on: boolean) {
    await fetch("/api/tracker/feeds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ webSearch: on }) });
    load();
  }

  async function runNow() {
    setRunning(true);
    const d = await (await fetch("/api/tracker/feeds/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
    setRunning(false);
    setMsg(`更新完成：新增 ${d.added} 条岗位${d.errors?.length ? `；${d.errors.join("；")}` : ""}`);
    load();
  }

  async function feedAction(id: string, body: object | null) {
    await fetch(`/api/tracker/feeds/${id}`, body ? { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { method: "DELETE" });
    load();
  }

  async function remove(j: JobPosting) {
    if (!confirm(`从岗位库删除「${j.company} · ${j.title}」？`)) return;
    await fetch(`/api/tracker/jobs/${j.id}`, { method: "DELETE" });
    load();
  }

  if (jobs === null) return <p className="text-sm text-slate-500">加载中…</p>;

  return (
    <div className="mx-auto max-w-6xl">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">岗位库</h1>
          <p className="mt-1 text-sm text-slate-500">
            共 {jobs.length} 条，当前显示 {shown.length} 条
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => setShowAdd(!showAdd)}>
            手动添加
          </button>
          <label className="btn-primary cursor-pointer">
            导入表格
            <input type="file" accept=".csv,.xlsx" multiple className="hidden" onChange={(e) => importFiles(e.target.files)} />
          </label>
        </div>
      </header>
      <p className="mt-2 text-xs text-slate-500">
        把大家共享的秋招汇总表（飞书、腾讯文档可以导出为 Excel 或 CSV）导进来，会自动识别公司、岗位、地点、截止时间、链接等列；重复的岗位不会重复导入。
      </p>
      {msg && <p className="mt-3 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">{msg}</p>}

      {settings && (
        <section className="panel mt-4">
          <button className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm" onClick={() => setShowAuto(!showAuto)}>
            <span>
              <span className="mr-1.5 inline-block w-3 text-slate-400">{showAuto ? "▾" : "▸"}</span>
              每日自动更新 · 每天 {settings.dailyTime}
              <span className="ml-2 text-xs text-slate-400">
                {settings.jobworthy !== false && "jobworthy + "}
                {searchEnabled && settings.webSearch === true && "联网搜索 + "}
                {settings.feeds.filter((f) => f.enabled).length} 个订阅源
                {settings.lastAutoRun && ` · 上次 ${fmt(settings.lastAutoRun.at)}（${settings.lastAutoRun.trigger}）新增 ${settings.lastAutoRun.added} 条`}
              </span>
            </span>
            <span
              role="button"
              className="rounded-md bg-accent-soft px-2 py-0.5 text-xs text-accent"
              onClick={(e) => {
                e.stopPropagation();
                if (!running) runNow();
              }}
            >
              {running ? "更新中…" : "立即更新"}
            </span>
          </button>
          {showAuto && (
            <div className="space-y-3 border-t border-slate-100 px-4 py-3 text-sm">
              <p className="text-xs leading-5 text-slate-500">
                项目开着时，每天到点自动同步下面的来源，新岗位直接入库并标「新」；到点时电脑没开，下次打开项目会补跑一次。
                订阅源需要是公开可下载的表格：CSV、Excel、Markdown 表格（如 GitHub 上的秋招汇总）、网页表格。腾讯文档、飞书链接需要登录，读不到。
              </p>
              <label className="flex items-center gap-2 text-xs text-slate-600">
                每天更新时间
                <input type="time" className="rounded-md border border-slate-300 px-1.5 py-0.5" defaultValue={settings.dailyTime} onBlur={(e) => setTime(e.target.value)} />
              </label>
              <label className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                在官网找岗位的关键词
                <input
                  key={(settings.jobKeywords ?? resumeKws).join(",")}
                  className="min-w-60 flex-1 rounded-md border border-slate-300 px-1.5 py-0.5"
                  defaultValue={(settings.jobKeywords ?? resumeKws).join("、")}
                  placeholder="用顿号或空格分隔"
                  onBlur={(e) => saveFeedSettings({ jobKeywords: e.target.value.split(/[、,，\s]+/).filter(Boolean) })}
                />
                <span className="text-slate-400">{settings.jobKeywords?.length ? "" : "（默认从你的经历卡片里取）"}</span>
              </label>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                <li className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <input type="checkbox" checked={settings.jobworthy !== false} onChange={(e) => saveFeedSettings({ jobworthy: e.target.checked })} />
                  <span className="font-medium">校招公司清单（jobworthy）</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
                    开源项目每天汇总的 1800 多家公司校招入口，按「我的方向」筛选、跳过已投公司；飞书招聘的官网会按关键词自动找出具体岗位
                  </span>
                  <span className={`text-xs ${settings.lastJobworthy?.error ? "text-red-600" : "text-slate-500"}`}>
                    {settings.lastJobworthy
                      ? settings.lastJobworthy.error
                        ? settings.lastJobworthy.error
                        : `${fmt(settings.lastJobworthy.at)} 新增 ${settings.lastJobworthy.added} 家公司、${settings.lastJobworthy.expanded} 个岗位`
                      : "还没同步过"}
                  </span>
                </li>
                {settings.feeds.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <input type="checkbox" checked={f.enabled} onChange={(e) => feedAction(f.id, { enabled: e.target.checked })} />
                    <span className="font-medium">{f.name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{f.url}</span>
                    <span className={`text-xs ${f.lastError ? "text-red-600" : "text-slate-500"}`}>
                      {f.lastError ? f.lastError : f.lastFetchedAt ? `${fmt(f.lastFetchedAt)} 新增 ${f.lastAdded ?? 0}` : "还没拉取过"}
                    </span>
                    <button className="text-xs text-slate-300 hover:text-red-600" onClick={() => feedAction(f.id, null)}>
                      删除
                    </button>
                  </li>
                ))}
                <li className={`flex flex-wrap items-center gap-2 px-3 py-2 ${searchEnabled ? "" : "text-slate-400"}`}>
                  <input
                    type="checkbox"
                    disabled={!searchEnabled}
                    checked={searchEnabled && settings.webSearch === true}
                    onChange={(e) => setWebSearch(e.target.checked)}
                  />
                  <span className="font-medium">联网搜索新开网申的岗位</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
                    {searchEnabled ? `用千问按「我的方向」搜索${mine.length ? `（${mine.slice(0, 4).join("、")}）` : ""}，结果噪音较大，默认关` : "未配置：在 .env.local 填入 SEARCH_LLM_API_KEY 后重启"}
                  </span>
                  {searchEnabled && (
                    <span className={`text-xs ${settings.lastSearch?.error ? "text-red-600" : "text-slate-500"}`}>
                      {settings.lastSearch
                        ? settings.lastSearch.error && !settings.lastSearch.added
                          ? settings.lastSearch.error
                          : `${fmt(settings.lastSearch.at)} 新增 ${settings.lastSearch.added}`
                        : "还没搜索过"}
                    </span>
                  )}
                </li>
              </ul>
              <div className="flex flex-wrap gap-2">
                <input className="input sm:max-w-52" placeholder="名称，如 GitHub 秋招汇总" value={feed.name} onChange={(e) => setFeed({ ...feed, name: e.target.value })} />
                <input className="input min-w-60 flex-1" placeholder="表格链接（CSV / Excel / GitHub 页面）" value={feed.url} onChange={(e) => setFeed({ ...feed, url: e.target.value })} />
                <button className="btn-ghost" onClick={addFeed}>
                  添加订阅源
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {showAdd && (
        <div className="panel mt-4 grid gap-2 p-4 sm:grid-cols-[1fr_1fr_120px_140px_1.5fr_auto]">
          <input className="input" placeholder="公司 *" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          <input className="input" placeholder="岗位" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input className="input" placeholder="地点" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <input className="input" placeholder="截止，如 10/15" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
          <input className="input" placeholder="投递链接" value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} />
          <button className="btn-primary" onClick={addManual}>
            添加
          </button>
        </div>
      )}

      <section className="panel mt-4 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="mr-1 text-xs text-slate-500">我的方向</span>
          {DIRECTIONS.filter((d) => d !== "技术").map((d) => {
            const on = mine.includes(d);
            return (
              <button
                key={d}
                onClick={() => saveMine(on ? mine.filter((x) => x !== d) : [...mine, d])}
                className={`rounded-full px-2.5 py-0.5 text-xs ${on ? "bg-accent text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
              >
                {d}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="mr-1 text-xs text-slate-500">我的行业</span>
          {SECTORS.map((s) => {
            const on = mySec.includes(s);
            return (
              <button
                key={s}
                onClick={() => saveSectors(on ? mySec.filter((x) => x !== s) : [...mySec, s])}
                className={`rounded-full px-2.5 py-0.5 text-xs ${on ? "bg-accent text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
              >
                {s}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <Toggle on={onlyMine} set={setOnlyMine} label={mine.length ? "只看我的方向" : "只看我的方向（先选方向）"} />
          <Toggle on={onlyMySec} set={setOnlyMySec} label={mySec.length ? "只看我的行业" : "只看我的行业（先选行业）"} />
          <Toggle on={onlyOverseas} set={setOnlyOverseas} label="只看海外相关" />
          <Toggle on={onlyStarred} set={setOnlyStarred} label="只看收藏" />
          <Toggle on={onlyNew} set={setOnlyNew} label="只看 24 小时内新增" />
          <Toggle on={hideExpired} set={setHideExpired} label="隐藏已截止" />
          <input className="input ml-auto max-w-60" placeholder="搜索公司、岗位、地点" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </section>

      {jobs.length === 0 ? (
        <div className="panel mt-4 px-4 py-12 text-center text-sm text-slate-500">还没有岗位。点右上角「导入表格」或「手动添加」。</div>
      ) : (
        <div className="panel mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-slate-200 text-left text-xs text-slate-500">
              <tr>
                <th className="w-8 px-3 py-2"></th>
                <th className="px-3 py-2">公司</th>
                <th className="px-3 py-2">岗位</th>
                <th className="px-3 py-2">地点</th>
                <th className="px-3 py-2">截止</th>
                <th className="px-3 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.slice(0, limit).map((j) => {
                const days = j.deadlineAt ? Math.ceil((new Date(j.deadlineAt).getTime() - new Date(today).getTime()) / 86400000) : null;
                const applied = appliedJobIds.has(j.id);
                return (
                  <tr key={j.id} className="align-top hover:bg-slate-50">
                    <td className="px-3 py-2.5">
                      <button onClick={() => star(j)} className={j.starred ? "text-amber-500" : "text-slate-300 hover:text-amber-400"} title="收藏">
                        ★
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium">
                        {j.company}
                        {isNew(j, now) && <span className="ml-1.5 rounded bg-red-500 px-1 text-[10px] font-normal text-white">新</span>}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(sectors.get(j.id) ?? []).map((s) => (
                          <span key={s} className={`rounded px-1.5 py-0.5 text-[11px] ${mySec.includes(s) ? "bg-accent-soft text-accent" : "bg-slate-100 text-slate-500"}`}>
                            {s}
                          </span>
                        ))}
                      </div>
                      {j.industry && <div className="mt-0.5 text-xs text-slate-400">{j.industry}</div>}
                    </td>
                    <td className="px-3 py-2.5">
                      <div>
                        {j.siteOnly && <span className="mr-1 text-xs text-slate-400">招聘方向：</span>}
                        {j.title}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {j.directions.map((d) => (
                          <span key={d} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                            {d}
                          </span>
                        ))}
                        {j.overseas && <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700">海外</span>}
                        {j.batch && <span className="text-[11px] text-slate-400">{j.batch}</span>}
                      </div>
                      {j.note && <div className="mt-1 line-clamp-1 text-xs text-slate-400">{j.note}</div>}
                      {pasteFor === j.id && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <input className="input max-w-40 py-1 text-xs" placeholder="岗位名" value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} />
                          <input
                            className="input min-w-52 flex-1 py-1 text-xs"
                            placeholder="粘贴官网上的岗位链接"
                            autoFocus
                            value={paste.url}
                            onChange={(e) => setPaste({ ...paste, url: e.target.value })}
                            onKeyDown={(e) => e.key === "Enter" && addPasted(j)}
                          />
                          <button className="btn-primary px-2.5 py-1 text-xs" onClick={() => addPasted(j)}>
                            添加
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{j.location}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span className={days !== null && days < 0 ? "text-slate-400 line-through" : days !== null && days <= 3 ? "font-medium text-red-600" : ""}>
                        {j.deadline || "—"}
                      </span>
                      {days !== null && days >= 0 && days <= 7 && <div className="text-xs text-red-500">还剩 {days} 天</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      {j.jdUrl && j.jdUrl !== j.link && (
                        <a href={j.jdUrl} target="_blank" rel="noreferrer" className="mr-3 text-accent hover:underline" title="岗位详情页">
                          详情 ↗
                        </a>
                      )}
                      {j.noticeUrl && (
                        <a href={j.noticeUrl} target="_blank" rel="noreferrer" className="mr-3 text-slate-500 hover:underline" title="官方招聘公告">
                          公告 ↗
                        </a>
                      )}
                      {j.link && (
                        <a href={j.link} target="_blank" rel="noreferrer" className="mr-3 text-accent hover:underline">
                          {j.siteOnly ? "去官网搜 ↗" : "打开 ↗"}
                        </a>
                      )}
                      {j.siteOnly && (
                        <button
                          onClick={() => {
                            setPasteFor(pasteFor === j.id ? null : j.id);
                            setPaste({ title: "", url: "" });
                          }}
                          className="mr-3 text-accent hover:underline"
                          title="在官网找到合适的岗位后，把岗位链接贴回来"
                        >
                          ＋贴岗位链接
                        </button>
                      )}
                      {applied ? (
                        <Link href="/applications" className="mr-3 text-slate-400">
                          已投递 ✓
                        </Link>
                      ) : (
                        <button onClick={() => apply(j)} className="mr-3 rounded-md bg-accent-soft px-2 py-0.5 text-accent hover:brightness-95">
                          我已投递
                        </button>
                      )}
                      <button onClick={() => remove(j)} className="text-xs text-slate-300 hover:text-red-600">
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shown.length > limit && (
            <button className="w-full border-t border-slate-100 py-2 text-sm text-accent" onClick={() => setLimit(limit + PAGE)}>
              再显示 {Math.min(PAGE, shown.length - limit)} 条
            </button>
          )}
          {shown.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-500">没有符合筛选条件的岗位</p>}
        </div>
      )}
    </div>
  );
}

function Toggle({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
}

function isNew(j: JobPosting, now: number) {
  return now - new Date(j.createdAt).getTime() < 24 * 3600 * 1000;
}

function fmt(s: string) {
  const d = new Date(s);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
