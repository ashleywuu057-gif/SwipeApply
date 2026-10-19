"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import Bookmarklet from "@/components/Bookmarklet";
import { useSpeech } from "@/components/useSpeech";
import type { Bullet, ChatMsg, CompanyBrief, JdInfo, Profile, Resume } from "@/lib/native/types";
import type { JobPosting } from "@/lib/tracker-types";

type State = { jobId: string; resume: Resume | null; chat: ChatMsg[]; submittedAt?: string; applicationId?: string };
type Data = { job: JobPosting; jd: JdInfo; brief: CompanyBrief; state: State; profile: Profile; config: { llm: boolean; search: boolean } };

const post = (url: string, body: unknown, method = "POST") =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => {
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? "出错了");
    return d;
  });

export default function ApplyPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [brief, setBrief] = useState<CompanyBrief | null>(null);
  const [resume, setResume] = useState<Resume | null>(null);
  const [pageFit, setPageFit] = useState<PageFit>({ status: "full", fill: 100, orphans: [], trim: [] });
  const [tightening, setTightening] = useState(false);
  const [genFor, setGenFor] = useState<string | null>(null); // 刚生成的那份简历（updatedAt）：量出来以后自动收短一次
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [genBusy, setGenBusy] = useState(false);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState<{ text: string; pref?: string } | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [jdArrived, setJdArrived] = useState(false);
  const api = `/api/native/apply/${jobId}`;
  // 从首页对话框跳过来的修改要求（?ask=…）：简历准备好后自动交给工作台 Agent
  // 在 effect 里读：从首页跳过来时，组件首次渲染那一刻地址栏可能还没换成新地址
  const [ask, setAsk] = useState("");
  useEffect(() => {
    const a = (new URLSearchParams(window.location.search).get("ask") ?? "").trim();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 只在进入页面时读一次地址栏
    if (a) setAsk(a);
  }, []);

  const generate = useCallback(async () => {
    setGenBusy(true);
    setErr("");
    try {
      const d = await post(`${api}/resume`, {});
      setGenFor(d.state.resume?.updatedAt ?? null);
      setResume(d.state.resume);
      setChat(d.state.chat);
    } catch (e) {
      setErr((e as Error).message);
    }
    setGenBusy(false);
  }, [api]);

  useEffect(() => {
    fetch(api)
      .then((r) => r.json())
      .then((d: Data) => {
        setData(d);
        setBrief(d.brief);
        setChat(d.state.chat);
        if (d.state.resume) setResume(d.state.resume);
        else generate();
      });
  }, [api, generate]);

  // JD 还在找（浏览器打开、联网搜索）时轮询；找到了提示按 JD 重新生成简历
  const jdSearching = data?.jd.status === "searching";
  useEffect(() => {
    if (!jdSearching) return;
    const t = setInterval(() => {
      fetch(api)
        .then((r) => r.json())
        .then((d: Data) => {
          if (d.jd.status === "searching") return;
          setData((old) => (old ? { ...old, jd: d.jd } : old));
          if (d.jd.status === "ok") setJdArrived(true);
        });
    }, 3000);
    return () => clearInterval(t);
  }, [jdSearching, api]);

  // 公司速览还在生成时轮询
  const generating = brief?.status === "generating";
  useEffect(() => {
    if (!generating) return;
    const t = setInterval(() => {
      fetch(`${api}/brief`)
        .then((r) => r.json())
        .then((d) => setBrief(d.brief));
    }, 2500);
    return () => clearInterval(t);
  }, [generating, api]);

  // 收短最后一行只有几个字的 bullet：压到少一行的字数以内，核对不过的保留原句
  const tighten = useCallback(
    async (orphans: Orphan[]) => {
      if (!orphans.length) return;
      setTightening(true);
      const d = await post(`${api}/tighten`, { items: orphans.map((o) => ({ id: o.id, maxLen: o.len - o.tail - 2 })) }).catch((e) => ({ error: (e as Error).message }));
      setTightening(false);
      if ("error" in d) return setToast({ text: `收短没成功：${d.error}` });
      if (d.changed) setResume(d.state.resume);
      setToast({ text: d.kept ? `收短了 ${d.changed} 条；${d.kept} 条压不短（会丢信息或数字），保留原句` : `收短了 ${d.changed} 条，省掉了只有几个字的尾行` });
    },
    [api],
  );
  // 刚生成完的简历量出来以后：有短尾行就自动收短一次（之后手动改的只提醒，不自动改）
  // 只认量的是这份新简历的结果（pageFit.of），免得拿上一份的排版去收短
  useEffect(() => {
    if (!genFor || pageFit.of !== genFor) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 量完排版才知道要不要收短，只在生成后触发一次
    setGenFor(null);
    if (pageFit.status === "over" && pageFit.trim.length) void tighten(pageFit.trim);
    else if (pageFit.orphans.length) void tighten(pageFit.orphans);
  }, [pageFit, genFor, tighten]);

  const save = useCallback(
    async (next: Resume, edit?: { before: string; after: string }) => {
      setResume(next);
      const d = await post(`${api}/resume`, { resume: next, edit }, "PUT").catch(() => null);
      if (d) {
        setResume(d.resume);
        if (d.suggestion) setToast({ text: `要记住这条写作偏好吗：${d.suggestion}`, pref: d.suggestion });
      }
    },
    [api],
  );


  if (!data || !brief) return <p className="text-sm text-slate-500">加载中…</p>;
  const { job } = data;

  return (
    // 宽屏下整页固定一屏：左右两栏各自上下滑，底边对齐；底部留出对话栏的高度（对话栏自己量好写进 --agentbar-h）
    <div className="pb-48 lg:flex lg:h-full lg:flex-col lg:pb-[calc(var(--agentbar-h,9rem)_-_2rem)]">
      {/* 打印只留简历：其他元素直接不排版（只隐藏的话还占高度，会多出空白页） */}
      <style>{`@media print { html, body { background: white !important; height: auto !important; overflow: visible !important; } ::-webkit-scrollbar { display: none !important; } body *:not(:has(#resume-print)):not(#resume-print):not(#resume-print *) { display: none !important; } body *:has(#resume-print) { margin: 0 !important; padding: 0 !important; border: 0 !important; box-shadow: none !important; background: none !important; height: auto !important; max-height: none !important; overflow: visible !important; scrollbar-width: none !important; } #resume-print { display: block !important; width: 100%; } #resume-print .font-bold, #resume-print b { -webkit-text-stroke: 0.35px currentColor; } #resume-print[data-fit] { display: flex !important; flex-direction: column; justify-content: space-between; height: ${FIT_HEIGHT}; } @page { size: A4; margin: ${PAGE_MARGIN.y}mm ${PAGE_MARGIN.x}mm; } }`}</style>
      <motion.header initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-800">
            ← 回到岗位流
          </Link>
          <h1 className="mt-2 text-xl font-semibold">
            {job.company} <span className="font-normal text-slate-500">· {job.title}</span>
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            {[job.location, job.deadline && `截止 ${job.deadline}`, job.batch].filter(Boolean).join(" · ")}
            {job.source === "示例" && <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">示例岗位</span>}
            {data.state.submittedAt && <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">已投递</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => exportPdf(resume)} disabled={!resume}>
            导出 PDF
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setSubmitOpen(true);
              // 记下正在投这个岗位：插件同步履历时就用这份定制简历（网申页地址对不上岗位库也没关系）
              void fetch(`/api/native/apply/${job.id}/active`, { method: "POST" }).catch(() => undefined);
            }}
            disabled={!resume}
          >
            确认简历，去投递 →
          </button>
        </div>
      </motion.header>

      {!data.config.llm && (
        <p className="mt-3 shrink-0 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          还没有配置模型（.env.local 的 LLM_API_KEY）：简历先按关键词挑原句，不改写；公司速览和对话修改需要模型。
        </p>
      )}

      <div className="mt-5 grid gap-5 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:grid-rows-[minmax(0,1fr)]">
        <CompanyPanel brief={brief} job={job} jd={data.jd} api={api} onBrief={setBrief} config={data.config} onJd={(jd) => {
            setData({ ...data, jd });
            if (jd.status === "ok") setJdArrived(true);
          }} />
        {/* 右栏：和左栏一样高，简历在框内滚动 */}
        <div className="lg:flex lg:min-h-0 lg:flex-col">
          <div className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
          {!resume && genBusy && <GenProgress api={api} />}
          {resume && (
            <ResumeEditor resume={resume} profile={data.profile} fit={pageFit} onSave={save} onRegenerate={generate} busy={genBusy} onProfile={(p) => setData({ ...data, profile: p })}>
              {genBusy && <GenProgress api={api} compact />}
            </ResumeEditor>
          )}
          </div>
        </div>
      </div>

      <AgentBar
        tips={(
          [
          err && { key: "err", tone: "red" as const, text: `生成简历没成功：${err}`, actions: [{ label: "重试", run: () => void generate() }] },
          jdArrived && resume && {
            key: "jd",
            text: "找到这个岗位的 JD 了，要按 JD 重新挑经历、调措辞吗？",
            actions: [
              { label: "按 JD 重新生成", run: () => (setJdArrived(false), generate()) },
              { label: "不用", run: () => setJdArrived(false) },
            ],
          },
          resume && pageFit.status === "over" && {
            key: "over",
            tone: "red" as const,
            text: `现在的内容超过一页 A4 了（约 ${pageFit.fill}%），导出会变成两页。${pageFit.trim.length ? "我可以把尾行最短的几条删短几个字，压回一页，字号不变。" : "超出的比较多，建议换掉关系最弱的一段（每段至少留 2 条）。"}`,
            actions: pageFit.trim.length ? [{ label: tightening ? "正在删短…" : `把尾行最短的 ${pageFit.trim.length} 条删短`, run: () => tighten(pageFit.trim) }] : [],
          },
          resume && pageFit.orphans.length > 0 && {
            key: "orphans",
            text: `有 ${pageFit.orphans.length} 条最后一行只有几个字，占了一整行（页面上标黄）。我可以按意思删掉几个多余的字，把这行省掉。`,
            actions: [{ label: tightening ? "正在收短…" : "收短这几条", run: () => tighten(pageFit.orphans) }],
          },
          resume && pageFit.status === "short" && {
            key: "short",
            text: `这页还没写满（内容只占约 ${pageFit.fill}%）。可以让我把句子写具体一点、给只有 2 条的经历加一条，或者把「备选」里的经历放回来。`,
            actions: [{ label: "帮我扩写到一页", say: "把简历扩写到正好一页：句子写具体一点，只有 2 条的经历加一条，不要编内容" }],
          },
          ] as (Tip | false | null | undefined | "")[]
        ).filter((t): t is Tip => Boolean(t))}
        api={api}
        chat={chat}
        resume={resume}
        llm={data.config.llm}
        initial={ask}
        onResult={(d) => {
          setChat(d.state.chat);
          if (d.state.resume) setResume(d.state.resume);
          if (d.brief) setBrief(d.brief);
        }}
        onPref={(text) => setToast({ text: `要记住这条写作偏好吗：${text}`, pref: text })}
      />

      {resume && <PrintResume resume={resume} profile={data.profile} onFit={setPageFit} />}

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            className="fixed left-1/2 top-6 z-50 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-accent/30 bg-white px-4 py-2.5 text-sm shadow-lg"
          >
            🧠 {toast.text}
            {toast.pref && (
              <button
                className="btn-primary !px-2.5 !py-1 text-xs"
                onClick={async () => {
                  await post("/api/native/memory", { op: "addWriting", text: toast.pref });
                  setToast({ text: "记住了，之后生成简历都会遵守" });
                  setTimeout(() => setToast(null), 2500);
                }}
              >
                记住
              </button>
            )}
            <button className="text-xs text-slate-400" onClick={() => setToast(null)}>
              {toast.pref ? "不用" : "✕"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {submitOpen && resume && (
        <SubmitModal
          job={job}
          resume={resume}
          onClose={() => setSubmitOpen(false)}
          onDone={async () => {
            const d = await post(`${api}/submit`, {});
            setSubmitOpen(false);
            setToast({ text: d.sample ? "示例岗位不会写进投递记录。回到岗位流…" : "已记进「我的投递」，回到岗位流看下一个…" });
            setTimeout(() => router.push("/"), 1200);
          }}
        />
      )}
    </div>
  );
}

