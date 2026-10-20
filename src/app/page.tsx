"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { animate, AnimatePresence, motion, useMotionValue, useTransform } from "motion/react";
import { Brain, Check, RefreshCw, Star, Table2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import MemoryDrawer from "@/components/MemoryDrawer";
import { UploadGate } from "@/components/Onboarding";
import SayBox, { SuggestionChips, type Suggestion } from "@/components/SayBox";
import type { Agenda } from "@/lib/agenda";
import { directionReason, roleFocus } from "@/lib/native/role-focus";
import { cardScore } from "@/lib/native/score";
import type { FeedCard, InsightView, PrefRule, SwipeAction } from "@/lib/native/types";

type Feed = {
  deck: FeedCard[];
  stats: { applied: number; skipped: number; saved: number; learned: string[]; appliedCompanies: string[] };
  goal: number; // 今天有效投递满这么多家公司就不再推
  focus: Focus | null; // 今天优先看什么；null = 今天还没回答
  focusCount: number;
  focusOptions: { directions: string[]; keywords: string[] };
  newToday: number;
  savedCount: number;
  nickname: string;
  sampleJobs: boolean;
  sampleCards: boolean;
  onboard: "upload" | null; // 第一次使用：还没有经历卡片时先上传简历
  autoFocus: { directions: string[]; sectors: string[]; why: string; by: "AI" | "规则" } | null; // 刚按经历自动设好的方向
  skipReasons: string[];
  rules: PrefRule[];
  llm: boolean;
};

type Focus = { directions: string[]; keywords: string[] };

const WEEK = "日一二三四五六";
const CARD = "rounded-3xl bg-white ring-1 ring-gray-200";
const ICON_BTN = "glass flex h-9 w-9 items-center justify-center rounded-full text-gray-700 transition hover:bg-white hover:text-gray-900";

export default function FeedPage() {
  const router = useRouter();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [deck, setDeck] = useState<FeedCard[]>([]);
  const [done, setDone] = useState<{ card: FeedCard; action: SwipeAction }[]>([]);
  const [flipped, setFlipped] = useState(false);
  const [askReason, setAskReason] = useState<FeedCard | null>(null);
  const [learned, setLearned] = useState<{ rules: PrefRule[]; unclear?: string } | null>(null);
  const [launch, setLaunch] = useState<{ card: FeedCard; rect: DOMRect } | null>(null);
  const [showMemory, setShowMemory] = useState(false);
  const [withSaved, setWithSaved] = useState(false);
  const [keepGoing, setKeepGoing] = useState(false);
  const [editFocus, setEditFocus] = useState(false);
  const [today] = useState(() => new Date());
  const topRef = useRef<HTMLDivElement>(null);
  const chips = useBriefChips(today);
  const flyRef = useRef<((dir: SwipeAction) => void) | null>(null);

  const load = useCallback((saved = false) => {
    fetch(`/api/native/feed${saved ? "?saved=1" : ""}`)
      .then((r) => r.json())
      .then((d: Feed) => {
        setFeed(d);
        setDeck(d.deck);
        setDone([]);
      });
  }, []);
  useEffect(() => load(), [load]);

  const top = deck[0];

  // 预取：最上面两张在后台抓 JD、生成公司速览
  const topId = top?.job.id;
  const nextId = deck[1]?.job.id;
  useEffect(() => {
    if (!topId) return;
    fetch("/api/native/prefetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobIds: [topId, nextId].filter(Boolean) }) })
      .then((r) => r.json())
      .then((d: { insights?: Record<string, InsightView>; jds?: Record<string, string> }) => {
        // AI 分析出的匹配理由、差距、找到的 JD 回来了：直接换到卡片上，按 JD 分析过的重算分数
        const ins = d.insights ?? {};
        const jds = d.jds ?? {};
        setDeck((deck) =>
          deck.map((c) => {
            let n = c;
            const x = ins[c.job.id];
            if (x) {
              n = { ...n, reasons: x.reasons.length ? x.reasons : n.reasons, gaps: x.gaps ?? [], analyzed: true };
              if (x.gaps) n = { ...n, ...cardScore(x.reasons.length, x.gaps.length) };
            }
            if (jds[c.job.id]) n = { ...n, jdPreview: jds[c.job.id] };
            return n;
          }),
        );
      })
      .catch(() => undefined);
  }, [topId, nextId]);

  const showLearned = useCallback((r: PrefRule | null) => {
    if (r) setLearned({ rules: [r] });
  }, []);

  const commit = useCallback(
    async (card: FeedCard, action: SwipeAction) => {
      setDeck((d) => d.filter((c) => c.job.id !== card.job.id));
      setDone((d) => [...d, { card, action }]);
      setFlipped(false);
      if (action === "skip") setAskReason(card);
      else setAskReason(null);
      const r = await fetch("/api/native/feed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: card.job.id, action }),
      }).then((x) => x.json());
      showLearned(r.learned);
    },
    [showLearned],
  );

  const apply = useCallback(
    (card: FeedCard) => {
      const rect = topRef.current?.getBoundingClientRect();
      fetch("/api/native/feed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: card.job.id, action: "apply" }) });
      if (rect) setLaunch({ card, rect });
      setTimeout(() => router.push(`/apply/${card.job.id}`), 420);
    },
    [router],
  );

  const undo = useCallback(async () => {
    const last = done.at(-1);
    if (!last) return;
    await fetch("/api/native/feed", { method: "DELETE" });
    setDone((d) => d.slice(0, -1));
    setDeck((d) => [last.card, ...d]);
    setAskReason(null);
    setLearned(null);
  }, [done]);

  // 键盘：← 跳过  → 投递  ↑ 稍后再看  空格 翻面  Z 撤回
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (launch || showMemory || (e.target as HTMLElement)?.closest("input,textarea")) return;
      if (e.key === "z" || e.key === "Z") return void undo();
      if (!top) return;
      if (e.key === "ArrowLeft") flyRef.current?.("skip");
      else if (e.key === "ArrowRight") flyRef.current?.("apply");
      else if (e.key === "ArrowUp") flyRef.current?.("save");
      else if (e.key === " ") setFlipped((f) => !f);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [top, undo, launch, showMemory]);

  // 左滑理由 6 秒后自动收起
  useEffect(() => {
    if (!askReason) return;
    const t = setTimeout(() => setAskReason(null), 6000);
    return () => clearTimeout(t);
  }, [askReason]);
  useEffect(() => {
    if (!learned) return;
    const t = setTimeout(() => setLearned(null), 8000);
    return () => clearTimeout(t);
  }, [learned]);

  async function sendReason(card: FeedCard, reason: string) {
    setAskReason(null);
    const r = await fetch("/api/native/feed", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: card.job.id, reasons: [reason] }) }).then((x) => x.json());
    showLearned(r.learned);
    if (r.learned) load(withSaved); // 规则变了，重新排序
  }

  async function saveFocus(f: Focus) {
    setEditFocus(false);
    await fetch("/api/native/feed", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
    load(withSaved);
  }

  async function revokeRules(rules: PrefRule[]) {
    setLearned(null);
    for (const rule of rules) await fetch("/api/native/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "delete", kind: "rules", id: rule.id }) });
    if (rules.some((r) => r.from === "一句话")) load(withSaved); // 一句话设的偏好立刻生效过，撤销后也立刻恢复原来的排序
  }

  /** 一句话设偏好：拆出的规则已经存好，重新排序并告诉用户记住了什么 */
  function onSaid(rules: PrefRule[], unclear: string) {
    if (rules.length) load(withSaved);
    setLearned(rules.length || unclear ? { rules, unclear } : null);
  }

  if (!feed) return <p className="text-sm text-slate-500">加载中…</p>;
  // 第一次使用：还没有经历卡片，先上传简历
  if (feed.onboard === "upload")
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center pt-4 text-center sm:pt-8">
        <h1 className="animate-fade-up text-[40px] font-normal leading-[1.05] tracking-tight text-gray-900 min-[400px]:text-[44px] sm:text-6xl">Hi, {feed.nickname || "你好"}</h1>
        <p className="animate-fade-up mt-3 text-sm text-gray-600 [animation-delay:100ms] sm:text-base">第一次来？花两分钟导入简历，之后就能直接刷岗位。</p>
        <UploadGate />
      </div>
    );
  const total = done.length + deck.length;
  const stats = {
    applied: feed.stats.applied + done.filter((d) => d.action === "apply").length,
    skipped: feed.stats.skipped + done.filter((d) => d.action === "skip").length,
  };
  // 有效投递：今天在官网提交了的公司（同一家只算一次）；右滑只是想投，提交后回到这里才计数
  const appliedCompanies = feed.stats.appliedCompanies.length;
  const reached = appliedCompanies >= feed.goal;
  // 不再每天主动问「今天优先看什么」：方向在第一次使用时确认过，临时调整用一句话设偏好；只在用户点「指定方向」时打开
  const asking = editFocus;
  const showDeck = !asking && deck.length > 0 && (!reached || keepGoing);
  const focusOn = Boolean(feed.focus && (feed.focus.directions.length || feed.focus.keywords.length));

  return (
    <div className="mx-auto flex max-w-xl flex-col">
      <header className="flex flex-col items-center pt-4 text-center sm:pt-8 short:pt-0!">
        <h1 className="animate-fade-up text-[40px] font-normal leading-[1.05] tracking-tight text-gray-900 min-[400px]:text-[44px] sm:text-6xl short:text-4xl! tiny:text-3xl!">Hi, {feed.nickname || "你好"}</h1>
        <div className="animate-fade-up mt-2 flex items-center justify-center gap-2 text-sm text-gray-500 [animation-delay:100ms]">
          <span className="mr-1">
            {today.getMonth() + 1} 月 {today.getDate()} 日 · 周{WEEK[today.getDay()]}
          </span>
          <Link href="/jobs" className={ICON_BTN} title="表格视图：查看全部岗位，调整投递的方向、行业和找岗位的关键词；回来后岗位流按新的设置排序" aria-label="表格视图">
            <Table2 className="h-4 w-4" />
          </Link>
          <button className={ICON_BTN} onClick={() => setShowMemory(true)} title="AI 记住的事：从你的选择里学到的偏好" aria-label="AI 记住的事">
            <Brain className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* 今天优先的方向：卡片上方一行小字（今天的投递进度在「投递」按钮的圆环上） */}
      {!asking && feed.focus && (
        <p className="animate-fade-up mt-6 flex items-center justify-center text-xs text-gray-600 [animation-delay:340ms] short:mt-3!">
          <span
            className="min-w-0 truncate"
            title={feed.autoFocus ? `${feed.autoFocus.by === "AI" ? "AI 读了你的经历" : "按你的经历"}，先推「${[...feed.autoFocus.directions, ...feed.autoFocus.sectors].join("、")}」的岗位${feed.autoFocus.why ? `（${feed.autoFocus.why}）` : ""}。想换方向，直接在下面说一句。` : undefined}
          >
            {focusOn ? (
              <>
                优先：<span className="text-gray-900">{[...feed.focus.directions, ...feed.focus.keywords].join("、")}</span>
                {top && !top.badges.includes("今日优先") && <span className="text-gray-400"> · 已看完</span>}
              </>
            ) : (
              "什么方向都看"
            )}
            <button className="ml-2 text-gray-900 underline-offset-2 hover:underline" onClick={() => setEditFocus(true)}>
              {focusOn ? "改" : "指定方向"}
            </button>
          </span>
        </p>
      )}

      {(feed.sampleJobs || feed.sampleCards) && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
          {feed.sampleJobs && (
            <>
              岗位库还是空的，下面是<b>示例岗位</b>（虚构公司）。去 <Link href="/jobs" className="underline">表格视图</Link> 导入表格或同步校招公司清单。
            </>
          )}
          {feed.sampleCards && (
            <>
              {" "}
              还没有经历卡片，匹配理由用的是示例经历，<Link href="/import" className="underline">导入简历</Link>后会换成你的。
            </>
          )}
        </p>
      )}

      {/* 卡片堆 */}
      <div className={`animate-hero-rise relative h-[440px] [animation-delay:620ms] short:h-[360px]! tiny:h-[300px]! ${!asking && feed.focus ? "mt-3 short:mt-2!" : "mt-6 short:mt-3!"}`}>
        {asking ? (
          <FocusAsk options={feed.focusOptions} initial={feed.focus} onDone={saveFocus} onCancel={editFocus ? () => setEditFocus(false) : undefined} />
        ) : !showDeck ? (
          <Summary
            feed={feed}
            stats={stats}
            companies={appliedCompanies}
            left={reached ? deck.length : 0}
            onMore={() => setKeepGoing(true)}
            onSaved={() => (setWithSaved(true), load(true))}
          />
        ) : (
          deck
            .slice(0, 3)
            .reverse()
            .map((card, i, arr) => {
              const depth = arr.length - 1 - i;
              return depth === 0 ? (
                <TopCard
                  key={card.job.id}
                  ref={topRef}
                  card={card}
                  flipped={flipped}
                  onFlip={() => setFlipped((f) => !f)}
                  registerFly={(fn) => (flyRef.current = fn)}
                  onSwiped={(action) => (action === "apply" ? apply(card) : commit(card, action))}
                  hidden={Boolean(launch)}
                  llm={feed.llm}
                />
              ) : (
                <motion.div
                  key={card.job.id}
                  className={`absolute inset-0 shadow-sm ${CARD}`}
                  initial={false}
                  animate={{ scale: 1 - depth * 0.04, y: depth * 14, opacity: 1 - depth * 0.25 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                >
                  <CardFront card={card} dim llm={feed.llm} />
                </motion.div>
              );
            })
        )}
      </div>

      {/* 操作按钮 */}
      {showDeck && (
        // pb-9：投递按钮下面挂着「0/5 家」的标签（绝对定位，伸出按钮下方约 36px），给它留出位置，免得压住对话框
        <div className="mt-7 flex items-center justify-center gap-4 pb-9 short:mt-4!">
          <RoundBtn label="撤回" hint="Z" onClick={undo} disabled={!done.length} small>
            <Undo2 className="h-4 w-4" />
          </RoundBtn>
          <RoundBtn label="跳过" hint="←" onClick={() => flyRef.current?.("skip")} tone="skip">
            <X className="h-6 w-6" />
          </RoundBtn>
          <RoundBtn label="稍后再看" hint="↑" onClick={() => flyRef.current?.("save")} small>
            <Star className="h-4 w-4" />
          </RoundBtn>
          <RoundBtn
            label="投递"
            hint="→"
            onClick={() => flyRef.current?.("apply")}
            tone="apply"
            progress={{ done: appliedCompanies, goal: feed.goal, note: `${withSaved ? "现在看的是稍后再看 + 新岗位" : feed.newToday ? `今天 ${feed.newToday} 个新岗位` : `${total} 个岗位待看`}${feed.rules.length ? `，已按你的 ${feed.rules.length} 条偏好排序` : ""}` }}
          >
            <Check className="h-6 w-6" />
          </RoundBtn>
          <RoundBtn label="翻面" hint="空格" onClick={() => setFlipped((f) => !f)} small>
            <RefreshCw className="h-4 w-4" />
          </RoundBtn>
        </div>
      )}

      {/* 对话框：放在卡片下面；邮件、面试、截止等待办作为建议放在输入框下面 */}
      <div className="animate-fade-up [animation-delay:760ms]">
        {feed.llm ? <SayBox onPrefs={onSaid} suggestions={chips} /> : chips.length > 0 && <SuggestionChips items={chips} className="glass mt-4 rounded-3xl px-4 py-3" />}
      </div>

      {/* 左滑理由 & 记住了 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex flex-col items-center gap-2 px-4">
        <AnimatePresence>
          {askReason && (
            <motion.div
              key="reason"
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 30, opacity: 0 }}
              className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-2xl bg-gray-900/90 px-4 py-2.5 text-sm text-white shadow-lg backdrop-blur-xl"
            >
              <span className="text-slate-300">为什么跳过「{askReason.job.company}」？</span>
              {feed.skipReasons.map((r) => {
                // 方向理由写明是哪个细分方向（整车、硬件…），学的就是它，不是整个产品经理职能；职位名里看不出就不显示这个按钮
                const label = r === directionReason("") ? directionReason(roleFocus(askReason.job.title, askReason.job.company)) : r;
                if (label === directionReason("") && r === label) return null;
                return (
                  <button key={r} onClick={() => sendReason(askReason, label)} className="rounded-full bg-white/10 px-2.5 py-1 text-xs hover:bg-white/25">
                    {label}
                  </button>
                );
              })}
            </motion.div>
          )}
          {learned && (
            <motion.div
              key="learned"
              initial={{ y: 30, opacity: 0, scale: 0.95 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 30, opacity: 0 }}
              className="pointer-events-auto flex items-center gap-3 rounded-2xl bg-white/80 px-4 py-2.5 text-sm shadow-lg ring-1 ring-gray-200 backdrop-blur-xl"
            >
              <span className="min-w-0">
                {learned.rules.length > 0 && (
                  <>
                    <Brain className="-mt-0.5 mr-1 inline h-4 w-4" />
                    <b>记住了：</b>
                    {learned.rules.map((r) => r.text).join("；")}
                  </>
                )}
                {learned.unclear && <span className={`block text-xs text-slate-500 ${learned.rules.length ? "mt-0.5" : ""}`}>{learned.rules.length ? "这部分没听懂：" : "没听懂，换个说法试试："}{learned.unclear}</span>}
              </span>
              {learned.rules.length > 0 && (
                <button onClick={() => revokeRules(learned.rules)} className="shrink-0 text-xs text-slate-500 underline hover:text-red-600">
                  不对，撤销
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>


      {/* 右滑：卡片放大成工作台 */}
      <AnimatePresence>
        {launch && (
          <motion.div
            className="fixed z-50 overflow-hidden rounded-3xl bg-white shadow-2xl"
            initial={{ top: launch.rect.top, left: launch.rect.left, width: launch.rect.width, height: launch.rect.height }}
            animate={{ top: 0, left: 0, width: "100vw", height: "100vh", borderRadius: 0 }}
            transition={{ duration: 0.4, ease: [0.3, 0.7, 0.2, 1] }}
          >
            <div className="p-8">
              <p className="text-sm text-accent">准备投递</p>
              <h2 className="mt-1 text-2xl font-semibold">{launch.card.job.company}</h2>
              <p className="mt-1 text-slate-600">{launch.card.job.title}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {showMemory && <MemoryDrawer onClose={() => (setShowMemory(false), load(withSaved))} />}
    </div>
  );
}

/* ---------------- 最上面那张：可拖动、可翻面 ---------------- */

function TopCard({
  card,
  flipped,
  onFlip,
  onSwiped,
  registerFly,
  hidden,
  llm,
  ref,
}: {
  card: FeedCard;
  llm: boolean;
  flipped: boolean;
  onFlip: () => void;
  onSwiped: (a: SwipeAction) => void;
  registerFly: (fn: (a: SwipeAction) => void) => void;
  hidden: boolean;
  ref: React.Ref<HTMLDivElement>;
}) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-300, 300], [-16, 16]);
  const applyOpacity = useTransform(x, [30, 130], [0, 1]);
  const skipOpacity = useTransform(x, [-130, -30], [1, 0]);
  const saveOpacity = useTransform(y, [-130, -40], [1, 0]);
  const dragged = useRef(false);
  const flying = useRef(false);

  const fly = useCallback(
    (a: SwipeAction) => {
      if (flying.current) return;
      flying.current = true;
      if (a === "apply") {
        // 投递：先轻轻右移，然后由外层放大成工作台
        animate(x, 60, { duration: 0.15 });
        setTimeout(() => onSwiped(a), 150);
        return;
      }
      const w = typeof window === "undefined" ? 800 : window.innerWidth;
      const target = a === "skip" ? { x: -w, y: 60 } : { x: 0, y: -900 };
      animate(x, target.x, { duration: 0.35 });
      animate(y, target.y, { duration: 0.35 });
      // 不等动画的 Promise：拖动结束时 motion 自己的收尾动画可能打断它，Promise 就不会返回
      setTimeout(() => onSwiped(a), 350);
    },
    [x, y, onSwiped],
  );
  useEffect(() => {
    registerFly(fly);
  }, [fly, registerFly]);

  return (
    <motion.div
      ref={ref}
      className="absolute inset-0 cursor-grab touch-none select-none active:cursor-grabbing"
      style={{ x, y, rotate, opacity: hidden ? 0 : 1, perspective: 1200 }}
      drag
      dragMomentum={false}
      onDragStart={() => (dragged.current = true)}
      onDragEnd={(_, info) => {
        const { offset, velocity } = info;
        // 等 motion 处理完拖动结束，再开始飞出去
        if (offset.x > 120 || velocity.x > 700) requestAnimationFrame(() => fly("apply"));
        else if (offset.x < -120 || velocity.x < -700) requestAnimationFrame(() => fly("skip"));
        else if (offset.y < -120 || velocity.y < -700) requestAnimationFrame(() => fly("save"));
        else {
          // 没拖够：弹回原位
          animate(x, 0, { type: "spring", stiffness: 400, damping: 30 });
          animate(y, 0, { type: "spring", stiffness: 400, damping: 30 });
        }
        setTimeout(() => (dragged.current = false), 50);
      }}
      onClick={() => !dragged.current && onFlip()}
      initial={{ scale: 0.96, y: 14 }}
      animate={{ scale: 1, y: 0 }}
    >
      <motion.div className="relative h-full w-full" style={{ transformStyle: "preserve-3d" }} animate={{ rotateY: flipped ? 180 : 0 }} transition={{ duration: 0.45 }}>
        <div className={`absolute inset-0 shadow-[0_20px_60px_rgba(0,0,0,0.12)] ${CARD}`} style={{ backfaceVisibility: "hidden" }}>
          <CardFront card={card} llm={llm} />
          <Stamp text="投" className="left-6 top-6 -rotate-12 border-emerald-500 text-emerald-500" style={{ opacity: applyOpacity }} />
          <Stamp text="跳过" className="right-6 top-6 rotate-12 border-slate-400 text-slate-400" style={{ opacity: skipOpacity }} />
          <Stamp text="稍后" className="bottom-24 left-1/2 -translate-x-1/2 border-amber-500 text-amber-500" style={{ opacity: saveOpacity }} />
        </div>
        <div className={`absolute inset-0 shadow-[0_20px_60px_rgba(0,0,0,0.12)] ${CARD}`} style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}>
          <CardBack card={card} />
        </div>
      </motion.div>
    </motion.div>
  );
}

