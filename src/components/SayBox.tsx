"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUp, ArrowUpRight, Brain, Loader2, MessageCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CompanyBrief, PrefRule } from "@/lib/native/types";

const EXAMPLES = ["别推 To B 的岗位", "快手那段写得更数据化", "米哈游最近在做什么", "这周只看上海的产品岗", "我在字节实习时用过 SQL 做分析"];

type JobRef = { jobId: string; company: string; title: string };
type Reply =
  | { kind: "reply"; text: string }
  | { kind: "clarify"; text: string; options: { intent: string; label: string }[] }
  | { kind: "pick"; text: string; intent: string; options: JobRef[] }
  | { kind: "fact"; fact: { id: string; text: string } }
  | { kind: "company"; job: JobRef; brief: CompanyBrief }
  | { kind: "resume"; job: JobRef; instruction: string };

/**
 * 首页的统一入口：一句话，AI 先判断想做什么——调整推荐、改某份简历、了解一家公司、记下一段经历——再交给对应的环节。
 * 调整推荐的结果交给页面（重排岗位流、弹「记住了」）；其余的结果显示在对话框下面。
 */
export type Suggestion = { key: string; label: string; href: string; title?: string; urgent?: boolean };

/** 对话框里的建议：今天要做的事（面试、截止、待确认的邮件…），点一下直接去处理；最多显示 4 条，其余收进「全部待办」 */
export function SuggestionChips({ items, className = "" }: { items: Suggestion[]; className?: string }) {
  const shown = items.slice(0, 4);
  const more = items.length - shown.length;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {shown.map((s) => (
        <Link
          key={s.key}
          href={s.href}
          title={s.title}
          className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-xs transition ${s.urgent ? "bg-red-50 text-red-700 ring-1 ring-red-200 hover:bg-red-100" : "bg-white/80 text-gray-700 ring-1 ring-gray-200 hover:bg-white hover:text-gray-900"}`}
        >
          {s.urgent && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />}
          <span className="truncate">{s.label}</span>
          <ArrowUpRight className="h-3 w-3 shrink-0 opacity-50" />
        </Link>
      ))}
      {more > 0 && (
        <Link href="/applications" className="rounded-full px-2 py-1 text-xs text-gray-500 hover:text-gray-900">
          全部待办 +{more}
        </Link>
      )}
    </div>
  );
}

export default function SayBox({ onPrefs, suggestions = [] }: { onPrefs: (rules: PrefRule[], unclear: string) => void; suggestions?: Suggestion[] }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [last, setLast] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [reply, setReply] = useState<Reply | null>(null);
  const [hint] = useState(() => EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]);

  const ask = async (sentence: string, extra: { intent?: string; jobId?: string } = {}) => {
    const t = sentence.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr("");
    setReply(null);
    setLast(t);
    try {
      const r = await fetch("/api/native/say", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t, ...extra }) }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      setText("");
      if (r.kind === "prefs") onPrefs(r.rules ?? [], r.unclear ?? "");
      else if (r.kind === "resume") {
        setReply(r);
        router.push(`/apply/${r.job.jobId}?ask=${encodeURIComponent(r.instruction)}`);
      } else setReply(r);
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };

  const undoFact = async (id: string) => {
    await fetch("/api/native/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "delete", kind: "facts", id }) });
    setReply({ kind: "reply", text: "已撤销，没有记下这段经历。" });
  };

  return (
    <div className="mt-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
        }}
      >
        <div className={`rounded-3xl bg-white/60 ring-1 backdrop-blur-md transition ${busy ? "ring-gray-400" : "ring-gray-200 focus-within:ring-gray-400"}`}>
          <div className="flex items-end gap-3 pb-2.5 pl-5 pr-2.5 pt-4">
            <MessageCircle className="mb-auto mt-1 h-4 w-4 shrink-0 text-gray-400" aria-hidden />
            <textarea
              id="say-pref"
              rows={3}
              className="min-w-0 flex-1 resize-none bg-transparent text-sm leading-6 text-gray-900 outline-none placeholder:text-gray-500 sm:text-base"
              placeholder={`想看什么岗位、改哪份简历、问哪家公司，比如「${hint}」`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              // Enter 发送，Shift+Enter 换行；输入法选字时的 Enter 不算
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  ask(text);
                }
              }}
              disabled={busy}
              maxLength={300}
            />
            <button
              type="submit"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-900 text-white transition-transform hover:scale-105 active:scale-95 disabled:bg-gray-300 disabled:hover:scale-100 sm:h-10 sm:w-10"
              disabled={busy || !text.trim()}
              title={busy ? "理解中…" : "告诉 AI"}
              aria-label="告诉 AI"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4 sm:h-[18px] sm:w-[18px]" />}
            </button>
          </div>
          {suggestions.length > 0 && <SuggestionChips items={suggestions} className="border-t border-gray-900/5 px-4 pb-3 pt-2.5" />}
        </div>
      </form>
      {busy && (
        <p className="mt-1.5 flex items-center gap-1.5 px-2 text-xs text-gray-600">
          <Loader2 className="h-3 w-3 animate-spin" />
          AI 正在理解…
        </p>
      )}
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
      {reply && <ReplyCard reply={reply} last={last} onAsk={ask} onUndoFact={undoFact} onClose={() => setReply(null)} />}
    </div>
  );
}

function ReplyCard({
  reply,
  last,
  onAsk,
  onUndoFact,
  onClose,
}: {
  reply: Reply;
  last: string;
  onAsk: (t: string, extra?: { intent?: string; jobId?: string }) => void;
  onUndoFact: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="glass animate-fade-up mt-2 flex items-start gap-2 rounded-2xl px-4 py-3 text-left text-sm">
      <div className="min-w-0 flex-1">
        {reply.kind === "reply" && <p className="leading-6 text-slate-700">{reply.text}</p>}

        {reply.kind === "clarify" && (
          <>
            <p className="text-slate-700">{reply.text}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {reply.options.map((o) => (
                <button key={o.intent} className="rounded-full border border-slate-300 px-3 py-1 text-xs hover:border-accent hover:text-accent" onClick={() => onAsk(last, { intent: o.intent })}>
                  {o.label}
                </button>
              ))}
            </div>
          </>
        )}

        {reply.kind === "pick" && (
          <>
            <p className="text-slate-700">{reply.text}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {reply.options.map((o) => (
                <button key={o.jobId} className="rounded-full border border-slate-300 px-3 py-1 text-xs hover:border-accent hover:text-accent" onClick={() => onAsk(last, { intent: reply.intent, jobId: o.jobId })}>
                  {o.company} · {o.title}
                </button>
              ))}
            </div>
          </>
        )}

        {reply.kind === "fact" && (
          <p className="leading-6 text-slate-700">
            <Brain className="-mt-0.5 mr-1 inline h-4 w-4" />
            <b>记住了：</b>「{reply.fact.text}」。之后写简历时可以作为依据。
            <button className="ml-2 text-xs text-slate-500 underline hover:text-red-600" onClick={() => onUndoFact(reply.fact.id)}>
              不对，撤销
            </button>
          </p>
        )}

        {reply.kind === "resume" && (
          <p className="text-slate-700">
            正在打开 <b>{reply.job.company}</b> · {reply.job.title} 的工作台，按你说的修改…
          </p>
        )}

        {reply.kind === "company" && <CompanyAnswer job={reply.job} initial={reply.brief} />}
      </div>
      <button className="shrink-0 text-gray-400 hover:text-gray-700" onClick={onClose} aria-label="关闭">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** 公司速览：有缓存直接显示；还在生成就每 3 秒看一次，生成好了自动换上 */
function CompanyAnswer({ job, initial }: { job: JobRef; initial: CompanyBrief }) {
  const [b, setB] = useState(initial);
  const generating = b.status === "generating";
  useEffect(() => {
    if (!generating) return;
    const t = setInterval(() => {
      fetch(`/api/native/apply/${job.jobId}/brief`)
        .then((r) => r.json())
        .then((d: { brief?: CompanyBrief }) => {
          if (d.brief && d.brief.status !== "generating") setB(d.brief);
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [generating, job.jobId]);

  if (generating)
    return (
      <p className="flex items-center gap-2 text-accent">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/25 border-t-accent" />
        正在了解 {job.company}…
      </p>
    );
  if (b.status === "failed") return <p className="text-red-600">没能生成 {job.company} 的公司速览：{b.error}</p>;
  return (
    <div className="space-y-1.5 leading-6 text-slate-700">
      <p>
        <b>{job.company}</b>：{b.intro}
      </p>
      {b.businessLine && <p className="text-slate-600">这个岗位所在的业务：{b.businessLine}</p>}
      {b.facts.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-slate-600">
          {b.facts.slice(0, 3).map((f) => (
            <li key={f.text}>{f.text}</li>
          ))}
        </ul>
      )}
      <p className="flex flex-wrap items-center gap-x-3 text-xs text-slate-400">
        <span>{b.basis === "联网" ? `联网 · ${b.refs.length} 个来源` : b.basis === "模型知识" ? "模型知识，未联网核实" : "示例"}</span>
        <Link href={`/apply/${job.jobId}`} className="text-accent hover:underline">
          打开 {job.title} 的工作台 →
        </Link>
      </p>
    </div>
  );
}