/* ---------------- 导出：默认排成一页 A4，最后一行到下边缘的距离和第一行到上边缘相同 ---------------- */

/*
 * 字体字号、行距、页边距都按用户给的简历（参考简历 PDF，用 pdf.js 读出来的）固定，不自动缩放：
 * 宋体；姓名 14pt、模块标题 11.5pt、正文 10pt、技能行 9.5pt；行距 16.3pt；左右页边距 36pt = 12.7mm。上下页边距取同样的 12.7mm。
 */
const PAGE_MARGIN = { x: 12.7, y: 12.7 }; // mm；上下相等
const CONTENT_MM = { w: 210 - PAGE_MARGIN.x * 2, h: 297 - PAGE_MARGIN.y * 2 };
const FIT_HEIGHT = `${CONTENT_MM.h - 0.5}mm`; // 留 0.5mm 余量，免得四舍五入挤出第二页
const MM = 96 / 25.4; // 1mm 对应的 CSS 像素

/** 排版结果：正好一页 / 内容偏少（不到 9 成，靠拉开间距撑满会显得空）/ 超过一页；fill 是内容占页面高度的百分比 */
type PageFit = { status: "full" | "short" | "over"; fill: number; orphans: Orphan[]; trim: Orphan[]; of?: string /* 量的是哪份简历（updatedAt） */ };
/** 最后一行只有 tail 个字（≤ ORPHAN_MAX）的 bullet：len 是整条的字数 */
type Orphan = { id: string; tail: number; len: number };
const ORPHAN_MAX = 6;
const TAIL_SCAN = 30; // 尾行最多数到 30 个字（超出一页时挑尾行最短的几条删短）
const LINE_PX = (16.3 * 96) / 72; // 一行的高度（行距 16.3pt）
const SHORT_BELOW = 0.9;

/**
 * 按 A4 内容区的宽度量简历有多高（字号固定，不缩放）。
 * 放得下时，打印样式把简历撑满整页、余下的空白均分到各块之间，所以最后一行贴着下边距，和第一行到上边距一样宽。
 */
function fitOnePage(): PageFit {
  const el = document.getElementById("resume-print");
  if (!el) return { status: "full", fill: 100, orphans: [], trim: [] };
  const keep = el.getAttribute("style") ?? "";
  // 在屏幕外按打印宽度排一遍来量（屏幕上它本来是隐藏的）
  el.style.cssText = `${keep};display:block;position:fixed;left:-10000px;top:0;width:${CONTENT_MM.w}mm;height:auto;visibility:hidden`;
  const fill = el.scrollHeight / ((CONTENT_MM.h - 0.5) * MM);
  const tails = findTails(el);
  const orphans = tails.filter((t) => t.tail <= ORPHAN_MAX);
  // 超出一页：多出几行，就挑几条尾行最短的删短（删的字最少、信息损失最小），字号不变
  const overLines = Math.ceil((el.scrollHeight - (CONTENT_MM.h - 0.5) * MM) / LINE_PX);
  const trim = overLines > 0 ? [...tails].sort((a, b) => a.tail - b.tail).slice(0, overLines).filter((t) => t.tail <= 25) : [];
  el.setAttribute("style", keep);
  const ok = fill <= 1;
  // 快写满（≥9 成）才撑满整页、空白均分到各块之间；内容少时照常从上往下排，不然块和块之间会空出一大截。放不下就按内容自然分页，不截断
  el.toggleAttribute("data-fit", ok && fill >= SHORT_BELOW);
  return { status: !ok ? "over" : fill < SHORT_BELOW ? "short" : "full", fill: Math.round(fill * 100), orphans, trim };
}

