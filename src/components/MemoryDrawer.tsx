"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import type { Fact, PrefRule, Profile, WritingPref } from "@/lib/native/types";

type Mem = { rules: PrefRule[]; writing: WritingPref[]; facts: Fact[]; profile: Profile };

/** AI 记住的事：看得见、能关掉、能删。全部只存在本机的 data/memory.json */
export default function MemoryDrawer({ onClose }: { onClose: () => void }) {
  const [m, setM] = useState<Mem | null>(null);
  const [nick, setNick] = useState("");
  const [newPref, setNewPref] = useState("");

  useEffect(() => {
    fetch("/api/native/memory")
      .then((r) => r.json())
      .then((d: Mem) => {
        setM(d);
        setNick(d.profile.nickname);
      });
  }, []);

  async function post(body: unknown) {
    const d = await fetch("/api/native/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    setM(d);
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onClick={onClose}>
      <motion.aside
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">🧠 AI 记住的事</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            ✕
          </button>
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-500">AI 从你的滑动、修改和回答里学到的东西。只存在你电脑上，关掉或删掉的不会再影响推荐和简历。</p>
        {!m ? (
          <p className="mt-6 text-sm text-slate-500">加载中…</p>
        ) : (
          <div className="mt-5 space-y-6 text-sm">
            <Section title="岗位偏好" hint="影响岗位流的排序">
              {m.rules.map((r) => (
                <Row key={r.id} active={r.active} text={r.text} meta={ruleMeta(r)} onToggle={() => post({ op: "toggle", kind: "rules", id: r.id })} onDelete={() => post({ op: "delete", kind: "rules", id: r.id })} />
              ))}
              {!m.rules.length && <Empty>在岗位流顶部说一句你想看什么，或者多滑几张、左滑时点一下理由，AI 就会开始学</Empty>}
            </Section>

            <Section title="写作偏好" hint="生成和修改简历时遵守">
              {m.writing.map((w) => (
                <Row key={w.id} active={w.active} text={w.text} onToggle={() => post({ op: "toggle", kind: "writing", id: w.id })} onDelete={() => post({ op: "delete", kind: "writing", id: w.id })} />
              ))}
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newPref.trim()) post({ op: "addWriting", text: newPref });
                  setNewPref("");
                }}
              >
                <input className="input" placeholder="例如：数字放在句子前半段" value={newPref} onChange={(e) => setNewPref(e.target.value)} />
                <button className="btn-ghost shrink-0">添加</button>
              </form>
            </Section>

            <Section title="你补充的经历事实" hint="投递时回答 AI 的问题留下的，可以作为简历依据">
              {m.facts.map((f) => (
                <Row key={f.id} text={f.text} meta={f.from} onDelete={() => post({ op: "delete", kind: "facts", id: f.id })} />
              ))}
              {!m.facts.length && <Empty>还没有</Empty>}
            </Section>

            <Section title="称呼" hint="首页打招呼用">
              <div className="flex gap-2">
                <input className="input" value={nick} onChange={(e) => setNick(e.target.value)} />
                <button className="btn-ghost shrink-0" onClick={() => post({ op: "profile", profile: { nickname: nick.trim() } })}>
                  保存
                </button>
              </div>
            </Section>
          </div>
        )}
      </motion.aside>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="font-medium">
        {title} <span className="ml-1 text-xs font-normal text-slate-400">{hint}</span>
      </h3>
      <div className="mt-2 space-y-1.5">{children}</div>
    </section>
  );
}

/** 规则来源 + 有效期（"这周只看上海"这类有时限的，过期后自动不再影响排序） */
function ruleMeta(r: PrefRule) {
  if (!r.until) return r.from;
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${r.from} · ${r.until < today ? "已过期" : `有效到 ${Number(r.until.slice(5, 7))} 月 ${Number(r.until.slice(8, 10))} 日`}`;
}

function Row({ text, meta, active = true, onToggle, onDelete }: { text: string; meta?: string; active?: boolean; onToggle?: () => void; onDelete: () => void }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 ${active ? "" : "opacity-50"}`}>
      <div className="min-w-0 flex-1">
        <p className={active ? "" : "line-through"}>{text}</p>
        {meta && <p className="text-xs text-slate-400">{meta}</p>}
      </div>
      {onToggle && (
        <button onClick={onToggle} className="shrink-0 text-xs text-slate-500 hover:text-accent">
          {active ? "关掉" : "打开"}
        </button>
      )}
      <button onClick={onDelete} className="shrink-0 text-xs text-slate-400 hover:text-red-600">
        删除
      </button>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-slate-400">{children}</p>;
}
