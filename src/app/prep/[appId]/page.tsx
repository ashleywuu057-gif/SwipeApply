"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeech } from "@/components/useSpeech";
import type { CompanyBrief, PrepData, PrepMatch, PrepPlan, PrepSession, PrepTurn } from "@/lib/native/types";
import type { Report, Research, Source } from "@/lib/research/types";

type ResearchView = { id: string; status: Research["status"]; stalled: boolean; error?: string; last: string; usage: Research["usage"]; report: Report | null; sources: Source[] };
type Data = { prep: PrepData | null; brief: CompanyBrief | null; research: ResearchView | null; app: { id: string; company: string; title: string; stage: string } | null };
const JSONH = { "Content-Type": "application/json" };

export default function PrepPage() {
  const { appId } = useParams<{ appId: string }>();
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    fetch(`/api/prep/${appId}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : setData(d)));
  }, [appId]);
  useEffect(load, [load]);

  // 准备中每 3 秒、深度调研进行中每 5 秒刷新一次进度
  const preparing = data?.prep?.status === "preparing";
  const rs = data?.research;
  const researching = Boolean(rs && !rs.stalled && rs.status !== "完成" && rs.status !== "失败");
  useEffect(() => {
    if (!preparing && !researching) return;
    const t = setInterval(load, preparing ? 3000 : 5000);
    return () => clearInterval(t);
  }, [preparing, researching, load]);

  async function prepare() {
    await fetch(`/api/prep/${appId}`, { method: "POST", headers: JSONH, body: "{}" });
    setTimeout(load, 500);
  }

  if (err) return <p className="text-sm text-red-600">{err}</p>;
  if (!data) return <p className="text-sm text-slate-500">加载中…</p>;
  const { prep, brief, research, app } = data;

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/applications" className="text-sm text-slate-500 hover:text-slate-800">
        ← 我的投递
      </Link>
      <header className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">
            {prep?.company ?? app?.company} · {prep?.round ?? "面试"}准备
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {prep?.title || app?.title}
            {prep?.jobTitle && prep.jobTitle !== prep.title && <span className="ml-1 text-xs text-slate-400">（按岗位库里的「{prep.jobTitle}」准备的，不对的话在「我的投递」里填上岗位名再重新准备）</span>}
            {prep && !prep.jobTitle && prep.status === "ready" && <span className="ml-1 text-xs text-slate-400">（岗位库里没对上具体岗位，按公司和岗位名联网找的 JD）</span>}
            {prep?.scheduledAt && <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">{fmt(prep.scheduledAt)}</span>}
            {prep?.link && (
              <a href={prep.link} target="_blank" rel="noreferrer" className="ml-2 text-accent hover:underline">
                面试链接 ↗
              </a>
            )}
          </p>
        </div>
        {prep && prep.status !== "preparing" && (
          <button className="btn-ghost" onClick={prepare} title="重新找 JD、挑经历、出题；练过的记录会保留">
            重新准备
          </button>
        )}
      </header>

      {!prep && (
        <section className="panel mt-6 p-6 text-center">
          <p className="text-sm text-slate-600">还没有准备这场面试。我会找 JD、生成公司速览、挑出你最匹配的经历，再出一套题陪你练。</p>
          <button className="btn-primary mt-4" onClick={prepare}>
            开始准备
          </button>
        </section>
      )}
      {prep?.status === "preparing" && (
        <section className="panel mt-6 p-6 text-center text-sm text-slate-600">
          <p className="animate-pulse">正在准备：{prep.step ?? "…"}</p>
          <p className="mt-2 text-xs text-slate-400">找 JD 可能要打开网页或联网搜索，一般一两分钟。可以在这里等，也可以先去忙，准备好了首页简报里会提示。</p>
        </section>
      )}
      {prep?.status === "failed" && (
        <section className="panel mt-6 p-6 text-center text-sm">
          <p className="text-red-600">准备失败：{prep.error}</p>
          <button className="btn-primary mt-4" onClick={prepare}>
            再试一次
          </button>
        </section>
      )}

      {prep?.status === "ready" && prep.plan && <PlanView plan={prep.plan} research={research} />}

      {prep && prep.status !== "failed" && (research || prep.researchNote) && (
        // 准备稿写好了：业务内容都在「二、公司业务」里，这里只留一行调研状态
        <ResearchPanel r={research} note={prep.researchNote} compact={Boolean(prep.plan && !prep.plan.error)} />
      )}

      {prep?.status === "ready" && (
        <>
          <Practice prep={prep} onChange={(p) => setData({ ...data, prep: p })} />

          <section className="mt-6 grid gap-4 md:grid-cols-2">
            <div className="panel p-4">
              <h2 className="font-medium">你最匹配的经历</h2>
              <p className="mt-0.5 text-xs text-slate-500">按 JD 从你的简历原句和资料证据里挑的，回答时优先用这些</p>
              <ul className="mt-3 space-y-2.5">
                {prep.matches.map((m) => (
                  <MatchItem key={m.ref} m={m} />
                ))}
              </ul>
            </div>
            <div className="space-y-4">
              <div className="panel p-4">
                <h2 className="font-medium">题目清单</h2>
                <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
                  {prep.questions.map((q) => (
                    <li key={q.id}>
                      {q.q}
                      <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[11px] ${q.from === "调研" ? "bg-sky-50 text-sky-700" : "bg-slate-100 text-slate-500"}`}>
                        {q.focus}
                        {q.from === "调研" && " · 来自调研"}
                      </span>
                      {q.refs.length > 0 && <span className="ml-1 text-[11px] text-accent">可用素材 {q.refs.length} 条</span>}
                    </li>
                  ))}
                </ol>
              </div>
              {brief?.status === "ready" && (
                <div className="panel p-4 text-sm">
                  <h2 className="font-medium">公司速览</h2>
                  <p className="mt-2 leading-6 text-slate-700">{brief.intro}</p>
                  {brief.businessLine && (
                    <p className="mt-2 leading-6 text-slate-700">
                      <span className="text-xs text-slate-400">业务条线　</span>
                      {brief.businessLine}
                    </p>
                  )}
                  {brief.products.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {brief.products.map((x) => (
                        <li key={x.name}>
                          <span className="font-medium">{x.name}</span>
                          <span className="text-slate-600">：{x.desc}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <details className="panel p-4 text-sm">
                <summary className="cursor-pointer font-medium">
                  JD {prep.jd.text ? "" : "（没找到）"}
                  {prep.jd.text && !prep.jobTitle && prep.jd.by !== "手动" && <span className="ml-1 text-xs font-normal text-amber-700">联网搜到的，先核对一下</span>}
                  {prep.jd.warn && <span className="ml-1 text-xs font-normal text-amber-700">{prep.jd.warn}</span>}
                </summary>
                {prep.jd.text && !prep.jobTitle && prep.jd.by !== "手动" && (
                  <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                    这份 JD 是按公司和岗位名联网搜到的，可能不是你投的那个岗位（比如往年的、实习的）。不对的话，把真实 JD 贴到下面，我按它重新准备。
                  </p>
                )}
                <JdPaste appId={prep.appId} onDone={() => location.reload()} />
                {prep.jd.text ? (
                  <p className="mt-2 whitespace-pre-line leading-6 text-slate-600">{prep.jd.text}</p>
                ) : (
                  <p className="mt-2 text-slate-500">没找到这个岗位的 JD，题目按岗位名和公司业务出的。</p>
                )}
                {prep.jd.url && (
                  <a href={prep.jd.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-accent hover:underline">
                    JD 来源 ↗
                  </a>
                )}
              </details>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/* ---------------- 面试准备稿 ---------------- */

const KIND_STYLE: Record<string, string> = { 数字口径: "bg-amber-50 text-amber-700", 个人贡献: "bg-sky-50 text-sky-700", 重来: "bg-violet-50 text-violet-700" };

function PlanView({ plan, research }: { plan: PrepPlan; research: ResearchView | null }) {
  const mat = (ref: string) => plan.materials.find((m) => m.ref === ref);
  const src = (n: number) => research?.sources.find((s) => s.id === n);
  if (plan.error)
    return (
      <section className="panel mt-6 p-4 text-sm">
        <h2 className="font-medium">面试准备稿</h2>
        <p className="mt-1 text-xs text-red-600">没写出来：{plan.error}。点右上角「重新准备」再试一次。</p>
      </section>
    );
  const researching = research && !research.stalled && research.status !== "完成" && research.status !== "失败";

  return (
    <section className="panel mt-6 p-5">
      <h2 className="font-medium">面试准备稿</h2>
      <p className="mt-0.5 text-xs text-slate-500">按 JD 从你的素材里挑重点：先备好追问，再补业务，最后练表达。追问里的数字都核对过出自你的素材。</p>

      {/* 一、简历深挖 */}
      <h3 className="mt-5 text-sm font-semibold">一、简历深挖：每段经历备好“追问三连”</h3>
      <div className="mt-2 space-y-3">
        {plan.deepDive.map((d, i) => (
          <div key={d.cardId} className="rounded-lg border border-slate-200 p-3 text-sm">
            <p className="font-medium">
              {i + 1}. {d.label}
              {d.points.length > 0 && <span className="ml-2 text-xs font-normal text-slate-400">对应 JD 第 {d.points.map((x) => x + 1).join("、")} 条</span>}
            </p>
            {d.why && <p className="mt-1 text-xs leading-5 text-slate-500">{d.why}</p>}
            <ul className="mt-2 space-y-1.5">
              {d.questions.map((q, j) => (
                <li key={j} className="leading-6">
                  <span className={`mr-1.5 rounded px-1.5 py-0.5 text-[11px] ${KIND_STYLE[q.kind] ?? "bg-slate-100 text-slate-500"}`}>{q.kind}</span>
                  {q.q}
                  {q.status === "待核对" && <span className="ml-1 text-xs text-red-600">（待核对：{q.issue}）</span>}
                  {q.refs.length > 0 && (
                    <details className="ml-1 inline text-xs text-slate-500">
                      <summary className="inline cursor-pointer text-accent">依据</summary>
                      {q.refs.map((r) => (
                        <span key={r} className="mt-1 block border-l-2 border-accent/40 pl-2">
                          {mat(r)?.text}
                        </span>
                      ))}
                    </details>
                  )}
                </li>
              ))}
            </ul>
            {d.transfer && <p className="mt-2 rounded bg-accent-soft px-2 py-1.5 text-xs leading-5 text-accent">迁移讲法：{d.transfer}</p>}
          </div>
        ))}
      </div>
      {plan.risks.length > 0 && (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm">
          <p className="text-xs font-medium text-amber-800">风险点：JD 写了、你的素材里证明不了的</p>
          <ul className="mt-1.5 space-y-2">
            {plan.risks.map((r, i) => (
              <li key={i}>
                <span className="font-medium">{r.need}</span>
                {r.why && <span className="text-xs text-amber-800">　{r.why}</span>}
                <ul className="mt-0.5 list-disc pl-5 text-xs leading-5 text-slate-700">
                  {r.prep.map((x, j) => (
                    <li key={j}>{x}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 二、公司业务 */}
      <h3 className="mt-6 text-sm font-semibold">二、公司业务：要能说出最新情况</h3>
      {!plan.business ? (
        <p className="mt-2 text-xs text-slate-500">
          {researching ? "深度调研还在进行，做完后这里会自动补上（最新情况、业务拆解、业务题答题思路）。" : research?.status === "完成" ? "这部分没写出来，点「重新准备」再试一次。" : "需要深度调研的结果；调研没有完成，这部分暂时空着。"}
        </p>
      ) : (
        <div className="mt-2 space-y-3 text-sm">
          <ul className="list-disc space-y-1 pl-5">
            {plan.business.facts.map((f, i) => (
              <li key={i} className="leading-6">
                {f.text}
                {f.refs.map((n) => (
                  <a key={n} href={src(n)?.url} target="_blank" rel="noreferrer" title={src(n) ? `${src(n)!.title}（${src(n)!.site}）` : ""} className="ml-0.5 text-xs text-accent hover:underline">
                    [{n}]
                  </a>
                ))}
              </li>
            ))}
          </ul>
          {(plan.business.model || plan.business.formulas.length > 0) && (
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">团队可能在做什么（推断，面试时可以反问确认）</p>
              {plan.business.model && <p className="mt-1 leading-6">{plan.business.model}</p>}
              {plan.business.formulas.map((f, i) => (
                <p key={i} className="mt-1 font-mono text-xs text-slate-700">
                  {f}
                </p>
              ))}
            </div>
          )}
          <ol className="list-decimal space-y-2 pl-5">
            {plan.business.questions.map((q, i) => (
              <li key={i}>
                <span className="font-medium">{q.q}</span>
                <p className="text-xs leading-5 text-slate-600">{q.approach}</p>
                {q.use.map((r) => (
                  <p key={r} className="mt-0.5 border-l-2 border-accent/40 pl-2 text-xs leading-5 text-slate-500">
                    可以用：{mat(r)?.label}　{mat(r)?.text}
                  </p>
                ))}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* 三、表达 */}
      <h3 className="mt-6 text-sm font-semibold">三、表达</h3>
      <dl className="mt-2 space-y-2 text-sm">
        {plan.pitch.whyRole && (
          <div>
            <dt className="text-xs text-slate-500">为什么选这个岗位</dt>
            <dd className="leading-6">“{plan.pitch.whyRole}”</dd>
          </div>
        )}
        {plan.pitch.intro && (
          <div>
            <dt className="text-xs text-slate-500">1 分钟自我介绍主线{plan.pitch.focus.length > 0 && `（重点讲：${plan.pitch.focus.join("、")}）`}</dt>
            <dd className="leading-6">{plan.pitch.intro}</dd>
          </div>
        )}
        {plan.pitch.ask.length > 0 && (
          <div>
            <dt className="text-xs text-slate-500">反问</dt>
            <dd>
              <ol className="list-decimal pl-5 leading-6">
                {plan.pitch.ask.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ol>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/* ---------------- 深度调研 ---------------- */

const MATCH_STYLE = { 强: "bg-accent-soft text-accent", 中: "bg-sky-50 text-sky-700", 弱: "bg-amber-50 text-amber-700" } as const;

function ResearchPanel({ r, note, compact }: { r: ResearchView | null; note?: string; compact?: boolean }) {
  if (!r)
    return (
      <section className="panel mt-6 p-4 text-sm">
        <h2 className="font-medium">深度调研</h2>
        <p className="mt-1 text-xs text-slate-500">{note}</p>
      </section>
    );
  const running = !r.stalled && r.status !== "完成" && r.status !== "失败";
  if (compact)
    return (
      <p className="mt-3 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
        <span>
          深度调研：
          {r.stalled ? "中断了（工作台重启过），点「重新准备」再跑" : r.status === "失败" ? `失败（${r.error}）` : running ? <span className="animate-pulse">{r.status === "排队中" ? "排队中" : r.last || "进行中"}</span> : "已完成"}
          {` · 搜索 ${r.usage.searches} 次，读了 ${r.usage.reads} 个网页，${r.usage.accepted} 条发现`}
        </span>
      </p>
    );
  const rep = r.report;
  const refs = (ns: number[]) =>
    ns.map((n) => {
      const s = r.sources.find((x) => x.id === n);
      return s ? (
        <a key={n} href={s.url} target="_blank" rel="noreferrer" title={`${s.title}（${s.site}）`} className="ml-0.5 text-xs text-accent hover:underline">
          [{n}]
        </a>
      ) : null;
    });

  return (
    <section className="panel mt-6 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">
            深度调研
            <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-normal ${r.status === "完成" ? "bg-accent-soft text-accent" : r.status === "失败" || r.stalled ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"}`}>
              {r.stalled ? "中断" : r.status}
              {running && "…"}
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            搜索 {r.usage.searches} 次 · 读了 {r.usage.reads} 个网页 · 记录 {r.usage.accepted} 条发现（每条都核对过原文）
          </p>
        </div>
      </div>

      {running && (
        <p className="mt-3 text-sm text-slate-600">
          <span className="animate-pulse">{r.status === "排队中" ? "排队中，前面还有别的面试在调研" : r.last || "正在调研"}</span>
          <span className="mt-1 block text-xs text-slate-400">一般 3~8 分钟，可以先练题；做完后业务题会自动加进模拟面试。</span>
        </p>
      )}
      {r.stalled && <p className="mt-3 text-sm text-red-600">调研中断了（工作台重启过），点右上角「重新准备」再跑一次。</p>}
      {r.status === "失败" && <p className="mt-3 text-sm text-red-600">调研失败：{r.error}</p>}

      {rep && (
        <div className="mt-4 space-y-5 text-sm">
          {(rep.businessLine.position || rep.businessLine.conclusion) && (
            <div>
              <h3 className="text-xs font-medium text-slate-500">业务条线{rep.businessLine.type && ` · ${rep.businessLine.type}`}</h3>
              <p className="mt-1 leading-6 text-slate-700">{rep.businessLine.position}</p>
              {rep.businessLine.conclusion && <p className="mt-1 leading-6 text-accent">{rep.businessLine.conclusion}</p>}
            </div>
          )}

          {rep.jd.abilities.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-slate-500">JD 要点 × 你的证据</h3>
              <ul className="mt-2 space-y-2">
                {rep.jd.abilities.map((a, i) => (
                  <li key={i} className="rounded-lg border border-slate-200 p-2.5">
                    <span className="font-medium">{a.name}</span>
                    <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] ${MATCH_STYLE[a.match]}`}>匹配 {a.match}</span>
                    {a.detail && <p className="mt-0.5 text-xs text-slate-500">{a.detail}</p>}
                    {a.evidence.map((e, j) => (
                      <p key={j} className="mt-1.5 border-l-2 border-accent/40 pl-2 text-xs leading-5 text-slate-700">
                        <span className="text-slate-400">{e.label}：</span>
                        {e.quote}
                        {!e.verified && <span className="ml-1 text-amber-600">（非原句，请核对）</span>}
                      </p>
                    ))}
                    {a.gap && <p className="mt-1 text-xs text-amber-700">缺口：{a.gap}</p>}
                  </li>
                ))}
              </ul>
              {rep.jd.conclusion && <p className="mt-2 leading-6 text-accent">{rep.jd.conclusion}</p>}
            </div>
          )}

          {(rep.bizQuestions ?? []).length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-slate-500">业务题预判（已加进模拟面试）</h3>
              <ol className="mt-2 list-decimal space-y-2 pl-5">
                {rep.bizQuestions!.map((b, i) => (
                  <li key={i}>
                    {b.q}
                    <p className="text-xs leading-5 text-slate-500">
                      {b.why}
                      {refs(b.refs)}
                    </p>
                    {b.use.map((u, j) => (
                      <p key={j} className="mt-1 border-l-2 border-accent/40 pl-2 text-xs leading-5 text-slate-600">
                        <span className="text-slate-400">可以用 {u.label}：</span>
                        {u.quote}
                      </p>
                    ))}
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {rep.competitive.talkingPoints.length > 0 && (
              <div className="rounded-lg bg-slate-50 p-3">
                <h3 className="text-xs font-medium text-slate-500">可以主动讲的观点</h3>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {rep.competitive.talkingPoints.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
                {rep.competitive.conclusion && <p className="mt-2 text-xs leading-5 text-slate-500">竞品对比结论：{rep.competitive.conclusion}</p>}
              </div>
            )}
            {rep.homework.length > 0 && (
              <div className="rounded-lg bg-slate-50 p-3">
                <h3 className="text-xs font-medium text-slate-500">面试前要补的功课</h3>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {rep.homework.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {rep.warnings.length > 0 && (
            <details className="text-xs text-amber-800">
              <summary className="cursor-pointer">⚠ {rep.warnings.length} 条需要核对的地方</summary>
              <ul className="mt-1 space-y-0.5 pl-4">
                {rep.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

/** 贴真实 JD：存下来（之后不会被自动搜索覆盖），然后重新准备 */
function JdPaste({ appId, onDone }: { appId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [jd, setJd] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button className="mt-2 block text-xs text-accent hover:underline" onClick={() => setOpen(true)}>
        贴上真实 JD，重新准备
      </button>
    );
  return (
    <div className="mt-2 space-y-2">
      <textarea className="input h-32 text-xs leading-5" placeholder="把邮件或官网上的岗位职责和任职要求粘贴到这里" value={jd} onChange={(e) => setJd(e.target.value)} />
      <button
        className="btn-primary"
        disabled={busy || jd.trim().length < 20}
        onClick={async () => {
          setBusy(true);
          await fetch(`/api/prep/${appId}`, { method: "POST", headers: JSONH, body: JSON.stringify({ jd }) });
          onDone();
        }}
      >
        {busy ? "提交中…" : "用这份 JD 重新准备"}
      </button>
    </div>
  );
}

function MatchItem({ m }: { m: PrepMatch }) {
  return (
    <li className="text-sm">
      <p className="text-[11px] text-slate-400">{m.label}</p>
      {m.note && <p className="text-slate-700">{m.note}</p>}
      <p className={`border-l-2 border-accent/40 pl-2 leading-6 ${m.note ? "mt-1 text-xs text-slate-500" : "text-slate-700"}`}>{m.text}</p>
    </li>
  );
}

/* ---------------- 模拟面试 ---------------- */

function Practice({ prep, onChange }: { prep: PrepData; onChange: (p: PrepData) => void }) {
  const last = prep.sessions.at(-1);
  const [sessionId, setSessionId] = useState<string | null>(last && !last.done ? last.id : null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const speech = useSpeech(setText);
  const endRef = useRef<HTMLDivElement>(null);
  const session = prep.sessions.find((s) => s.id === sessionId) ?? null;
  const finished = [...prep.sessions].reverse().find((s) => s.done && s.summary);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [session?.turns.length, busy]);

  async function step(body: { sessionId?: string; answer?: string }) {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/prep/${prep.appId}/practice`, { method: "POST", headers: JSONH, body: JSON.stringify(body) });
      const d = (await r.json()) as { prep?: PrepData; session?: PrepSession; error?: string };
      if (!r.ok || !d.prep || !d.session) throw new Error(d.error ?? "出错了");
      onChange(d.prep);
      setSessionId(d.session.id);
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const a = text.trim();
    if (!a || !session || busy) return;
    if (speech.listening) speech.toggle(text);
    setText("");
    if (!(await step({ sessionId: session.id, answer: a }))) setText(a);
  }

  const asked = session ? session.turns.filter((t) => !t.followUp).length : 0;
  const current = session?.turns.at(-1);

  return (
    <section className="panel mt-6 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">模拟面试</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            AI 当面试官，一次问一道，{prep.questions.length} 道题，有时会追问。打字或语音回答，每题都会点评并指出你素材里能用上的经历。
          </p>
        </div>
        {(!session || session.done) && (
          <button className="btn-primary" disabled={busy} onClick={() => step({})}>
            {busy ? "准备中…" : prep.sessions.length ? "再练一遍" : "开始模拟面试"}
          </button>
        )}
      </div>

      {!session && finished && <Summary s={finished} />}

      {session && (
        <div className="mt-4 space-y-4">
          {session.turns.map((t, i) => (
            <Turn key={i} t={t} prep={prep} />
          ))}
          {busy && <p className="text-xs text-accent">面试官正在看你的回答…</p>}
          {session.done && session.summary && <Summary s={session} />}
          {!session.done && current && !current.answer && (
            <div className="rounded-xl border border-slate-200 p-3">
              <textarea
                className="input h-32 resize-y leading-6"
                placeholder={speech.listening ? "正在听…说完点 ■ 再提交" : "像在面试现场一样回答，说完整一点"}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
                }}
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs text-slate-400">
                  第 {asked}/{prep.questions.length} 题{current.followUp ? " · 追问" : ""} · Ctrl+Enter 提交
                </span>
                <div className="flex gap-2">
                  {speech.supported && (
                    <button
                      type="button"
                      onClick={() => speech.toggle(text)}
                      title={speech.listening ? "停止录音" : "语音回答（浏览器会把录音发到微软或谷歌的语音服务识别）"}
                      className={`flex h-10 w-10 items-center justify-center rounded-full border ${speech.listening ? "animate-pulse border-red-400 bg-red-50 text-red-600" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
                    >
                      {speech.listening ? "■" : "🎙"}
                    </button>
                  )}
                  <button className="btn-primary" disabled={busy || !text.trim()} onClick={submit}>
                    提交回答
                  </button>
                </div>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}
      {(err || speech.error) && <p className="mt-2 text-xs text-red-600">{err || speech.error}</p>}
    </section>
  );
}

function Turn({ t, prep }: { t: PrepTurn; prep: PrepData }) {
  const fb = t.feedback;
  return (
    <div className="space-y-2 text-sm">
      <p className="rounded-xl bg-slate-100 px-3 py-2 text-slate-800">
        <span className="mr-1 text-xs text-slate-500">{t.followUp ? "追问" : "面试官"}</span>
        {t.question}
      </p>
      {t.answer && <p className="ml-8 whitespace-pre-line rounded-xl bg-accent-soft px-3 py-2 text-slate-800">{t.answer}</p>}
      {fb && (
        <div className="ml-8 space-y-1.5 rounded-xl border border-slate-200 px-3 py-2">
          {fb.good && (
            <p>
              <span className="text-xs text-emerald-600">答得好　</span>
              {fb.good}
            </p>
          )}
          {fb.missing && (
            <p>
              <span className="text-xs text-amber-600">还缺　</span>
              {fb.missing}
            </p>
          )}
          {fb.use.length > 0 && (
            <div>
              <p className="text-xs text-accent">你素材里能用上的：</p>
              <ul className="mt-1 space-y-1">
                {fb.use.map((ref) => {
                  const m = prep.matches.find((x) => x.ref === ref);
                  return m ? (
                    <li key={ref} className="border-l-2 border-accent/40 pl-2 text-xs leading-5 text-slate-600">
                      <span className="text-slate-400">{m.label}：</span>
                      {m.note || m.text}
                    </li>
                  ) : null;
                })}
              </ul>
            </div>
          )}
          {fb.sample && (
            <p className="text-slate-700">
              <span className={`text-xs ${fb.sample.status === "可用" ? "text-slate-500" : "text-red-600"}`}>参考说法{fb.sample.status === "待核对" ? "（待核对）" : ""}　</span>
              {fb.sample.text}
              {fb.sample.issue && <span className="block text-xs text-red-600">{fb.sample.issue}</span>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Summary({ s }: { s: PrepSession }) {
  return (
    <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm">
      <p className="text-xs font-medium text-slate-500">总结 · {fmt(s.startedAt)} 那场</p>
      <p className="mt-1 whitespace-pre-line leading-6 text-slate-700">{s.summary}</p>
    </div>
  );
}

function fmt(s: string) {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getMonth() + 1}月${d.getDate()}日 周${"日一二三四五六"[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
