"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import MaterialItem from "@/components/MaterialItem";
import type { CardType, Category, Evidence, ExperienceCard, SourceDoc } from "@/lib/types";
import { CARD_TYPES, CATEGORY_HINT, DETAIL_CATEGORIES } from "@/lib/types";

type CardOption = { id: string; label: string };
type EvidenceItem = Evidence & { sourceName: string };

/** 从这段经历的复盘、工作文档里提炼的证据：写简历和岗位匹配会用到 */
function EvidenceSection({ cardId, localOnly }: { cardId: string; localOnly: boolean }) {
  const [items, setItems] = useState<EvidenceItem[] | null>(null);
  const [eligibleCount, setEligibleCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/evidence?cardId=${cardId}`)
      .then((r) => r.json())
      .then((d: { items: EvidenceItem[]; eligibleSources: string[] }) => {
        setItems(d.items);
        setEligibleCount(d.eligibleSources.length);
      });
  }, [cardId]);
  useEffect(load, [load]);

  async function rerun() {
    setBusy(true);
    setMsg("正在逐段阅读资料，资料长的话要一两分钟…");
    const d = await fetch("/api/evidence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cardId }) }).then((r) => r.json());
    setBusy(false);
    if (d.error) return setMsg(d.error);
    const rs = Object.values(d.results as Record<string, { kept?: number; dropped?: string[]; error?: string }>);
    const kept = rs.reduce((n, r) => n + (r.kept ?? 0), 0);
    const dropped = rs.reduce((n, r) => n + (r.dropped?.length ?? 0), 0);
    setMsg(`提炼出 ${kept} 条${dropped ? `，另有 ${dropped} 条没通过核对（原文找不到或数字对不上），已丢弃` : ""}`);
    load();
  }

  async function toggle(e: EvidenceItem) {
    await fetch("/api/evidence", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id, hidden: !e.hidden }) });
    load();
  }

  if (!items) return null;
  const visible = items.filter((e) => showHidden || !e.hidden);
  const hiddenCount = items.filter((e) => e.hidden).length;
  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-medium">从资料里提炼的证据</h2>
          <p className="mt-0.5 text-xs text-slate-500">从这段经历的项目复盘、工作文档里摘出「问题 → 行动 → 结果」，每条都保留原文，写简历和匹配岗位时会用到。不准的可以隐藏。</p>
        </div>
        {!localOnly && eligibleCount > 0 && (
          <button className="btn-ghost shrink-0" disabled={busy} onClick={rerun}>
            {busy ? "提炼中…" : items.length ? "重新提炼" : "开始提炼"}
          </button>
        )}
      </div>
      {msg && <p className="mt-2 text-xs text-accent">{msg}</p>}
      {localOnly ? (
        <p className="panel mt-3 px-4 py-6 text-center text-sm text-slate-500">这段经历标了「仅本地」，不会发给模型提炼。</p>
      ) : items.length === 0 ? (
        <p className="panel mt-3 px-4 py-6 text-center text-sm text-slate-500">
          {eligibleCount ? `这段经历下有 ${eligibleCount} 份复盘或工作文档，还没提炼。` : "这段经历下还没有项目复盘或工作源文件。"}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {visible.map((e) => (
            <li key={e.id} className={`panel p-3 text-sm ${e.hidden ? "opacity-50" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  {e.problem && <p><span className="text-xs text-slate-400">问题　</span>{e.problem}</p>}
                  {e.action && <p><span className="text-xs text-slate-400">行动　</span>{e.action}</p>}
                  {e.result && <p><span className="text-xs text-slate-400">结果　</span>{e.result}</p>}
                  {(e.role || Object.keys(e.scope).length > 0) && (
                    <p className="flex flex-wrap gap-1 pt-1">
                      {e.role && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">{e.role}</span>}
                      {Object.values(e.scope).map((s) => (
                        <span key={s} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{s}</span>
                      ))}
                    </p>
                  )}
                </div>
                <button className="shrink-0 text-xs text-slate-400 hover:text-accent" onClick={() => toggle(e)}>
                  {e.hidden ? "恢复" : "隐藏"}
                </button>
              </div>
              <p className="mt-2 border-l-2 border-slate-200 pl-2 text-xs leading-5 text-slate-500">
                原文：{e.quote}
                <span className="ml-1 text-slate-400">——《{e.sourceName}》</span>
              </p>
            </li>
          ))}
        </ul>
      )}
      {hiddenCount > 0 && (
        <button className="mt-2 text-xs text-slate-500 hover:text-accent" onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? "收起隐藏的" : `查看隐藏的 ${hiddenCount} 条`}
        </button>
      )}
    </section>
  );
}

