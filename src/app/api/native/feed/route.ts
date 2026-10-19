import { llmConfig } from "@/lib/extract";
import { readLibrary } from "@/lib/store";
import { readTracker, updateTracker } from "@/lib/tracker-store";
import { resumeKeywords } from "@/lib/campus-search";
import { buildDeck, learnFromSwipe, liveRules, SKIP_REASONS, submittedToday, todayStats, undoLastSwipe } from "@/lib/native/feed";
import { autoFocus, autoFocusNote, onboardStep } from "@/lib/native/onboard";
import { allJobs, findJobForMe } from "@/lib/native/jobs";
import { SAMPLE_CARDS, SAMPLE_JOBS } from "@/lib/native/samples";
import { loadDocs } from "@/lib/native/insight";
import { insightView, readInsight, readJd, readMemory, updateMemory } from "@/lib/native/store";
import type { InsightView } from "@/lib/native/types";
import type { SwipeAction } from "@/lib/native/types";
import { DEFAULT_MY_SECTORS, DIRECTIONS, type Direction } from "@/lib/tracker-types";

/** 每天的目标：有效投递（今天在官网提交了的公司，同一家只算一次）满这么多家就不再推 */
const DAILY_GOAL = 5;

/** 岗位流：还没滑过的岗位，按匹配度和你的偏好排好；不限张数，页面上推到今天有效投递满 DAILY_GOAL 家为止 */
export async function GET(req: Request) {
  const includeSaved = new URL(req.url).searchParams.get("saved") === "1";
  // 刚导入完简历、还没有方向：AI 按经历推断一次并直接生效，再排岗位流
  await autoFocus().catch((e) => console.error("[auto-focus]", e));
  const [{ jobs, sample }, d, lib, mem] = await Promise.all([allJobs(), readTracker(), readLibrary(), readMemory()]);
  const jdText: Record<string, string> = {};
  const insights: Record<string, InsightView> = {};
  for (const j of jobs) {
    const ins = await readInsight(j.id);
    if (ins) insights[j.id] = insightView(ins);
    const s = SAMPLE_JOBS.find((x) => x.id === j.id);
    if (s) jdText[j.id] = s.jd;
    else {
      const jd = await readJd(j.id);
      if (jd?.status === "ok") jdText[j.id] = jd.text;
    }
  }
  const cards = lib.cards.length ? lib.cards : SAMPLE_CARDS;
  // 今天优先看什么：只在当天有效，第二天重新问
  const f = d.settings.todayFocus;
  const focus = f && f.date === localDay() ? { directions: f.directions, keywords: f.keywords } : undefined;
  const docs = lib.cards.length ? await loadDocs(lib) : [];
  const deck = buildDeck({ jobs, jdText, insights, docs, apps: d.applications, mem, cards, myDirections: d.settings.myDirections, mySectors: d.settings.mySectors ?? DEFAULT_MY_SECTORS, focus, includeSaved });
  if (includeSaved) deck.sort((a, b) => Number(b.badges.includes("稍后再看")) - Number(a.badges.includes("稍后再看")));
  const today = new Date().toISOString().slice(0, 10);
  return Response.json({
    deck: deck.map((c) => ({ ...c, sample: sample || undefined })),
    stats: { ...todayStats(mem), appliedCompanies: submittedToday(d.applications) },
    goal: DAILY_GOAL,
    focus: focus ?? null, // null = 今天还没回答
    focusCount: deck.filter((c) => c.badges.includes("今日优先")).length,
    focusOptions: { directions: DIRECTIONS.filter((x) => x !== "其他" && x !== "技术"), keywords: resumeKeywords(lib.cards.map((c) => c.role ?? ""), 5) },
    newToday: deck.filter((c) => c.job.createdAt.slice(0, 10) === today).length,
    savedCount: mem.swipes.filter((s) => s.action === "save").length,
    nickname: mem.profile.nickname,
    sampleJobs: sample,
    sampleCards: !lib.cards.length,
    onboard: onboardStep(lib.cards.length), // 第一次使用：还没有经历卡片时先上传简历
    autoFocus: autoFocusNote(d.settings), // 当天按经历自动设好的方向（首页说明一句按什么推的）

    skipReasons: SKIP_REASONS,
    rules: liveRules(mem),
    llm: llmConfig().enabled,
  });
}

/** 滑一张：记下来，并看看能不能学到新偏好 */
export async function POST(req: Request) {
  const b = (await req.json()) as { jobId: string; action: SwipeAction; reasons?: string[] };
  const job = await findJobForMe(b.jobId);
  if (!job) return Response.json({ error: "岗位不存在" }, { status: 404 });
  const learned = await updateMemory((m) => {
    // 同一个岗位再滑一次（例如"稍后再看"之后）以最新一次为准
    m.swipes = m.swipes.filter((s) => s.jobId !== job.id);
    return learnFromSwipe(m, {
      jobId: job.id,
      action: b.action,
      reasons: b.reasons ?? [],
      at: new Date().toISOString(),
      company: job.company,
      title: job.title,
      directions: job.directions,
      location: job.location,
      overseas: job.overseas,
    });
  });
  return Response.json({ learned });
}

/** 补充左滑理由（左滑后几秒内点的） */
export async function PATCH(req: Request) {
  const b = (await req.json()) as { jobId: string; reasons: string[] };
  const learned = await updateMemory((m) => {
    const i = m.swipes.findIndex((s) => s.jobId === b.jobId);
    if (i < 0) return null;
    const [s] = m.swipes.splice(i, 1);
    return learnFromSwipe(m, { ...s, reasons: b.reasons });
  });
  return Response.json({ learned });
}

/** 回答「今天优先看什么方向」；都不选 = 都行 */
export async function PUT(req: Request) {
  const b = (await req.json()) as { directions?: string[]; keywords?: string[] };
  const focus = {
    date: localDay(),
    directions: (b.directions ?? []).filter((x): x is Direction => (DIRECTIONS as readonly string[]).includes(x)),
    keywords: (b.keywords ?? []).map((k) => String(k).trim()).filter(Boolean).slice(0, 6),
  };
  await updateTracker((t) => {
    t.settings.todayFocus = focus;
  });
  return Response.json({ focus });
}

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 撤回上一张 */
export async function DELETE() {
  const last = await updateMemory((m) => undoLastSwipe(m));
  return Response.json({ undone: last });
}