/** 按真实排版找出最后一行只有 ≤6 个字的 bullet：从最后一个字往前数，和它在同一行的有几个字（用户定的：这种行要省掉） */
function findTails(el: HTMLElement): Orphan[] {
  const out: Orphan[] = [];
  const range = document.createRange();
  for (const li of el.querySelectorAll<HTMLElement>("li[data-bid]")) {
    const node = li.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const len = (node as Text).length;
    const topOf = (i: number) => {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      return range.getBoundingClientRect().top;
    };
    if (len < 2 || Math.abs(topOf(0) - topOf(len - 1)) < 2) continue; // 只有一行
    const last = topOf(len - 1);
    let tail = 1;
    while (tail < TAIL_SCAN && tail < len && Math.abs(topOf(len - 1 - tail) - last) < 2) tail++;
    out.push({ id: li.dataset.bid!, tail, len });
  }
  return out;
}

/** 导出前提醒：还有待核对的句子；超过一页或没写满也提醒 */
function exportPdf(resume: Resume | null) {
  const pending = resume?.experiences.filter((e) => e.include).flatMap((e) => e.bullets).filter((b) => b.status === "待核对").length ?? 0;
  if (pending && !window.confirm(`还有 ${pending} 句待核对，仍要导出吗？`)) return;
  const fit = fitOnePage();
  if (fit.status === "over" && !window.confirm("内容超过一页 A4，会分成两页。建议先删掉几条关系弱的，仍要导出吗？")) return;
  if (fit.status === "short" && !window.confirm(`这页还没写满（内容只占约 ${fit.fill}%），导出后各块之间的空白会比较大。仍要导出吗？`)) return;
  window.print();
}

const JD_BY: Record<string, string> = { 网页: "网申页面", 模型整理: "网申页面", 浏览器: "网申页面（浏览器打开）", 搜索: "联网搜索", 剪藏: "剪藏", 手动: "手动粘贴", 示例: "示例" };

/* ================= 左：公司速览 ================= */