export default function CardDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [card, setCard] = useState<ExperienceCard | null>(null);
  const [materials, setMaterials] = useState<SourceDoc[]>([]);
  const [resumes, setResumes] = useState<SourceDoc[]>([]);
  const [cardOptions, setCardOptions] = useState<CardOption[]>([]);
  const [tab, setTab] = useState<Category>("项目复盘");
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState("");
  const first = useRef(true);

  const load = useCallback(() => {
    fetch(`/api/cards/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return router.replace("/library");
        setCard(d.card);
        setMaterials(d.materials);
        setResumes(d.resumes);
        setCardOptions(d.cards);
        if (first.current) {
          // 默认打开第一个有内容的分区
          const hit = DETAIL_CATEGORIES.find((c) => d.materials.some((m: SourceDoc) => m.category === c));
          if (hit) setTab(hit);
          first.current = false;
        }
        if (!d.card.company && !d.card.role) setEditing(true);
      });
  }, [id, router]);
  useEffect(load, [load]);

  if (!card) return <p className="text-sm text-slate-500">加载中…</p>;
  const set = (p: Partial<ExperienceCard>) => setCard({ ...card, ...p });

  async function save(extra: Partial<ExperienceCard> = {}) {
    const d = await (
      await fetch(`/api/cards/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...card, ...extra }),
      })
    ).json();
    setCard(d.card);
    setEditing(false);
    setStatus("已保存");
    setTimeout(() => setStatus(""), 1500);
  }

  async function remove() {
    if (!confirm("删除这张卡片？归属它的资料不会删除，会移到「通用资料」。")) return;
    await fetch(`/api/cards/${id}`, { method: "DELETE" });
    router.push("/library");
  }

  const inTab = materials.filter((m) => m.category === tab);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <Link href="/library" className="text-sm text-slate-500 hover:text-slate-800">
          ← 返回素材库
        </Link>
        <div className="flex items-center gap-2">
          {status && <span className="text-sm text-accent">{status}</span>}
          <button className="btn-ghost text-red-600" onClick={remove}>
            删除卡片
          </button>
        </div>
      </div>

      {/* 经历骨架 */}
      <section className="panel mt-4 p-5">
        {!editing ? (
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">{card.company || "（未填公司）"}</h1>
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{card.type}</span>
                {card.localOnly && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">仅本地</span>}
              </div>
              <p className="mt-1 text-sm text-slate-600">
                {card.role || "（未填岗位）"} · {card.start || "?"} – {card.end || "?"}
              </p>
              {card.details.length > 0 && (
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {card.details.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
            <button className="btn-ghost shrink-0" onClick={() => setEditing(true)}>
              编辑
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[100px_1fr_1fr_100px_100px]">
              <select className="input" value={card.type} onChange={(e) => set({ type: e.target.value as CardType })}>
                {CARD_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <input className="input" placeholder="公司/组织" value={card.company} onChange={(e) => set({ company: e.target.value })} />
              <input className="input" placeholder="岗位/角色" value={card.role} onChange={(e) => set({ role: e.target.value })} />
              <input className="input" placeholder="2024.06" value={card.start} onChange={(e) => set({ start: e.target.value })} />
              <input className="input" placeholder="至今" value={card.end} onChange={(e) => set({ end: e.target.value })} />
            </div>
            <div>
              <label className="label">一句话描述（列表页显示）</label>
              <input className="input" value={card.summary} onChange={(e) => set({ summary: e.target.value })} />
            </div>
            <div>
              <label className="label">简历中的描述（每行一条）</label>
              <textarea className="input h-32 leading-6" value={card.details.join("\n")} onChange={(e) => set({ details: e.target.value.split("\n") })} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={card.localOnly} onChange={(e) => set({ localOnly: e.target.checked })} />
              仅本地：这段经历和它的资料以后不参与任何云端模型调用
            </label>
            <div className="flex gap-2">
              <button className="btn-primary" onClick={() => save()}>
                保存
              </button>
              <button className="btn-ghost" onClick={() => { setEditing(false); load(); }}>
                取消
              </button>
            </div>
          </div>
        )}

        {card.warnings.length > 0 && (
          <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            {card.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
            <button className="mt-1 text-xs underline" onClick={() => save({ warnings: [] })}>
              我已核对，清除提示
            </button>
          </div>
        )}
        {resumes.length > 0 && (
          <p className="mt-4 text-xs text-slate-400">来源简历：{resumes.map((r) => r.name).join("、")}</p>
        )}
      </section>

      <EvidenceSection cardId={id} localOnly={card.localOnly} />

      {/* 资料分区 */}
      <section className="mt-6">
        <div className="flex flex-wrap gap-1 border-b border-slate-200">
          {DETAIL_CATEGORIES.map((c) => {
            const n = materials.filter((m) => m.category === c).length;
            return (
              <button
                key={c}
                onClick={() => setTab(c)}
                className={`-mb-px border-b-2 px-4 py-2 text-sm ${tab === c ? "border-accent font-medium text-accent" : "border-transparent text-slate-500 hover:text-slate-800"}`}
              >
                {c}
                <span className="ml-1.5 text-xs text-slate-400">{n}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-slate-500">{CATEGORY_HINT[tab]}。原文完整保留，点击文件名展开。</p>
        <div className="mt-3 space-y-2">
          {inTab.map((m) => (
            <MaterialItem key={m.id} source={m} cards={cardOptions} onChanged={load} />
          ))}
          {inTab.length === 0 && (
            <div className="panel px-4 py-8 text-center text-sm text-slate-500">
              还没有{tab}。
              <Link href="/import" className="ml-1 text-accent underline">
                去上传
              </Link>
            </div>
          )}
        </div>
      </section>

      {card.reflection && (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-slate-600">旧版本解析的复盘</h2>
          <p className="mt-0.5 text-xs text-slate-400">第一版把复盘拆进了卡片。现在复盘按原文放在上面的分区里，这段内容仅供参考。</p>
          <pre className="panel mt-2 whitespace-pre-wrap px-4 py-3 text-xs leading-5 text-slate-600">{card.reflection}</pre>
        </section>
      )}
    </div>
  );
}