function Stamp({ text, className, style }: { text: string; className: string; style: { opacity: unknown } }) {
  return (
    <motion.span
      className={`pointer-events-none absolute rounded-xl border-4 px-3 py-1 text-2xl font-black tracking-widest ${className}`}
      style={style as never}
    >
      {text}
    </motion.span>
  );
}

/* ---------------- 每日简报 → 对话框里的建议：今天和明天要做的事（和「我的投递」的 30 天日程同一份数据） ---------------- */

function useBriefChips(today: Date): Suggestion[] {
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  useEffect(() => {
    fetch("/api/agenda")
      .then((r) => r.json())
      .then(setAgenda)
      .catch(() => undefined);
  }, []);
  if (!agenda) return [];

  const day = (offset: number) => {
    const d = new Date(today.getTime() + offset * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const [d0, d1] = [day(0), day(1)];
  const open = agenda.items.filter((i) => !i.done); // 打勾划掉的不再提醒
  const soon = open.filter((i) => i.urgent || i.at.startsWith(d0) || i.at.startsWith(d1));
  const week = open.filter((i) => i.kind === "网申截止" && !soon.includes(i) && i.at.slice(0, 10) <= day(7)).length;
  const toPractice = open.filter((i) => i.prep === "ready" && !i.practiced && !soon.includes(i));
  const { pendingMails } = agenda;
  const when = (at: string) => `${at.startsWith(d0) ? "今天" : at.startsWith(d1) ? "明天" : `${Number(at.slice(5, 7))}月${Number(at.slice(8, 10))}日`}${at.endsWith("23:59") ? "" : ` ${at.slice(11, 16)}`}`;

  const chips: Suggestion[] = soon.map((i) => {
    const deadline = i.kind === "网申截止";
    const href = !deadline && i.appId && i.prep ? `/prep/${i.appId}` : deadline && i.jobId ? `/apply/${i.jobId}` : "/applications";
    const act = deadline ? "截止" : i.prep === "ready" ? (i.practiced ? `${i.kind} · 再练一遍` : `${i.kind} · 去练`) : i.kind;
    return { key: i.key, label: `${when(i.at)} ${i.company} ${act}`, title: `${i.company}${i.title ? ` · ${i.title}` : ""}${i.saved ? "（稍后再看的）" : ""}`, href, urgent: i.urgent };
  });
  if (pendingMails.total > 0)
    chips.push({ key: "mails", label: `确认 ${pendingMails.total} 封招聘邮件${pendingMails.interviews ? `（${pendingMails.interviews} 封面试）` : ""}`, href: "/applications", urgent: pendingMails.interviews > 0 });
  if (toPractice.length > 0)
    chips.push({ key: "practice", label: `练 ${toPractice.length} 场准备好的面试`, href: toPractice.length === 1 && toPractice[0].appId ? `/prep/${toPractice[0].appId}` : "/applications" });
  if (week > 0) chips.push({ key: "week", label: `看看未来一周 ${week} 个网申截止`, href: "/applications" });
  // 两周没动静的公司不在首页提示，只在「我的投递」里看
  return chips;
}

function CardFront({ card, dim, llm }: { card: FeedCard; dim?: boolean; llm: boolean }) {
  const { job } = card;
  return (
    <div className={`flex h-full flex-col p-7 short:p-5! tiny:p-4! ${dim ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap gap-1.5">
        {card.badges.map((b) => (
          <span key={b} className={`rounded-full px-2.5 py-0.5 text-xs ${b.startsWith("🔥") ? "bg-red-50 text-red-600" : b === "新" ? "bg-accent-soft text-accent" : "bg-slate-100 text-slate-600"}`}>
            {b}
          </span>
        ))}
        {card.sample && <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs text-amber-700">示例</span>}
      </div>
      <div className="mt-6 flex items-start justify-between gap-4 short:mt-3!">
        <div className="min-w-0">
          <p className="text-sm text-slate-500">{job.company}</p>
          <h2 className="mt-1 text-2xl font-semibold leading-snug">{job.title}</h2>
        </div>
        <div className="flex shrink-0 flex-col items-center">
          <Ring score={card.score} />
          <span
            className="mt-1 text-[11px] text-slate-400"
            title={card.scoreBasis === "证据" ? "按 JD 对照你的素材：看重的点里有几条找得到证据、差几条" : "还没按 JD 分析，按方向、行业和关键词粗估"}
          >
            {card.scoreBasis === "证据" ? "按 JD" : "粗估"}
          </span>
        </div>
      </div>
      <dl className="mt-6 grid grid-cols-2 gap-y-3 text-sm short:mt-3! short:gap-y-2! tiny:gap-y-1!">
        <Info k="地点" v={job.location || "未注明"} />
        <Info k="截止" v={job.deadline || "未注明"} />
        <Info k="批次" v={job.batch || "—"} />
        <Info k="行业" v={job.industry || "—"} />
      </dl>
      <div className="mt-auto">
        {card.reasons.length > 0 ? (
          <p className="line-clamp-2 text-sm text-slate-600">
            <span className="text-accent">匹配：</span>
            {card.reasons.map((r) => r.need).join(" · ")}
          </p>
        ) : (
          <p className="text-sm text-slate-400">{llm && !card.analyzed && !dim ? "AI 正在对照你的经历和资料…" : "素材库里暂时没找到对得上的经历"}</p>
        )}
        {card.gaps.length > 0 && (
          <p className="mt-1 line-clamp-1 text-sm text-slate-600">
            <span className="text-amber-600">差距：</span>
            {card.gaps.join(" · ")}
          </p>
        )}
        <p className="mt-3 text-center text-xs text-slate-400 tiny:hidden">点一下翻面，看为什么推给你</p>
      </div>
    </div>
  );
}

function CardBack({ card }: { card: FeedCard }) {
  return (
    <div className="flex h-full flex-col overflow-hidden p-7 short:p-5!">
      <p className="text-xs font-medium text-slate-500">为什么推给你</p>
      {card.reasons.length ? (
        <ul className="mt-3 space-y-3">
          {card.reasons.map((r, i) => (
            <li key={i} className="text-sm">
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-xs text-accent">岗位要「{r.need}」</span>
              {r.source && <span className="ml-1.5 text-[11px] text-slate-400">{r.source === "AI 分析" ? "AI 分析" : r.source === "素材资料" ? "来自你的资料" : "来自经历原句"}</span>}
              <p className="mt-1 border-l-2 border-accent/40 pl-2 text-slate-700">你有：{r.have}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-slate-500">主要按你的方向和偏好推荐。</p>
      )}
      {card.gaps.length > 0 && (
        <>
          <p className="mt-5 text-xs font-medium text-slate-500">还差什么</p>
          <ul className="mt-2 space-y-1.5">
            {card.gaps.map((g) => (
              <li key={g} className="text-sm text-slate-700">
                <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">JD 看重「{g}」</span>
                <span className="ml-1.5 text-xs text-slate-500">素材里没找到证据</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-5 text-xs font-medium text-slate-500">JD</p>
      <p className="mt-1 min-h-0 flex-1 overflow-hidden whitespace-pre-line text-sm leading-6 text-slate-600 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
        {card.jdPreview || "JD 还在找：会依次试网申页面、用浏览器打开、联网搜索。右滑进工作台也能看到进度，找不到可以用「剪藏 JD」一键带回。"}
      </p>
      {card.job.link && (
        <a href={card.job.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="mt-2 text-xs text-accent hover:underline">
          打开原始链接 ↗
        </a>
      )}
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{k}</dt>
      <dd className="mt-0.5 truncate text-slate-800">{v}</dd>
    </div>
  );
}

function Ring({ score }: { score: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-16 w-16 shrink-0" title="匹配分：你的经历和这个岗位对得上多少（你的偏好只影响卡片顺序，不算进分数）">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="#e2e8f0" strokeWidth="6" />
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--color-accent)" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="text-lg font-semibold">{score}</span>
        <span className="text-[10px] text-slate-400">匹配</span>
      </span>
    </div>
  );
}

function RoundBtn({
  children,
  label,
  hint,
  onClick,
  tone,
  small,
  disabled,
  progress,
}: {
  children: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  tone?: "skip" | "apply";
  small?: boolean;
  disabled?: boolean;
  progress?: { done: number; goal: number; note: string }; // 今天的有效投递进度：画成按钮外的圆环
}) {
  const color = tone === "apply" ? "bg-gray-900 text-white shadow-gray-900/30" : "bg-white text-gray-600 ring-1 ring-gray-200";
  const button = (
    <motion.button
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.92 }}
      onClick={onClick}
      disabled={disabled}
      title={progress ? `${label}（${hint}）· 今天在官网提交了 ${progress.done}/${progress.goal} 家（同一家只算一次）。${progress.note}` : `${label}（${hint}）`}
      aria-label={label}
      className={`flex items-center justify-center rounded-full shadow-md disabled:opacity-30 ${color} ${small ? "h-11 w-11" : "h-16 w-16"}`}
    >
      {children}
    </motion.button>
  );
  if (!progress) return button;
  const r = 39;
  const c = 2 * Math.PI * r;
  const ratio = Math.min(1, progress.done / progress.goal);
  return (
    <div className="relative flex items-center justify-center">
      <svg viewBox="0 0 88 88" className="pointer-events-none absolute -inset-3 h-[88px] w-[88px] -rotate-90 drop-shadow-sm" aria-hidden>
        <circle cx="44" cy="44" r={r} fill="none" stroke="white" strokeWidth="5" />
        <motion.circle cx="44" cy="44" r={r} fill="none" stroke="#10b981" strokeWidth="5" strokeLinecap="round" strokeDasharray={c} initial={false} animate={{ strokeDashoffset: c * (1 - ratio) }} />
      </svg>
      {button}
      <span className="glass pointer-events-none absolute -bottom-9 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium tabular-nums text-gray-900">
        {progress.done}/{progress.goal} 家
      </span>
    </div>
  );
}

function Summary({
  feed,
  stats,
  companies,
  left,
  onMore,
  onSaved,
}: {
  feed: Feed;
  stats: { applied: number; skipped: number };
  companies: number;
  left: number; // 投够了但还有没看的岗位
  onMore: () => void;
  onSaved: () => void;
}) {
  const reached = companies >= feed.goal;
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass flex h-full flex-col items-center justify-center rounded-3xl p-8 text-center">
      <p className="text-3xl">{reached ? "🎉" : "📭"}</p>
      <h2 className="mt-2 text-lg font-semibold">{reached ? `今天投够 ${feed.goal} 家了` : "岗位看完了"}</h2>
      <p className="mt-2 text-sm text-slate-600">
        今天在官网提交了 <b className="text-accent">{companies}</b> 家，右滑想投 {stats.applied} 个，跳过 {stats.skipped} 个
      </p>
      {!reached && (
        <p className="mt-2 text-xs text-slate-500">
          还差 {feed.goal - companies} 家。可以去
          <Link href="/jobs" className="mx-0.5 text-accent underline">
            表格视图
          </Link>
          放宽方向、行业，或点「立即更新」同步更多公司
        </p>
      )}
      {feed.stats.learned.length > 0 && (
        <div className="mt-4 max-w-sm rounded-xl bg-accent-soft px-4 py-3 text-left text-sm text-slate-700">
          <p className="text-xs font-medium text-accent">今天学到的偏好</p>
          <ul className="mt-1 list-disc pl-4">
            {feed.stats.learned.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-6 flex gap-2">
        {left > 0 && (
          <button className="btn-ghost" onClick={onMore}>
            继续看（还有 {left} 个）
          </button>
        )}
        {feed.savedCount > 0 && (
          <button className="btn-ghost" onClick={onSaved}>
            看看稍后再看的 {feed.savedCount} 个
          </button>
        )}
        <Link href="/applications" className="btn-primary">
          去我的投递
        </Link>
      </div>
    </motion.div>
  );
}

/** 每天第一次打开：今天优先看什么方向？选了的排在最前面，都不选就按平常的顺序推 */
function FocusAsk({
  options,
  initial,
  onDone,
  onCancel,
}: {
  options: { directions: string[]; keywords: string[] };
  initial: Focus | null;
  onDone: (f: Focus) => void;
  onCancel?: () => void;
}) {
  const [dirs, setDirs] = useState<string[]>(initial?.directions ?? []);
  const [kws, setKws] = useState<string[]>(initial?.keywords ?? []);
  const [custom, setCustom] = useState("");
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const extra = kws.filter((k) => !options.keywords.includes(k));
  const chip = (on: boolean) => `rounded-full px-3 py-1 text-sm transition ${on ? "bg-accent text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`;
  function addCustom() {
    const v = custom.trim();
    if (v && !kws.includes(v)) setKws([...kws, v]);
    setCustom("");
  }
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className={`flex h-full flex-col p-6 shadow-sm ${CARD}`}>
      <h2 className="text-lg font-semibold">今天优先看什么方向？</h2>
      <p className="mt-1 text-xs text-slate-500">选了的排在最前面，看完再推其他的。可以多选。</p>
      <p className="mt-5 text-xs font-medium text-slate-500">方向</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.directions.map((d) => (
          <button key={d} className={chip(dirs.includes(d))} onClick={() => toggle(dirs, setDirs, d)}>
            {d}
          </button>
        ))}
      </div>
      <p className="mt-5 text-xs font-medium text-slate-500">关键词（来自你的经历）</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {[...options.keywords, ...extra].map((k) => (
          <button key={k} className={chip(kws.includes(k))} onClick={() => toggle(kws, setKws, k)}>
            {k}
          </button>
        ))}
        <input
          className="w-28 rounded-full border border-dashed border-slate-300 px-3 py-1 text-sm outline-none focus:border-accent"
          placeholder="+ 自己写"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCustom()}
          onBlur={addCustom}
        />
      </div>
      <div className="mt-auto flex gap-2 pt-6">
        <button className="btn-primary flex-1" disabled={!dirs.length && !kws.length} onClick={() => onDone({ directions: dirs, keywords: kws })}>
          就看这些
        </button>
        <button className="btn-ghost" onClick={() => onDone({ directions: [], keywords: [] })}>
          都行
        </button>
        {onCancel && (
          <button className="btn-ghost" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </motion.div>
  );
}
