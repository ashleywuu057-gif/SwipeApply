"use client";

import { useState } from "react";
import type { Category, SourceDoc } from "@/lib/types";
import { CATEGORIES } from "@/lib/types";

type CardOption = { id: string; label: string };

/** 一份资料：可展开看整篇原文，可改分类和归属 */
export default function MaterialItem({
  source,
  cards,
  onChanged,
}: {
  source: SourceDoc;
  cards: CardOption[];
  onChanged: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function toggle() {
    if (!open && text === null) {
      const d = await (await fetch(`/api/sources/${source.id}`)).json();
      setText(d.text);
    }
    setOpen(!open);
  }

  async function patch(body: { category?: Category; cardId?: string | null }) {
    await fetch(`/api/sources/${source.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    onChanged();
  }

  async function remove() {
    if (!confirm(`删除「${source.name}」？本机保存的原文也会一起删除。`)) return;
    await fetch(`/api/sources/${source.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <div className="panel">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
        <button onClick={toggle} className="min-w-0 flex-1 truncate text-left font-medium hover:text-accent">
          <span className="mr-1.5 inline-block w-3 text-slate-400">{open ? "▾" : "▸"}</span>
          {source.name}
          <span className="ml-2 text-xs font-normal text-slate-400">{source.chars} 字</span>
        </button>
        <select
          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
          value={source.category ?? ""}
          onChange={(e) => patch({ category: e.target.value as Category })}
        >
          {!source.category && <option value="">未分类</option>}
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        {source.category !== "简历" && (
          <select
            className="max-w-48 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
            value={source.cardId ?? ""}
            onChange={(e) => patch({ cardId: e.target.value || null })}
          >
            <option value="">不属于具体经历</option>
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        <button onClick={remove} className="text-xs text-slate-400 hover:text-red-600">
          删除
        </button>
      </div>
      {source.note && <p className="-mt-1 px-4 pb-2 pl-9 text-xs text-slate-500">说明：{source.note}</p>}
      {open && (
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap border-t border-slate-100 px-5 py-4 text-[13px] leading-6 text-slate-800">
          {text}
        </pre>
      )}
    </div>
  );
}
