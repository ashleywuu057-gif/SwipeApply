"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Captured = { u: string; t: string; s: string; x: string };

/** 剪藏 JD 的落地页：书签把页面文字放在网址的 # 后面带过来（不经过任何服务器） */
export default function JdCapture() {
  const [cap, setCap] = useState<Captured | null>(null);
  const [jobs, setJobs] = useState<{ id: string; label: string; score: number }[]>([]);
  const [jobId, setJobId] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let c: Captured | null = null;
    try {
      c = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    } catch {}
    const q = new URLSearchParams({ title: c?.t ?? "", url: c?.u ?? "", text: (c?.s || c?.x || "").slice(0, 3000) });
    fetch(`/api/native/capture?${q}`)
      .then((r) => r.json())
      .then((d) => {
        setCap(c);
        setJobs(d.jobs);
        if (d.jobs[0]?.score > 0) setJobId(d.jobs[0].id);
      });
  }, []);

  async function save() {
    if (!cap || !jobId) return;
    setBusy(true);
    const r = await fetch("/api/native/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, selected: cap.s, text: cap.x, url: cap.u }) });
    const d = await r.json();
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: `已保存（${d.jd.text.length} 字）` } : { ok: false, text: d.error });
  }

  if (!cap)
    return (
      <div className="mx-auto max-w-xl">
        <h1 className="text-xl font-semibold">剪藏 JD</h1>
        <p className="mt-2 text-sm text-slate-500">没有收到页面内容。请在岗位页面上点书签栏的「剪藏 JD」。</p>
      </div>
    );
  const preview = cap.s || cap.x;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">剪藏 JD</h1>
      <div className="panel p-4 text-sm">
        <p className="font-medium">{cap.t}</p>
        <p className="truncate text-xs text-slate-400">{cap.u}</p>
        <p className="mt-2 text-xs text-slate-500">{cap.s ? `你选中的 ${cap.s.length} 个字会原样保存` : "没有选中文字：保存时 AI 会从整页里挑出这个岗位的职责和要求（只挑原文）"}</p>
        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-700">{preview.slice(0, 3000)}</pre>
      </div>
      <div>
        <label className="label">这是哪个岗位的 JD？</label>
        <select className="input" value={jobId} onChange={(e) => setJobId(e.target.value)}>
          <option value="">选择岗位…</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={!jobId || busy} onClick={save}>
          {busy ? "保存中…" : "保存 JD"}
        </button>
        {msg && (
          <span className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>
            {msg.text}
            {msg.ok && (
              <Link href={`/apply/${jobId}`} className="ml-2 text-accent underline">
                去投递工作台
              </Link>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
