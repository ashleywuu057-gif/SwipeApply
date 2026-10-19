"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Assignment, CardRef, CardType, Category, DraftCard, ExperienceCard, Segment, SourceDoc } from "@/lib/types";
import { CARD_TYPES, CATEGORIES, CATEGORY_HINT } from "@/lib/types";
import type { AutoRules } from "@/lib/types";
import type { Profile } from "@/lib/native/types";

const RULE_LABELS: [keyof AutoRules, string, string][] = [
  ["person", "人名", "带称呼、有上下文的人名，@某人，英文名"],
  ["nickname", "昵称", "阿X、小王、强哥、王总、婷婷、yy"],
  ["table", "表格和数据块", "整张表格、连续多行数字（图表数据）"],
  ["contact", "联系方式", "邮箱、手机、座机、身份证、微信"],
];
const RELEASABLE = new Set(["人名", "昵称", "邮箱", "手机", "电话", "微信"]);
const LABEL_ORDER = ["敏感词", "人名", "昵称", "表格", "数据", "邮箱", "手机", "电话", "身份证", "微信"];

function groupHits<T extends { label: string }>(hits: T[]): [string, T[]][] {
  const g = new Map<string, T[]>();
  for (const h of hits) g.set(h.label, [...(g.get(h.label) ?? []), h]);
  return [...g.entries()].sort((a, b) => LABEL_ORDER.indexOf(a[0]) - LABEL_ORDER.indexOf(b[0]));
}

type Step = 1 | 2 | 3 | 4;
type LlmInfo = { enabled: boolean; host: string; model: string };
type PreviewItem = {
  sourceId: string;
  name: string;
  sentName: string;
  note: string;
  redacted: string;
  hits: { placeholder: string; original: string; label: string; count: number }[];
};
type EditableDraft = DraftCard & { include: boolean; merge: boolean };

const STEPS = ["上传资料", "隐私检查", "分类与归属", "确认简历抬头"];
const SELECT = "rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:text-slate-400";