function CompanyPanel({
  brief,
  job,
  jd,
  api,
  onBrief,
  onJd,
  config,
}: {
  brief: CompanyBrief;
  job: JobPosting;
  jd: JdInfo;
  api: string;
  onBrief: (b: CompanyBrief) => void;
  onJd: (jd: JdInfo) => void;
  config: { llm: boolean; search: boolean };
}) {
  const [jdOpen, setJdOpen] = useState(true); // JD 默认展开
  const [jdDraft, setJdDraft] = useState("");
  const [editingJd, setEditingJd] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const refLink = (ids: number[]) =>
    ids.length ? (
      <span className="ml-1 text-xs">
        {ids.map((n) => {
          const r = brief.refs.find((x) => x.id === n);
          return r ? (
            <a key={n} href={r.url} target="_blank" rel="noreferrer" title={`${r.title}（${r.site}）`} className="mr-0.5 text-accent hover:underline">
              [{n}]
            </a>
          ) : null;
        })}
      </span>
    ) : null;

  return (
    <aside className="space-y-4 lg:min-h-0 lg:overflow-y-auto">
      <section className="panel p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">公司速览</h2>
          <span className="text-xs text-slate-400">
            {brief.status === "ready" && (brief.basis === "联网" ? `联网 · ${brief.refs.length} 个来源` : brief.basis === "模型知识" ? "模型知识，未联网核实" : "示例")}
          </span>
        </div>
        {brief.status === "generating" && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-accent">正在联网了解 {job.company}…</p>
            {[80, 95, 60, 90, 70].map((w, i) => (
              <div key={i} className="h-3 animate-pulse rounded bg-slate-100" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        {brief.status === "failed" && (
          <p className="mt-3 text-sm text-red-600">
            生成失败：{brief.error}{" "}
            <button className="underline" onClick={() => post(`${api}/brief`, {}).then(() => onBrief({ ...brief, status: "generating" }))}>
              重试
            </button>
          </p>
        )}
        {brief.status === "ready" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 space-y-4 text-sm leading-6">
            <p className="text-slate-700">{brief.intro}</p>
            {brief.businessLine && (
              <div>
                <h3 className="text-xs font-medium text-slate-500">业务条线</h3>
                <p className="mt-1">{brief.businessLine}</p>
              </div>
            )}
            {brief.products.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-slate-500">主要产品</h3>
                <ul className="mt-1 space-y-1">
                  {brief.products.map((p) => (
                    <li key={p.name}>
                      <b>{p.name}</b>：{p.desc}
                      {refLink(p.refs)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {brief.facts.length > 0 && (
              <ul className="list-disc space-y-1 pl-4 text-slate-700">
                {brief.facts.map((f) => (
                  <li key={f.text}>
                    {f.text}
                    {refLink(f.refs)}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-3 border-t border-slate-100 pt-3 text-xs">
              <span className="text-slate-400">想了解更多？在下面直接问，例如「这条业务线最近有什么动作」</span>
              {brief.basis !== "示例" && (
                <button className="text-slate-500 hover:text-accent" onClick={() => post(`${api}/brief`, {}).then(() => onBrief({ ...brief, status: "generating" }))}>
                  重新生成
                </button>
              )}
            </div>
            {!config.search && brief.basis !== "示例" && <p className="text-xs text-slate-400">配置 SEARCH_LLM_API_KEY 后会联网核实并标注来源。</p>}
          </motion.div>
        )}
      </section>

      <section className="panel">
        <button className="flex w-full items-center justify-between px-5 py-3 text-left text-sm" onClick={() => setJdOpen(!jdOpen)}>
          <span className="font-medium">
            <span className="mr-1.5 inline-block w-3 text-slate-400">{jdOpen ? "▾" : "▸"}</span>JD
          </span>
          <span className="text-xs text-slate-400">{jd.status === "ok" ? `来自${JD_BY[jd.by] ?? jd.by}` : jd.status === "searching" ? "正在找…" : "没找到"}</span>
        </button>
        {(jdOpen || jd.status !== "ok") && (
          <div className="border-t border-slate-100 px-5 py-3 text-sm">
            {jd.status === "searching" && (
              <p className="mb-2 text-xs text-accent">正在找 JD：网申页面 → 用浏览器打开 → 联网搜索，最多一分钟…</p>
            )}
            {jd.status !== "ok" && jd.status !== "searching" && !editingJd && (
              <div className="mb-3 space-y-2 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                <p className="font-medium">还没找到这个岗位的 JD</p>
                {jd.error && (
                  <ul className="list-disc pl-4 text-amber-800">
                    {jd.error.split("；").map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    className="btn-ghost !px-2.5 !py-1 text-xs"
                    disabled={retrying}
                    onClick={async () => {
                      setRetrying(true);
                      const d = await post(`${api}/jd`, {}).catch(() => null);
                      setRetrying(false);
                      if (d) onJd(d.jd);
                    }}
                  >
                    {retrying ? "正在找（浏览器打开 + 联网搜索，约半分钟）…" : "再找一次"}
                  </button>
                  <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => (setJdDraft(""), setEditingJd(true))}>
                    手动粘贴
                  </button>
                </div>
                <p className="pt-1 text-amber-800">
                  最省事的办法：把 <Bookmarklet /> 拖到浏览器书签栏。以后在任何岗位页面（包括要登录才能看的）点一下它，JD 就带回来了；选中一段文字再点，就只存选中的部分。
                </p>
              </div>
            )}
            {editingJd ? (
              <div className="space-y-2">
                <textarea className="input h-48" value={jdDraft} onChange={(e) => setJdDraft(e.target.value)} placeholder="把岗位职责和任职要求粘贴到这里" />
                <div className="flex gap-2">
                  <button
                    className="btn-primary"
                    onClick={async () => {
                      const d = await post(`${api}/jd`, { text: jdDraft }, "PUT");
                      onJd(d.jd);
                      setEditingJd(false);
                    }}
                  >
                    保存
                  </button>
                  <button className="btn-ghost" onClick={() => setEditingJd(false)}>
                    取消
                  </button>
                </div>
                <p className="text-xs text-slate-400">保存后可以点右边的「重新生成」，按新 JD 定制简历。</p>
              </div>
            ) : (
              jd.status === "ok" && (
                <>
                  <p className="whitespace-pre-line leading-6 text-slate-700">{jd.text}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                    {jd.url && (
                      <a href={jd.url} target="_blank" rel="noreferrer" className="max-w-full truncate text-slate-400 hover:text-accent">
                        出处：{jd.sourceTitle || jd.url} ↗
                      </a>
                    )}
                    <button className="text-accent hover:underline" onClick={() => (setJdDraft(jd.text), setEditingJd(true))}>
                      修改 JD
                    </button>
                  </div>
                </>
              )
            )}
          </div>
        )}
      </section>
    </aside>
  );
}

/* ================= 右：定制简历 ================= */

const SKILLS = "__skills";

/** 简历主体的排列：已选经历 + 技能块（skillsPos 决定技能块插在第几段经历之后） */
function blockIds(resume: Resume) {
  const inc = resume.experiences.filter((e) => e.include).map((e) => e.cardId);
  const pos = Math.min(Math.max(resume.skillsPos ?? inc.length, 0), inc.length);
  inc.splice(pos, 0, SKILLS);
  return inc;
}

/** 按新的块顺序写回：已选经历按顺序排在前面，未选的保持原顺序排在后面 */
function applyOrder(resume: Resume, ids: string[]): Resume {
  const byId = new Map(resume.experiences.map((e) => [e.cardId, e]));
  const inc = ids.filter((id) => id !== SKILLS).map((id) => ({ ...byId.get(id)!, include: true }));
  const rest = resume.experiences.filter((e) => !ids.includes(e.cardId)).map((e) => ({ ...e, include: false }));
  return { ...resume, experiences: [...inc, ...rest], skillsPos: Math.max(ids.indexOf(SKILLS), 0) };
}

/**
 * 定制简历：直接在 A4 预览上编辑（用户要求：所有编辑都放到预览上，版式和最终导出的 PDF 一致）。
 * 页面本身和 PDF 同一套版式；按钮在页边距里、抬头和技能的表单在页面旁边弹出，都不改变版面。
 *   点句子：直接改（回车或点别处保存）    页边距 ↑↓：调顺序    ✕：移到备选    删：删一条
 *   点抬头 / 教育经历：改抬头               点技能：改技能
 */
function ResumeEditor({
  resume,
  profile,
  fit,
  onSave,
  onRegenerate,
  busy,
  onProfile,
  children,
}: {
  children?: React.ReactNode;
  resume: Resume;
  profile: Profile;
  fit: PageFit;
  onSave: (r: Resume, edit?: { before: string; after: string }) => void;
  onRegenerate: () => void;
  busy: boolean;
  onProfile: (p: Profile) => void;
}) {
  const [panel, setPanel] = useState<"profile" | "skills" | null>(null);
  const [link, setLink] = useState({ label: "", url: "" });
  const ids = blockIds(resume);
  const excluded = resume.experiences.filter((e) => !e.include);
  const bullets = new Map(resume.experiences.flatMap((e) => e.bullets).map((b) => [b.id, b] as const));
  const pending = resume.experiences.flatMap((e) => (e.include ? e.bullets : [])).filter((b) => b.status === "待核对").length;
  const marks = new Set([...fit.orphans, ...(fit.status === "over" ? fit.trim : [])].map((o) => o.id));
  const mapBullets = (f: (b: Bullet[]) => Bullet[]) => resume.experiences.map((e) => ({ ...e, bullets: f(e.bullets) }));

  const edit: SheetEdit = {
    marks,
    bullets,
    onBullet: (bid, text) => onSave({ ...resume, experiences: mapBullets((bs) => bs.map((b) => (b.id === bid ? { ...b, text, status: "手动" } : b))) }, { before: bullets.get(bid)?.text ?? "", after: text }),
    onDeleteBullet: (bid) => {
      const exp = resume.experiences.find((e) => e.bullets.some((b) => b.id === bid));
      if (exp && exp.bullets.length <= MIN_BULLETS_UI && !window.confirm(`这段经历只剩 ${exp.bullets.length} 条了，每段至少留 2 条。仍要删吗？`)) return;
      onSave({ ...resume, experiences: mapBullets((bs) => bs.filter((b) => b.id !== bid)) });
    },
    onMove: (bid, dir) => {
      const i = ids.indexOf(bid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      const order = [...ids];
      [order[i], order[j]] = [order[j], order[i]];
      onSave(applyOrder(resume, order));
    },
    onExclude: (cardId) => onSave(applyOrder(resume, ids.filter((x) => x !== cardId))),
    onProfile: () => setPanel("profile"),
    onSkills: () => setPanel("skills"),
  };

  return (
    <section className="panel p-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">定制简历</h2>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span>{resume.by === "模型" ? "AI 按 JD 挑选和改写" : resume.by === "规则" ? "按关键词挑选原句" : "示例经历"} · 每一句都能对上素材原句</span>
          <button className="text-accent hover:underline disabled:opacity-50" onClick={onRegenerate} disabled={busy}>
            {busy ? "生成中…" : "重新生成"}
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-slate-400">和导出的 PDF 完全一样。点句子直接改；鼠标移到某段上，页边会出现 ↑↓ 调顺序、✕ 移到备选、删 一条；点抬头、教育或技能可以修改。</p>
      {children}
      {pending > 0 && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">有 {pending} 句待核对（标红，鼠标停上去看原因和依据原句），请确认或修改。</p>}

      {panel === "profile" && (
        <div className="mt-3">
          <ProfileHeader profile={profile} onProfile={onProfile} onClose={() => setPanel(null)} />
          <button className="mt-1 text-xs text-slate-400 hover:text-slate-700" onClick={() => setPanel(null)}>
            取消
          </button>
        </div>
      )}
      {panel === "skills" && (
        <div className="mt-3 rounded-lg border border-dashed border-slate-300 p-3">
          <SkillsBlock resume={resume} profile={profile} onSave={onSave} handle={null} />
          <div className="mt-2 flex gap-3 text-xs">
            <button className="text-accent hover:underline" onClick={() => setPanel("profile")}>
              改语言能力、数分/AI 那两行（在抬头里）
            </button>
            <button className="text-slate-400 hover:text-slate-700" onClick={() => setPanel(null)}>
              完成
            </button>
          </div>
        </div>
      )}

      {/* A4 页面：左右各留出页边距里放按钮的地方 */}
      <div className="mt-4 rounded-2xl bg-slate-100/80 px-3 py-4 sm:px-6">
        <A4Preview resume={resume} profile={profile} fit={fit} edit={edit} />
      </div>

      {/* 备选经历 */}
      <div className="mt-4 rounded-xl border-2 border-dashed border-slate-200 p-3">
        <p className="text-xs text-slate-500">备选经历{excluded.length ? `（${excluded.length}）· 点 ＋ 放回简历` : " · 在页面上点某段左边的 ✕，就会移到这里"}</p>
        {excluded.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {excluded.map((e) => (
              <button
                key={e.cardId}
                className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm shadow-sm hover:border-slate-400"
                onClick={() => onSave(applyOrder(resume, [...ids, e.cardId]))}
              >
                {e.company} · {e.role}
                <span className="text-accent">＋</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 作品集：链接写在页面的「作品集」里 */}
      <div className="mt-4">
        <p className="text-xs text-slate-500">作品集链接（会出现在简历最后）</p>
        {resume.portfolio.length > 0 && (
          <ul className="mt-1 space-y-1 text-sm">
            {resume.portfolio.map((p) => (
              <li key={p.url} className="flex items-center gap-2">
                <a href={p.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  {p.label}
                </a>
                <button className="text-xs text-slate-400 hover:text-red-600" onClick={() => onSave({ ...resume, portfolio: resume.portfolio.filter((x) => x.url !== p.url) })}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!/^https?:\/\//.test(link.url)) return;
            onSave({ ...resume, portfolio: [...resume.portfolio, { label: link.label.trim() || link.url, url: link.url.trim() }] });
            setLink({ label: "", url: "" });
          }}
        >
          <input className="input !py-1.5 text-xs" placeholder="名称，例如：SwipeApply（个人项目）" value={link.label} onChange={(e) => setLink({ ...link, label: e.target.value })} />
          <input className="input !py-1.5 text-xs" placeholder="https://" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} />
          <button className="btn-ghost shrink-0 !py-1.5 text-xs">添加</button>
        </form>
      </div>
    </section>
  );
}
const MIN_BULLETS_UI = 2; // 和服务端 resume.ts 的 MIN_BULLETS 一致（这里是客户端，不能引用 server-only 模块）


/**
 * 「工作技能&其他」的行（用户定的）：固定两行——语言能力、数分/办公软件/AI，都来自抬头里填的「工作技能&其他」；
 * 下面挑的技能里，两行都没提到的另起一行「其他技能」；抬头里其余的行（兴趣爱好等）放最后。
 */
const LANG_LINE = /^语言/;
const TOOLS_LINE = /数分|数据|办公|软件|AI|技能|工具/i;
function skillLines(profile: Profile, skills: string[]) {
  const extra = textLines(profile.extra ?? "");
  const lang = extra.find((l) => LANG_LINE.test(l));
  const tools = extra.find((l) => l !== lang && TOOLS_LINE.test(l.split(/[：:]/)[0]));
  const rest = extra.filter((l) => l !== lang && l !== tools);
  const fixed = `${lang ?? ""}${tools ?? ""}`.toLowerCase();
  const more = skills.filter((s) => !fixed.includes(s.toLowerCase()));
  return {
    lang,
    tools,
    lines: [lang, tools, more.length ? `其他技能：${more.join("、")}` : "", ...rest].filter((l): l is string => Boolean(l)),
  };
}

function SkillsBlock({ resume, profile, onSave, handle }: { resume: Resume; profile: Profile; onSave: (r: Resume) => void; handle: React.ReactNode }) {
  const [skill, setSkill] = useState("");
  const { lang, tools } = skillLines(profile, resume.skills);
  return (
    <>
      <div className="flex items-center gap-2">
        {handle}
        <h3 className="text-sm font-semibold text-slate-800">工作技能&其他</h3>
      </div>
      {/* 固定的两行：来自抬头，在抬头里改 */}
      <ul className="mt-2 space-y-1 text-xs text-slate-700">
        <li>{lang ?? <span className="text-amber-700">还没写语言能力：点上面的抬头，在「工作技能&其他」里加一行「语言能力：…」</span>}</li>
        <li>{tools ?? <span className="text-amber-700">还没写数分/办公软件/AI：点上面的抬头，加一行「AI & 数分能力：…」</span>}</li>
      </ul>
      <p className="mt-2 text-[11px] text-slate-400">下面的技能里，上面两行没提到的会另起一行「其他技能」</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {resume.skills.map((s) => (
          <span key={s} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs">
            {s}
            <button className="text-slate-400 hover:text-red-600" onClick={() => onSave({ ...resume, skills: resume.skills.filter((x) => x !== s) })}>
              ×
            </button>
          </span>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (skill.trim()) onSave({ ...resume, skills: [...new Set([...resume.skills, skill.trim()])] });
            setSkill("");
          }}
        >
          <input className="w-28 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs outline-none focus:border-accent" placeholder="+ 添加技能" value={skill} onChange={(e) => setSkill(e.target.value)} />
        </form>
      </div>
    </>
  );
}



function ProfileHeader({ profile, onProfile, onClose }: { profile: Profile; onProfile: (p: Profile) => void; onClose?: () => void }) {
  // 从 A4 预览点进来（onClose）时直接打开表单，保存后关掉
  const [open, setOpen] = useState(Boolean(onClose) || !profile.name);
  const [p, setP] = useState(profile);
  const saveP = async () => {
    const d = await post("/api/native/memory", { op: "profile", profile: p });
    onProfile(d.profile);
    setOpen(false);
    onClose?.();
  };
  if (!open)
    return (
      <button className="mt-4 block w-full rounded-lg py-1 text-center hover:bg-slate-50" onClick={() => setOpen(true)} title="点击修改">
        <p className="text-lg font-semibold">{profile.name}</p>
        <p className="text-xs text-slate-500">{[profile.phone, profile.email].filter(Boolean).join(" · ")}</p>
      </button>
    );
  return (
    <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-3">
      <p className="text-xs text-slate-500">简历抬头（只存在本机，不会发给 AI）</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(
          [
            ["name", "姓名"],
            ["phone", "手机，例如 (+86) 13800000000"],
            ["email", "邮箱"],
          ] as const
        ).map(([k, ph]) => (
          <input key={k} className="input !py-1.5 text-xs" placeholder={ph} value={p[k]} onChange={(e) => setP({ ...p, [k]: e.target.value })} />
        ))}
        <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-500" title="导出简历时放在右上角；只存在本机">
          {p.photo ? <img src={p.photo} alt="证件照" className="h-9 w-7 rounded object-cover" /> : <span className="rounded border border-dashed border-slate-300 px-2 py-1">+ 证件照（可选）</span>}
          <input type="file" accept="image/*" className="hidden" onChange={async (e) => e.target.files?.[0] && setP({ ...p, photo: await shrinkPhoto(e.target.files[0]) })} />
          {p.photo && (
            <button type="button" className="hover:text-red-600" onClick={(e) => (e.preventDefault(), setP({ ...p, photo: undefined }))}>
              删除
            </button>
          )}
        </label>
        <textarea
          className="input col-span-2 h-16 !py-1.5 text-xs"
          placeholder={"工作技能&其他：每行一条，前两行固定写\n语言能力：英语 CET-6\nAI & 数分能力：熟练使用 Excel、SQL、Claude\n兴趣爱好：跑步、摄影（可选）"}
          value={p.extra}
          onChange={(e) => setP({ ...p, extra: e.target.value })}
        />
      </div>
      <button className="btn-primary mt-2 !py-1.5 text-xs" onClick={saveP}>
        保存
      </button>
    </div>
  );
}

type GenStep = { label: string; detail?: string; at: number; done: boolean };

/**
 * 生成简历时的等待：实时显示 AI 此刻在做哪一步（读 JD → 检索素材 → 挑经历改写 → 逐条核对），
 * 每一步的说明来自后端的真实数据（拆出几个要点、挑出几条素材、几条待核对），不是写死的文案。
 */
function GenProgress({ api, compact }: { api: string; compact?: boolean }) {
  const [since] = useState(() => Date.now());
  const [steps, setSteps] = useState<GenStep[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () =>
      fetch(`${api}/resume`)
        .then((r) => r.json())
        .then((d: { steps: GenStep[] }) => {
          // 上一次生成留下的记录不显示（这次的请求可能还没到后端）
          if (d.steps.length && d.steps[0].at >= since - 2000) setSteps(d.steps);
        })
        .catch(() => undefined);
    tick();
    const poll = setInterval(tick, 600);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => (clearInterval(poll), clearInterval(clock));
  }, [api, since]);

  const secs = (ms: number) => Math.max(0, Math.round(ms / 1000));
  return (
    <section className={`panel p-6 ${compact ? "mb-4" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-800">AI 正在为这个岗位定制简历</p>
        <span className="text-xs tabular-nums text-slate-400">{secs(now - since)} 秒</span>
      </div>
      <ol className="mt-4 space-y-3">
        <AnimatePresence initial={false}>
          {(steps.length ? steps : [{ label: "准备中", at: since, done: false }]).map((s, i, arr) => {
            const cur = !s.done && i === arr.length - 1;
            return (
              <motion.li key={`${i}-${s.label}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                  {s.done ? (
                    <motion.span initial={{ scale: 0.4 }} animate={{ scale: 1 }} className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-50 text-xs text-emerald-600">
                      ✓
                    </motion.span>
                  ) : (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/25 border-t-accent" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`text-sm ${cur ? "font-medium text-accent" : "text-slate-700"}`}>
                    {s.label}
                    {cur && secs(now - s.at) >= 3 && <span className="ml-2 text-xs font-normal tabular-nums text-slate-400">{secs(now - s.at)} 秒</span>}
                  </span>
                  {s.detail && <span className="mt-0.5 block text-xs leading-5 text-slate-500">{s.detail}</span>}
                </span>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>
      {!compact && (
        <div className="mt-5 space-y-2.5 border-t border-slate-100 pt-5">
          {[70, 90, 85, 60, 92].map((w, i) => (
            <div key={i} className="h-2.5 animate-pulse rounded bg-slate-100" style={{ width: `${w}%`, animationDelay: `${i * 120}ms` }} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ================= 打印版（导出 PDF）：标准一页简历格式 ================= */

const DATE_RANGE = /(\d{4}[./-]\d{1,2}\s*[-–—~至]+\s*(?:\d{4}[./-]\d{1,2}|至今|今))\s*$/;
const BULLET_MARK = /^[\s•·\-*]+/;

/** 教育经历：以时间结尾的行是"学校 专业"标题（时间靠右），其余行是它下面的要点 */
function parseEducation(text: string) {
  const blocks: { head: string; time: string; items: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(BULLET_MARK, "").trim();
    if (!line) continue;
    const m = line.match(DATE_RANGE);
    if (m) blocks.push({ head: line.slice(0, m.index).replace(/[\s·|｜,，]+$/, "").replace(/\s*·\s*/g, " "), time: m[1].replace(/\s+/g, ""), items: [] });
    else if (blocks.length) blocks[blocks.length - 1].items.push(line);
    else blocks.push({ head: line, time: "", items: [] });
  }
  return blocks;
}

const textLines = (t: string) =>
  t
    .split("\n")
    .map((l) => l.replace(BULLET_MARK, "").trim())
    .filter(Boolean);

/** 预览里可以做的编辑（打印那份不传，就是纯版式）。所有按钮都绝对定位在页边距里，不占版面，换行和 PDF 一样 */
type SheetEdit = {
  onBullet: (bulletId: string, text: string) => void;
  onDeleteBullet: (bulletId: string) => void;
  onMove: (blockId: string, dir: -1 | 1) => void;
  onExclude: (cardId: string) => void;
  onProfile: () => void; // 点抬头、教育经历：改抬头
  onSkills: () => void; // 点技能：改技能
  marks: Set<string>; // 要删短的（尾行太短、超页）
  bullets: Map<string, Bullet>;
};

/** 页边距里的小按钮（预览是整页缩小显示的，所以按钮用 mm 定大小，缩小后还点得到） */
function MarginTools({ children, side = "left", group = "exp" }: { children: React.ReactNode; side?: "left" | "right"; group?: "exp" | "li" }) {
  // 按钮列一直延伸到文字边上（中间不留空隙），鼠标从文字移到按钮上时不会「移出去就没了」；段落和句子分开两组，各显示各的
  const show = group === "exp" ? "group-hover/exp:flex" : "group-hover/li:flex";
  return (
    <span
      contentEditable={false}
      className={`absolute top-0 z-10 hidden w-[12.5mm] flex-col gap-[1mm] text-[8pt] leading-none ${show} ${side === "left" ? "-left-[12.5mm] items-start pr-[3mm]" : "-right-[12.5mm] items-end pl-[3mm]"}`}
    >
      {children}
    </span>
  );
}
const toolBtn = "flex h-[5.5mm] w-[9mm] items-center justify-center rounded-[1mm] bg-white text-gray-500 shadow ring-1 ring-gray-200 hover:bg-gray-900 hover:text-white";

function PrintSection({ title, children, onClick, tools }: { title: string; children: React.ReactNode; onClick?: () => void; tools?: React.ReactNode }) {
  return (
    <section className={`group/exp relative mt-[6pt] ${onClick ? "cursor-pointer rounded-[1mm] hover:bg-sky-50" : ""}`} onClick={onClick} title={onClick ? "点击修改" : undefined}>
      {tools}
      <p className="border-b border-black pb-[1pt] text-[11.5pt] leading-[16.3pt] font-bold">{title}</p>
      <div className="mt-[3pt]">{children}</div>
    </section>
  );
}

function PrintBullets({ items, ids, edit }: { items: string[]; ids?: string[]; edit?: SheetEdit }) {
  return (
    <ul className="list-disc pl-[16pt]">
      {items.map((t, i) => {
        const id = ids?.[i];
        const b = id ? edit?.bullets.get(id) : undefined;
        const editable = Boolean(edit && id);
        const warn = b?.status === "待核对";
        // 颜色只表示一件事：红底 = 待核对；黄底 = 要删短（尾行太短、超页）；两样都有就红底加黄框（框不占版面）
        const mark = Boolean(id && edit?.marks.has(id));
        const tone = warn ? `bg-red-100 ${mark ? "ring-2 ring-amber-400" : ""}` : mark ? "bg-amber-200/70" : "";
        return (
          <li
            key={`${i}:${t}`}
            data-bid={id}
            className={`${tone} ${editable ? "group/li relative cursor-text rounded-[0.5mm] outline-none hover:bg-sky-50 focus:bg-sky-50 focus:ring-1 focus:ring-sky-300" : ""}`}
            title={b ? [warn && `⚠ ${b.issue}`, `依据原句：${b.source || "（无）"}`].filter(Boolean).join("\n") : undefined}
            // 预览里直接改：失焦或回车保存（预览和 PDF 同一套版式，改完马上能看到换行）
            contentEditable={editable}
            suppressContentEditableWarning
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLElement).blur();
              }
            }}
            onBlur={(e) => {
              const next = (e.currentTarget.firstChild?.textContent ?? "").replace(/\s+/g, " ").trim();
              if (edit && id && next && next !== t) edit.onBullet(id, next);
            }}
          >
            {t}
            {edit && id && (
              <MarginTools side="right" group="li">
                <button className={toolBtn} title="删掉这条（每段至少留 2 条）" onMouseDown={(e) => e.preventDefault()} onClick={() => edit.onDeleteBullet(id)}>
                  删
                </button>
              </MarginTools>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PrintResume({ resume, profile, onFit }: { resume: Resume; profile: Profile; onFit: (fit: PageFit) => void }) {
  // 直接按 Ctrl+P 打印也先排成一页
  useEffect(() => {
    window.addEventListener("beforeprint", fitOnePage);
    return () => window.removeEventListener("beforeprint", fitOnePage);
  }, []);
  // 每次改动（包括手动编辑）后量一次，超过一页就提醒；字体加载完再量一次，免得按后备字体量错
  useEffect(() => {
    onFit({ ...fitOnePage(), of: resume.updatedAt });
    let alive = true;
    document.fonts?.ready.then(() => alive && onFit({ ...fitOnePage(), of: resume.updatedAt }));
    return () => {
      alive = false;
    };
  }, [resume, profile, onFit]);
  return <ResumeSheet resume={resume} profile={profile} id="resume-print" className="hidden" />;
}

/**
 * 简历的版式本身（和用户给的 PDF 一致）：打印用的隐藏那份、工作台里的 A4 预览都用它，所以预览的换行和导出的 PDF 完全一样。
 * marks：要标出来的 bullet（尾行太短、超页要删短的）
 */
function ResumeSheet({ resume, profile, id, className = "", edit }: { resume: Resume; profile: Profile; id?: string; className?: string; edit?: SheetEdit }) {
  const edu = parseEducation(profile.education ?? "");
  const contact = [profile.phone && `手机号码: ${profile.phone}`, profile.email && `电子邮箱: ${profile.email}`].filter(Boolean).join("  |  ");
  const blocks = blockIds(resume);
  // 调顺序：↑↓（不用拖动，免得多包一层改变版式）
  const moveTools = (blockId: string, extra?: React.ReactNode) =>
    edit ? (
      <MarginTools>
        <button className={toolBtn} title="往上移" onClick={(e) => (e.stopPropagation(), edit.onMove(blockId, -1))}>
          ↑
        </button>
        <button className={toolBtn} title="往下移" onClick={(e) => (e.stopPropagation(), edit.onMove(blockId, 1))}>
          ↓
        </button>
        {extra}
      </MarginTools>
    ) : null;
  return (
    <div id={id} className={`text-[10pt] leading-[16.3pt] text-black ${className}`} style={{ fontFamily: '"SimSun", "Songti SC", "STSong", "Noto Serif SC", serif' }}>
      <header
        className={`relative text-center ${profile.photo ? "min-h-[32mm] pt-[4mm]" : ""} ${edit ? "cursor-pointer rounded-[1mm] hover:bg-sky-50" : ""}`}
        onClick={edit?.onProfile}
        title={edit ? "点击修改抬头（姓名、电话、邮箱、照片、教育、技能）" : undefined}
      >
        <p className="text-[14pt] leading-[20pt] font-bold tracking-wide">{profile.name || (edit ? "点这里填写姓名" : "")}</p>
        {contact && <p className="mt-[2pt]">{contact}</p>}
        {profile.photo && <img src={profile.photo} alt="" className="absolute right-0 top-0 h-[32mm] w-[24mm] object-cover" />}
      </header>

      {edu.length > 0 && (
        <PrintSection title="教育经历" onClick={edit?.onProfile}>
          {edu.map((b, i) => (
            <div key={i} className={i ? "mt-[3pt]" : ""}>
              <p className="flex justify-between gap-4 font-bold">
                <span>{b.head}</span>
                <span className="shrink-0 font-normal">{b.time}</span>
              </p>
              {b.items.length > 0 && <PrintBullets items={b.items} />}
            </div>
          ))}
        </PrintSection>
      )}

      {blocks.map((bid, i) => {
        if (bid === SKILLS) {
          const items = skillLines(profile, resume.skills).lines;
          return items.length || edit ? (
            <PrintSection key={bid} title="工作技能&其他" onClick={edit?.onSkills} tools={moveTools(bid)}>
              <div className="text-[9.5pt]">
                <PrintBullets items={items} />
              </div>
            </PrintSection>
          ) : null;
        }
        const e = resume.experiences.find((x) => x.cardId === bid)!;
        const first = i === 0 || blocks[i - 1] === SKILLS; // 连续的一段经历前面才写模块标题
        const body = (
          <div className={`${first ? "" : "mt-[4pt]"} ${edit ? "group/exp relative" : ""}`}>
            {moveTools(
              bid,
              edit && (
                <button className={toolBtn} title="移到备选（不放进简历）" onClick={() => edit.onExclude(bid)}>
                  ✕
                </button>
              ),
            )}
            <p className="font-bold">{e.company}</p>
            <p className="flex justify-between gap-4">
              <b>{e.role}</b>
              <span className="shrink-0">{e.time}</span>
            </p>
            <PrintBullets items={e.bullets.map((b) => b.text)} ids={e.bullets.map((b) => b.id)} edit={edit} />
          </div>
        );
        return first ? (
          <PrintSection key={bid} title="实习经历">
            {body}
          </PrintSection>
        ) : (
          <div key={bid}>{body}</div>
        );
      })}

      {resume.portfolio.length > 0 && (
        <PrintSection title="作品集">
          <PrintBullets items={resume.portfolio.map((p) => `${p.label}：${p.url}`)} />
        </PrintSection>
      )}
    </div>
  );
}

/** 证件照压缩到 300px 宽的 JPEG，只存在本机 */
function shrinkPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = Math.min(300, img.width);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = Math.round((img.height / img.width) * w);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* ================= 底部：和 agent 说话（语音 / 文字） ================= */

const QUICK = ["突出数据分析能力", "第一段经历扩写一点", "精简到一页", "这家公司最近有什么动态？", "这个岗位在哪条业务线？"];

/** AI 主动说的提示（超页、尾行太短、没写满、找到 JD…），带按钮：run 直接执行，say 当成你说的话发给 AI */
type Tip = { key: string; text: string; tone?: "red"; actions: { label: string; run?: () => void; say?: string }[] };

function AgentBar({
  tips = [],
  api,
  chat,
  resume,
  llm,
  onResult,
  onPref,
  initial,
}: {
  tips?: Tip[];
  api: string;
  chat: ChatMsg[];
  resume: Resume | null;
  llm: boolean;
  initial?: string; // 打开时自动发出的一句（从首页对话框带过来的修改要求）
  onResult: (d: { state: State; brief?: CompanyBrief }) => void;
  onPref: (t: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false); // 对话默认收起，不挡简历；发消息后展开
  const [pendingUser, setPendingUser] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  // 量对话栏的高度，写进 --agentbar-h：工作台按这个高度留出底部，两栏的底边不被对话栏挡住
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty("--agentbar-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--agentbar-h");
    };
  }, []);
  const speech = useSpeech(setText);
  const lastQ = [...chat].reverse().find((m) => m.role === "assistant")?.question;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chat, busy, open]);

  // 带着首页的修改要求进来：等简历生成好，自动发出这一句（只发一次），并把它从地址栏去掉，刷新时不会重发
  const sentInitial = useRef(false);
  useEffect(() => {
    if (!initial || sentInitial.current || !resume || !llm) return;
    // 开发模式下 effect 会先挂载、卸载、再挂载一次：标记放进定时器里，被清掉的那次不算发过
    const t = setTimeout(() => {
      if (sentInitial.current) return;
      sentInitial.current = true;
      window.history.replaceState(null, "", window.location.pathname);
      void send(initial);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send 每次渲染都是新函数；这里只在简历就绪时触发一次
  }, [initial, resume, llm]);

  async function send(msg: string) {
    const m = msg.trim();
    if (!m || busy || !resume) return;
    if (speech.listening) speech.toggle(text);
    setBusy(true);
    setErr("");
    setPendingUser(m);
    setText("");
    setOpen(true);
    try {
      const d = await post(`${api}/chat`, { message: m, resume });
      onResult(d);
      const last = d.state.chat.at(-1) as ChatMsg | undefined;
      if (last?.suggestion) onPref(last.suggestion.text);
    } catch (e) {
      setErr((e as Error).message);
      setText(m);
    }
    setPendingUser("");
    setBusy(false);
  }

  return (
    <div ref={barRef} className="fixed inset-x-0 bottom-0 z-30 md:left-56">
      <div className="mx-auto max-w-4xl px-4 pb-4">
        <div className="rounded-2xl border border-slate-200 bg-white/95 shadow-2xl backdrop-blur">
          {open && (chat.length > 0 || busy) && (
            <div className="max-h-[38vh] space-y-3 overflow-y-auto border-b border-slate-100 px-4 py-3 text-sm">
              {chat.map((m, i) => (
                <ChatBubble key={i} m={m} />
              ))}
              {pendingUser && <ChatBubble m={{ role: "user", text: pendingUser }} />}
              {busy && <p className="text-xs text-accent">正在思考和修改…</p>}
              <div ref={endRef} />
            </div>
          )}
          {/* AI 主动提示：不用展开对话也看得到 */}
          {tips.length > 0 && (
            <div className="space-y-2 border-b border-slate-100 px-4 py-3 text-sm">
              {tips.map((t) => (
                <div key={t.key} className="flex flex-wrap items-center gap-2">
                  <p className={`rounded-2xl rounded-bl-sm px-3 py-2 ${t.tone === "red" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-700"}`}>{t.text}</p>
                  {t.actions.map((a) => (
                    <button
                      key={a.label}
                      disabled={busy}
                      onClick={() => (a.say ? void send(a.say) : a.run?.())}
                      className="rounded-full bg-gray-900 px-3 py-1 text-xs text-white hover:bg-gray-700 disabled:opacity-40"
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          {lastQ && !busy && !open && (
            <p className="px-4 pt-2 text-xs text-accent">
              💬 回答 AI 的问题：{lastQ}（你的回答会记进素材库，之后可以写进简历）
            </p>
          )}
          <div className="flex flex-wrap gap-1.5 px-4 pt-2">
            {QUICK.map((q) => (
              <button key={q} onClick={() => send(q)} disabled={busy || !llm} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600 hover:bg-accent-soft hover:text-accent disabled:opacity-40">
                {q}
              </button>
            ))}
          </div>
          <form
            className="flex items-end gap-2 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            <button type="button" onClick={() => setOpen(!open)} className="pb-2 text-xs text-slate-400 hover:text-slate-700" title={open ? "收起对话" : "展开对话"}>
              {open ? "▾" : `▴ ${chat.length || ""}`}
            </button>
            <textarea
              rows={1}
              className="input max-h-32 min-h-10 resize-none"
              placeholder={llm ? (speech.listening ? "正在听…说完点 ■ 或直接发送" : "说说想怎么改简历，或者问问这家公司…") : "对话修改需要先配置模型"}
              value={text}
              disabled={!llm}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(text);
                }
              }}
            />
            {speech.supported && (
              <motion.button
                type="button"
                whileTap={{ scale: 0.9 }}
                onClick={() => speech.toggle(text)}
                disabled={!llm}
                title="语音输入（浏览器的语音识别）"
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ${speech.listening ? "animate-pulse border-red-400 bg-red-50 text-red-600" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
              >
                {speech.listening ? "■" : "🎙"}
              </motion.button>
            )}
            <button className="btn-primary h-10 shrink-0" disabled={busy || !text.trim() || !llm}>
              发送
            </button>
          </form>
          {(err || speech.error) && <p className="px-4 pb-2 text-xs text-red-600">{err || speech.error}</p>}
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ m }: { m: ChatMsg }) {
  const [showActions, setShowActions] = useState(false);
  if (m.role === "user")
    return (
      <div className="flex justify-end">
        <p className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-3 py-2 text-white">{m.text}</p>
      </div>
    );
  return (
    <div className="max-w-[90%]">
      {m.text && <p className="whitespace-pre-line rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2">{m.text}</p>}
      {m.question && <p className="mt-1 rounded-xl border border-accent/30 bg-accent-soft px-3 py-2 text-accent">❓ {m.question}</p>}
      {m.actions && m.actions.length > 0 && (
        <div className="mt-1">
          <button className="text-xs text-slate-400 hover:text-slate-700" onClick={() => setShowActions(!showActions)}>
            {showActions ? "▾" : "▸"} {m.question ? "其他问题" : "做了什么"}（{m.actions.length}）
          </button>
          {showActions && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-500">
              {m.actions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ================= 投递：导出 → 打开网申页 → 你提交 → 记进我的投递 ================= */

function SubmitModal({ job, resume, onClose, onDone }: { job: JobPosting; resume: Resume; onClose: () => void; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const copy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(""), 1500);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">去投递 {job.company}</h2>
        <ol className="mt-4 space-y-4 text-sm">
          <li>
            <p className="font-medium">1. 导出 PDF 简历</p>
            <button className="btn-ghost mt-1.5" onClick={() => exportPdf(resume)}>
              导出 PDF（在打印窗口选「另存为 PDF」）
            </button>
          </li>
          <li>
            <p className="font-medium">2. 打开网申页，填表并上传简历</p>
            {job.link ? (
              <a href={job.link} target="_blank" rel="noreferrer" className="btn-primary mt-1.5">
                打开网申页 ↗
              </a>
            ) : (
              <p className="mt-1 text-xs text-slate-500">这个岗位没有网申链接，请去公司校招官网投递。</p>
            )}
            <div className="mt-3 rounded-lg bg-accent-soft px-3 py-2.5 text-xs leading-5 text-slate-700">
              <p className="font-medium text-accent">用「投简助手」插件自动填写</p>
              <p className="mt-1">
                在网申页点浏览器右上角的插件 →「从SwipeApply同步履历」（会用这份定制简历）→「一键填写」→ 核对后自己提交 → 在插件里「确认已提交」，会自动记进我的投递。
                插件只填有把握的字段，不会替你点提交。
              </p>
              <details className="mt-1.5">
                <summary className="cursor-pointer text-accent">第一次用：安装插件</summary>
                <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-slate-600">
                  <li>Edge 地址栏打开 edge://extensions（Chrome 是 chrome://extensions）</li>
                  <li>打开「开发人员模式」</li>
                  <li>点「加载解压缩的扩展」，选择 jobprep-v3\extension\dist 文件夹</li>
                  <li>在工具栏的扩展菜单里把「SwipeApply · 投简助手」固定出来</li>
                </ol>
                <p className="mt-1 text-slate-500">插件只访问本机的SwipeApply（localhost:3000），数据不出你的电脑。</p>
              </details>
            </div>
            <p className="mt-2 text-xs text-slate-500">插件填不上的，可以一段段复制：</p>
            <div className="mt-2 space-y-1.5">
              {resume.experiences
                .filter((e) => e.include)
                .map((e) => (
                  <button key={e.cardId} className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-xs hover:bg-slate-50" onClick={() => copy(e.cardId, e.bullets.map((b) => b.text).join("\n"))}>
                    <span className="truncate">
                      {e.company} · {e.role}
                    </span>
                    <span className="shrink-0 text-accent">{copied === e.cardId ? "已复制 ✓" : "复制描述"}</span>
                  </button>
                ))}
            </div>
          </li>
          <li>
            <p className="font-medium">3. 在官网提交后，回来点这里</p>
            <p className="mt-0.5 text-xs text-slate-500">已经在插件里「确认已提交」的，不用再点。</p>
            <button
              className="btn-primary mt-1.5"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await onDone();
              }}
            >
              {busy ? "记录中…" : "我已提交，记进我的投递"}
            </button>
          </li>
        </ol>
        <button className="mt-5 text-xs text-slate-400 hover:text-slate-700" onClick={onClose}>
          先不投了
        </button>
      </motion.div>
    </div>
  );
}

/**
 * A4 页面：和导出的 PDF 用同一份版式（ResumeSheet）、同样的纸张和页边距，按宽度整页缩小显示，
 * 所以换行、尾行、有没有超页都和 PDF 一样。尾行太短、超页要删短的那几条标黄，待核对的标红。
 */
function A4Preview({ resume, profile, fit, edit }: { resume: Resume; profile: Profile; fit: PageFit; edit?: SheetEdit }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const PAGE_W = 210 * MM;
  const PAGE_H = 297 * MM;
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / PAGE_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, [PAGE_W]);
  return (
    <div ref={wrap} className="relative w-full" style={{ height: PAGE_H * scale }}>
      <div
        className={`absolute left-0 top-0 origin-top-left bg-white shadow-lg ring-1 ${fit.status === "over" ? "ring-red-300" : "ring-gray-200"}`}
        style={{ width: PAGE_W, height: PAGE_H, padding: `${PAGE_MARGIN.y}mm ${PAGE_MARGIN.x}mm`, transform: `scale(${scale})` }}
      >
        {/* 快写满时和打印一样撑满整页（空白均分到各块之间）；内容少或超页时照常往下排，超页时纸张底边用红线标出 */}
        <ResumeSheet resume={resume} profile={profile} edit={edit} className={fit.status === "full" ? "flex h-full flex-col justify-between" : ""} />
        {fit.status === "over" && <div className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-red-400" style={{ top: PAGE_H - PAGE_MARGIN.y * MM }} />}
      </div>
    </div>
  );
}
