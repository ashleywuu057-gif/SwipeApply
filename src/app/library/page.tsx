"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import MaterialItem from "@/components/MaterialItem";
import type { CardType, ExperienceCard, SourceDoc } from "@/lib/types";
import { CARD_TYPES, DETAIL_CATEGORIES } from "@/lib/types";

const SHORT: Record<string, string> = { 业务知识: "知识", 项目复盘: "复盘", 工作源文件: "源文件" };

export default function LibraryPage() {
  const router = useRouter();
  const [cards, setCards] = useState<ExperienceCard[] | null>(null);
  const [sources, setSources] = useState<SourceDoc[]>([]);
  const [filter, setFilter] = useState<CardType | "全部">("全部");
  const [q, setQ] = useState("");

  const load = useCallback(() => {
    fetch("/api/cards")
      .then((r) => r.json())
      .then((d) => {
        setCards(d.cards);
        setSources(d.sources);
      });
  }, []);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    if (!cards) return [];
    const kw = q.trim().toLowerCase();
    return cards.filter(
      (c) =>
        (filter === "全部" || c.type === filter) &&
        (!kw || [c.company, c.role, c.summary, ...c.details].join(" ").toLowerCase().includes(kw)),
    );
  }, [cards, filter, q]);

  const cardOptions = (cards ?? []).map((c) => ({ id: c.id, label: `${c.company || "未填公司"} · ${c.role || "未填岗位"}` }));
  const general = sources.filter((s) => s.category && s.category !== "简历" && !s.cardId);
  const unclassified = sources.filter((s) => !s.category);
  const resumes = sources.filter((s) => s.category === "简历");

  async function createBlank() {
    const d = await (await fetch("/api/cards", { method: "POST" })).json();
    router.push(`/cards/${d.card.id}`);
  }

  if (cards === null) return <p className="text-sm text-slate-500">加载中…</p>;

  if (cards.length === 0 && sources.length === 0) {
    return (
      <div className="mx-auto max-w-xl pt-16 text-center">
        <h1 className="text-2xl font-semibold">先把你的经历搬进来</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          先上传简历生成经历卡片，再上传业务知识、项目复盘和工作源文件，它们会归到对应的经历下面。
          <br />
          文件和卡片只保存在这台电脑上。
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/import" className="btn-primary">
            上传资料
          </Link>
          <button onClick={createBlank} className="btn-ghost">
            手动新建卡片
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">经历素材库</h1>
          <p className="mt-1 text-sm text-slate-500">
            {cards.length} 段经历 · {sources.length} 份资料
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={createBlank} className="btn-ghost">
            手动新建
          </button>
          <Link href="/import" className="btn-primary">
            上传资料
          </Link>
        </div>
      </header>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {(["全部", ...CARD_TYPES] as const).map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`rounded-full px-3 py-1 text-sm ${filter === t ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}
          >
            {t}
          </button>
        ))}
        <input className="input ml-auto max-w-60" placeholder="搜索公司、岗位" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {shown.map((c) => {
          const mats = sources.filter((s) => s.cardId === c.id);
          return (
            <Link key={c.id} href={`/cards/${c.id}`} className="panel block p-4 transition hover:border-accent/50 hover:shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{c.company || "（未填公司）"}</div>
                  <div className="truncate text-sm text-slate-600">{c.role || "（未填岗位）"}</div>
                </div>
                <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{c.type}</span>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                {c.start || "?"} – {c.end || "?"}
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-slate-700">{c.summary || c.details[0] || "暂无描述"}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {DETAIL_CATEGORIES.map((cat) => {
                  const n = mats.filter((m) => m.category === cat).length;
                  return n ? <Badge key={cat}>{`${SHORT[cat]} ${n}`}</Badge> : null;
                })}
                {c.localOnly && <Badge tone="teal">仅本地</Badge>}
                {c.warnings.length > 0 && <Badge tone="amber">待核对</Badge>}
              </div>
            </Link>
          );
        })}
        {shown.length === 0 && <p className="text-sm text-slate-500">没有匹配的卡片</p>}
      </div>

      {unclassified.length > 0 && (
        <Section title="未分类资料" desc="旧版本导入的资料，请选择分类和归属">
          {unclassified.map((s) => (
            <MaterialItem key={s.id} source={s} cards={cardOptions} onChanged={load} />
          ))}
        </Section>
      )}

      {general.length > 0 && (
        <Section title="通用资料" desc="不属于某段具体经历的业务知识、复盘和文件">
          {general.map((s) => (
            <MaterialItem key={s.id} source={s} cards={cardOptions} onChanged={load} />
          ))}
        </Section>
      )}

      {resumes.length > 0 && (
        <Section title="简历" desc="用来生成经历卡片的原始简历">
          {resumes.map((s) => (
            <MaterialItem key={s.id} source={s} cards={cardOptions} onChanged={load} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-0.5 text-xs text-slate-500">{desc}</p>
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "teal" | "amber" }) {
  const cls =
    tone === "teal" ? "bg-accent-soft text-accent" : tone === "amber" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${cls}`}>{children}</span>;
}