export default function ImportPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  // step 1
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState("");
  const [existing, setExisting] = useState<SourceDoc[]>([]);
  const [showExisting, setShowExisting] = useState(false); // 已导入列表默认收起
  const [existingQ, setExistingQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const shownExisting = existing.filter((s) => !existingQ.trim() || s.name.toLowerCase().includes(existingQ.trim().toLowerCase()));

  // step 2
  const [terms, setTerms] = useState("");
  const [allow, setAllow] = useState("");
  const [rules, setRules] = useState<AutoRules>({ contact: true, person: true, nickname: true, table: true });
  const [preview, setPreview] = useState<PreviewItem[]>([]);
  const [llm, setLlm] = useState<LlmInfo | null>(null);
  const [mode, setMode] = useState<"llm" | "rules">("rules");

  // step 3
  const [drafts, setDrafts] = useState<EditableDraft[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [cards, setCards] = useState<ExperienceCard[]>([]);

  // step 4：从简历里读出的抬头，让用户确认
  const [profile, setProfile] = useState<Profile | null>(null);
  const [filled, setFilled] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/sources").then((r) => r.json()).then((d) => setExisting(d.sources));
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setTerms(d.settings.sensitiveTerms.join("\n"));
        setAllow((d.settings.allowTerms ?? []).join("\n"));
        if (d.settings.autoRules) setRules(d.settings.autoRules);
        setLlm(d.llm);
        setMode(d.llm.enabled ? "llm" : "rules");
      });
  }, []);

  async function upload() {
    setError("");
    const ids = [...selected];
    if (files.length) {
      setBusy(files.some((f) => /\.(png|jpe?g|bmp|webp)$/i.test(f.name)) ? "正在本地解析文件（图片识别文字每张需要几秒）…" : "正在本地解析文件…");
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      fd.append("note", note);
      const d = await (await fetch("/api/sources", { method: "POST", body: fd })).json();
      ids.push(...d.created.map((s: SourceDoc) => s.id));
      if (d.errors.length) setError(d.errors.map((e: { name: string; error: string }) => `${e.name}：${e.error}`).join("\n"));
    }
    setSelected(ids);
    if (ids.length) {
      await loadPreview(ids);
      setStep(2);
    }
    setBusy("");
  }

  async function loadPreview(ids = selected) {
    const d = await (
      await fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceIds: ids }),
      })
    ).json();
    setPreview(d.items);
    setLlm(d.llm);
  }

  async function saveTerms(over: { allow?: string; rules?: AutoRules } = {}) {
    setBusy("更新脱敏预览…");
    const split = (t: string) => t.split(/[\n,，、]/);
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sensitiveTerms: split(terms),
        allowTerms: split(over.allow ?? allow),
        autoRules: over.rules ?? rules,
      }),
    });
    await loadPreview();
    setBusy("");
  }

  /** 规则误判时，把这个词加入"不屏蔽的词" */
  function release(word: string) {
    const next = [...allow.split("\n").filter(Boolean), word].join("\n");
    setAllow(next);
    saveTerms({ allow: next });
  }

  function toggleRule(k: keyof AutoRules) {
    const next = { ...rules, [k]: !rules[k] };
    setRules(next);
    saveTerms({ rules: next });
  }

  async function classify() {
    setError("");
    setBusy(mode === "llm" ? "脱敏文本已发送，模型正在分类…" : "本地规则分类中…");
    fetch("/api/cards").then((r) => r.json()).then((c) => setCards(c.cards));
    const d = await (
      await fetch("/api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceIds: selected, mode }),
      })
    ).json();
    setBusy("");
    if (d.errors.length) setError(d.errors.join("\n"));
    setDrafts(d.drafts.map((x: DraftCard) => ({ ...x, include: true, merge: Boolean(x.mergeIntoId) })));
    setAssignments(d.assignments);
    setStep(3);
  }

  // 第一次使用（从首页的「上传简历」进来）：回首页开始推岗位；平时导入完去素材库
  const done = () => router.push(new URLSearchParams(window.location.search).get("from") === "welcome" ? "/" : "/library");

  async function commit() {
    setBusy("保存中…");
    const d = await (
      await fetch("/api/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drafts, assignments }),
      })
    ).json();
    setBusy("");
    // 从简历里读出了抬头（姓名、电话…）：让用户看一眼再开始；没读出来就直接走
    if (d.filled?.length) {
      setProfile(d.profile);
      setFilled(d.filled);
      setStep(4);
    } else done();
  }

  async function saveProfile() {
    setBusy("保存中…");
    await fetch("/api/native/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "profile", profile }) });
    done();
  }

  const assign = (sourceId: string, p: Partial<Assignment>) =>
    setAssignments((as) => as.map((a) => (a.sourceId === sourceId ? { ...a, ...p } : a)));
  const segPatch = (sourceId: string, segId: string, p: Partial<Segment>) =>
    setAssignments((as) =>
      as.map((a) =>
        a.sourceId === sourceId ? { ...a, segments: a.segments?.map((g) => (g.id === segId ? { ...g, ...p } : g)) } : a,
      ),
    );

  // 归属下拉框的选项：已有卡片 + 本次新识别（且没有并入已有卡片）的经历
  const targetOptions: { value: string; label: string }[] = [
    ...cards.map((c) => ({ value: `card:${c.id}`, label: `${c.company || "未填公司"} · ${c.role || "未填岗位"}` })),
    ...drafts
      .filter((d) => d.include && !(d.merge && d.mergeIntoId))
      .map((d) => ({ value: `draft:${d.draftId}`, label: `新：${d.company || "未填公司"} · ${d.role || "未填岗位"}` })),
  ];
  const refValue = (t: CardRef) => {
    if (!t) return "";
    if (t.kind === "draft") {
      const d = drafts.find((x) => x.draftId === t.id);
      if (d?.merge && d.mergeIntoId) return `card:${d.mergeIntoId}`; // 并入已有卡片的，显示为已有卡片
    }
    return `${t.kind}:${t.id}`;
  };
  const parseRef = (v: string): CardRef => {
    if (!v) return null;
    const [kind, id] = v.split(":");
    return { kind: kind as "card" | "draft", id };
  };

  const patch = (id: string, p: Partial<EditableDraft>) =>
    setDrafts((ds) => ds.map((d) => (d.draftId === id ? { ...d, ...p } : d)));

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold">导入资料</h1>
      <ol className="mt-4 flex gap-2 text-sm">
        {STEPS.map((s, i) => (
          <li key={s} className={`flex items-center gap-2 rounded-full px-3 py-1 ${step === i + 1 ? "bg-slate-900 text-white" : step > i + 1 ? "bg-accent-soft text-accent" : "bg-white text-slate-500 ring-1 ring-slate-200"}`}>
            <span>{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      {error && <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</pre>}
      {busy && <p className="mt-4 text-sm text-accent">{busy}</p>}

      {step === 1 && (
        <section className="mt-6 space-y-5">
          <label className="panel flex cursor-pointer flex-col items-center justify-center border-dashed px-6 py-10 text-center hover:border-accent">
            <input
              type="file"
              multiple
              accept=".pdf,.docx,.pptx,.md,.txt,.csv,.ipynb,.py,.sql,.js,.ts,.r,.java,.json,.yaml,.yml,.sh,.html,.css,.png,.jpg,.jpeg,.bmp,.webp"
              className="hidden"
              onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])}
            />
            <span className="font-medium">点击选择文件</span>
            <span className="mt-1 text-xs text-slate-500">支持 PDF、Word、PPT(.pptx)、Markdown、TXT、CSV、代码（.py .ipynb .sql 等）和图片；飞书文档请先导出为 Word</span>
          </label>
          {files.length > 0 && (
            <ul className="space-y-1 text-sm">
              {files.map((f, i) => (
                <li key={i} className="flex justify-between rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
                  {f.name}
                  <button className="text-slate-400 hover:text-red-600" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <label className="label">补充说明（可选）：这些材料是什么、希望怎么用</label>
            <textarea
              className="input h-20"
              placeholder="例如：这是我在某广告公司实习时的周报和复盘，重点关注投放数据分析和客户沟通部分"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {existing.length > 0 && (
            <div className="panel">
              <button
                className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm"
                onClick={() => setShowExisting(!showExisting)}
              >
                <span>
                  <span className="mr-1.5 inline-block w-3 text-slate-400">{showExisting ? "▾" : "▸"}</span>
                  重新解析已导入的资料
                  <span className="ml-2 text-xs text-slate-400">共 {existing.length} 份</span>
                </span>
                {selected.length > 0 && <span className="text-xs text-accent">已选 {selected.length} 份</span>}
              </button>
              {showExisting && (
                <div className="border-t border-slate-100">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <input
                      className="input py-1.5"
                      placeholder="搜索文件名"
                      value={existingQ}
                      onChange={(e) => setExistingQ(e.target.value)}
                    />
                    <button
                      className="shrink-0 text-xs text-slate-500 hover:text-accent"
                      onClick={() => setSelected([...new Set([...selected, ...shownExisting.map((s) => s.id)])])}
                    >
                      全选
                    </button>
                    <button className="shrink-0 text-xs text-slate-500 hover:text-accent" onClick={() => setSelected([])}>
                      清空
                    </button>
                  </div>
                  <div className="max-h-64 divide-y divide-slate-100 overflow-auto border-t border-slate-100">
                    {shownExisting.map((s) => (
                      <label key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selected.includes(s.id)}
                          onChange={(e) => setSelected(e.target.checked ? [...selected, s.id] : selected.filter((x) => x !== s.id))}
                        />
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        {s.category && <span className="text-xs text-slate-400">{s.category}</span>}
                        <span className="w-14 text-right text-xs text-slate-400">{s.chars} 字</span>
                      </label>
                    ))}
                    {shownExisting.length === 0 && <p className="px-3 py-3 text-sm text-slate-400">没有匹配的文件</p>}
                  </div>
                </div>
              )}
            </div>
          )}

          <button className="btn-primary" disabled={!!busy || (!files.length && !selected.length)} onClick={upload}>
            下一步：隐私检查
          </button>
        </section>
      )}

      {step === 2 && (
        <section className="mt-6 grid gap-5 md:grid-cols-[260px_1fr]">
          <div className="space-y-4">
            <div className="panel space-y-1.5 p-3 text-sm">
              <div className="label">自动屏蔽</div>
              {RULE_LABELS.map(([k, name, hint]) => (
                <label key={k} className="flex gap-2">
                  <input type="checkbox" checked={rules[k]} onChange={() => toggleRule(k)} disabled={!!busy} />
                  <span>
                    {name}
                    <span className="block text-xs text-slate-500">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <div>
              <label className="label">敏感词（每行一个）</label>
              <textarea
                className="input h-28 font-mono text-xs"
                placeholder={"公司名\n客户名\n项目代号\n同事全名"}
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
              />
            </div>
            <div>
              <label className="label">不屏蔽的词（规则误判时填这里）</label>
              <textarea
                className="input h-20 font-mono text-xs"
                placeholder={"例如：小米\n高级经理"}
                value={allow}
                onChange={(e) => setAllow(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">数字默认保留。图片只在本机识别文字，原图不会发送。</p>
              <button className="btn-ghost mt-2 w-full" onClick={() => saveTerms()} disabled={!!busy}>
                保存并刷新预览
              </button>
            </div>

            <div className="panel space-y-2 p-3 text-sm">
              <div className="label">解析方式</div>
              <label className={`flex gap-2 ${!llm?.enabled ? "text-slate-400" : ""}`}>
                <input type="radio" disabled={!llm?.enabled} checked={mode === "llm"} onChange={() => setMode("llm")} />
                <span>
                  发送右侧脱敏文本给模型分类
                  <span className="block text-xs text-slate-500">
                    {llm?.enabled ? `${llm.model} @ ${llm.host}` : "未配置 LLM_API_KEY，见 README"}
                  </span>
                </span>
              </label>
              <label className="flex gap-2">
                <input type="radio" checked={mode === "rules"} onChange={() => setMode("rules")} />
                <span>
                  仅本地规则
                  <span className="block text-xs text-slate-500">按文件名和关键词分类，不发送任何内容</span>
                </span>
              </label>
            </div>

            <button className="btn-primary w-full" disabled={!!busy} onClick={classify}>
              {mode === "llm" ? "确认发送并分类" : "开始分类"}
            </button>
            <button className="btn-ghost w-full" onClick={() => setStep(1)}>
              返回
            </button>
          </div>

          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {mode === "llm" ? "以下就是将要发送给模型的全部内容，" : "以下是脱敏后的文本，"}
              <mark className="rounded bg-amber-100 px-1">高亮</mark> 处已替换，结果回来后会在本地还原。
            </p>
            {preview.map((p) => (
              <div key={p.sourceId} className="panel">
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-sm">
                  <span className="font-medium">
                    {p.name}
                    {p.sentName !== p.name && <span className="ml-2 text-xs font-normal text-slate-500">发送时文件名为：{p.sentName}</span>}
                  </span>
                  <span className="text-xs text-slate-500">替换 {p.hits.reduce((a, h) => a + h.count, 0)} 处</span>
                </div>
                {p.hits.length > 0 && (
                  <div className="space-y-1.5 border-b border-slate-100 px-4 py-2 text-xs">
                    {groupHits(p.hits).map(([label, hs]) => (
                      <div key={label} className="flex flex-wrap items-center gap-1.5">
                        <span className="w-12 shrink-0 text-slate-400">{label}</span>
                        {hs.map((h) => (
                          <span key={h.placeholder} className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5">
                            {h.label === "表格" || h.label === "数据"
                              ? `${h.placeholder}（${h.original.split("\n").length} 行）`
                              : `${h.original} → ${h.placeholder}`}
                            {RELEASABLE.has(h.label) && (
                              <button
                                className="text-slate-400 hover:text-red-600"
                                title="识别错了，不屏蔽这个词"
                                onClick={() => release(h.original)}
                                disabled={!!busy}
                              >
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-4 py-3 text-xs leading-5 text-slate-700">
                  <Highlighted text={p.redacted} />
                </pre>
              </div>
            ))}
          </div>
        </section>
      )}

      {step === 4 && profile && (
        <section className="panel mt-6 p-6">
          <h2 className="text-lg font-semibold">确认简历抬头</h2>
          <p className="mt-1 text-sm text-slate-500">
            从你的简历里读出了这些（只在你电脑上读，没有发给 AI），每份定制简历的抬头都用它。看一眼，不对的直接改。
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {(
              [
                ["name", "姓名"],
                ["phone", "电话"],
                ["email", "邮箱"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="block">
                <span className="label">
                  {label}
                  {filled.includes(k) && <span className="ml-1 text-emerald-600">· 从简历读出</span>}
                </span>
                <input className="input" value={profile[k]} onChange={(e) => setProfile({ ...profile, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          {(
            [
              ["education", "教育经历", "每段一行「学校 专业 起止时间」，下面几行是课程、GPA、奖项"],
              ["extra", "工作技能&其他", "第一行语言能力，第二行数分/办公软件/AI，其他的往下写"],
            ] as const
          ).map(([k, label, hint]) => (
            <label key={k} className="mt-4 block">
              <span className="label">
                {label}
                {filled.includes(k) && <span className="ml-1 text-emerald-600">· 从简历读出</span>}
                <span className="ml-2 font-normal text-slate-400">{hint}</span>
              </span>
              <textarea className="input min-h-28 font-mono text-xs leading-5" value={profile[k]} onChange={(e) => setProfile({ ...profile, [k]: e.target.value })} />
            </label>
          ))}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button className="btn-primary" onClick={saveProfile} disabled={Boolean(busy)}>
              保存，开始用 →
            </button>
            <button className="btn-ghost" onClick={done}>
              先跳过
            </button>
            <span className="text-xs text-slate-400">🔒 抬头只存在你电脑上，以后在简历页点抬头也能改</span>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="mt-6 space-y-8">
          <div>
            <h2 className="font-medium">资料分类</h2>
            <p className="mt-1 text-sm text-slate-500">
              原文只分类、不改写、不总结。一份文件里有不同类型的内容时，会按标题自动切成小节分别归类，切开的小节首尾相接、内容不重复。分错了在这里改，保存后也能在卡片详情里改。
            </p>
            <div className="panel mt-3 divide-y divide-slate-100">
              {assignments.map((a) => (
                <div key={a.sourceId} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                    {a.segments && a.segments.length > 1 && (
                      <button
                        className={`rounded-full px-2.5 py-1 text-xs ${a.split ? "bg-accent text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                        onClick={() => assign(a.sourceId, { split: !a.split })}
                        title="按标题把这份文件切成小节，分别分类"
                      >
                        {a.split ? `已切分为 ${a.segments.length} 节 · 点击取消` : `可切分为 ${a.segments.length} 节`}
                      </button>
                    )}
                    {!a.split && (
                      <>
                        <select
                          className={SELECT + " w-32"}
                          value={a.category}
                          title={CATEGORY_HINT[a.category]}
                          onChange={(e) => assign(a.sourceId, { category: e.target.value as Category })}
                        >
                          {CATEGORIES.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                        <TargetSelect
                          disabled={a.category === "简历"}
                          placeholder={a.category === "简历" ? "用于生成卡片" : "不属于具体经历"}
                          value={a.category === "简历" ? "" : refValue(a.target)}
                          options={targetOptions}
                          onChange={(v) => assign(a.sourceId, { target: parseRef(v) })}
                        />
                        <span className="w-16 text-right text-xs text-slate-400">{a.by}</span>
                      </>
                    )}
                  </div>
                  {a.split && a.segments && (
                    <div className="mt-2 space-y-1.5 border-l-2 border-accent/30 pl-4">
                      {a.segments.map((g) => (
                        <div key={g.id} className="flex flex-wrap items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="truncate">{g.title}</div>
                            <div className="truncate text-xs text-slate-400">{g.preview}</div>
                          </div>
                          <select
                            className={SELECT + " w-32"}
                            value={g.category}
                            onChange={(e) => segPatch(a.sourceId, g.id, { category: e.target.value as Category })}
                          >
                            {CATEGORIES.filter((c) => c !== "简历").map((c) => (
                              <option key={c}>{c}</option>
                            ))}
                          </select>
                          <TargetSelect
                            placeholder="不属于具体经历"
                            value={refValue(g.target)}
                            options={targetOptions}
                            onChange={(v) => segPatch(a.sourceId, g.id, { target: parseRef(v) })}
                          />
                          <span className="w-16 text-right text-xs text-slate-400">{g.by}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {CATEGORIES.filter((c) => c !== "简历").map((c) => `${c}：${CATEGORY_HINT[c]}`).join("　")}
            </p>
          </div>

          <div>
            <h2 className="font-medium">从简历识别的经历</h2>
            <p className="mt-1 text-sm text-slate-500">
              {drafts.length ? `共 ${drafts.length} 段。描述只取简历原句；找不到原句的会标黄。` : "这批资料里没有简历，不会新建卡片。"}
            </p>
            <div className="mt-3 space-y-3">
              {drafts.map((d) => (
                <div key={d.draftId} className={`panel p-4 ${d.include ? "" : "opacity-50"}`}>
                  <div className="flex flex-wrap items-center gap-4 text-sm">
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={d.include} onChange={(e) => patch(d.draftId, { include: e.target.checked })} />
                      保存这张
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={d.localOnly} onChange={(e) => patch(d.draftId, { localOnly: e.target.checked })} />
                      仅本地
                    </label>
                    {d.mergeIntoId && (
                      <label className="flex items-center gap-1.5 text-accent">
                        <input type="checkbox" checked={d.merge} onChange={(e) => patch(d.draftId, { merge: e.target.checked })} />
                        合并到已有卡片「{d.mergeIntoLabel}」
                      </label>
                    )}
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-[90px_1fr_1fr_90px_90px]">
                    <select className="input" value={d.type} onChange={(e) => patch(d.draftId, { type: e.target.value as CardType })}>
                      {CARD_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    <input className="input" placeholder="公司/组织" value={d.company} onChange={(e) => patch(d.draftId, { company: e.target.value })} />
                    <input className="input" placeholder="岗位/角色" value={d.role} onChange={(e) => patch(d.draftId, { role: e.target.value })} />
                    <input className="input" placeholder="开始" value={d.start} onChange={(e) => patch(d.draftId, { start: e.target.value })} />
                    <input className="input" placeholder="结束" value={d.end} onChange={(e) => patch(d.draftId, { end: e.target.value })} />
                  </div>
                  <textarea
                    className="input mt-3 h-24"
                    placeholder="简历里这段经历的描述，每行一条"
                    value={d.details.join("\n")}
                    onChange={(e) => patch(d.draftId, { details: e.target.value.split("\n") })}
                  />
                  {d.warnings.map((w) => (
                    <p key={w} className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                      {w}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button className="btn-primary" disabled={!!busy} onClick={commit}>
              保存到素材库
            </button>
            <button className="btn-ghost" onClick={() => setStep(2)}>
              返回重新分类
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(【[^【】]+?\d+】)/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

function TargetSelect({
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  placeholder: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <select className={SELECT + " w-64"} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
