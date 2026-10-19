import "server-only";
import { newId } from "../store";
import { normCompany, sectorsOf } from "../tracker-logic";
import type { ExperienceCard } from "../types";
import type { Application, JobPosting } from "../tracker-types";
import { directionReason, focusFromReason, pickRole, resumeRoleWords, roleFocus, splitRoles } from "./role-focus";
import { cardScore, rankOf } from "./score";
import type { FeedCard, InsightView, MatchReason, MemoryData, PrefRule, Swipe } from "./types";

/**
 * 岗位流：从岗位库里挑出还没滑过、还没投过、没过期的岗位，按"和你有多匹配 + 你的偏好"排序。
 * 全部在本地计算（不调用模型），滑的时候不用等。
 */

// 能力关键词：JD 里出现、你的经历原句里也出现，就算一条匹配理由
const ABILITY_WORDS = [
  "海外", "出海", "本地化", "东南亚", "欧美", "北欧", "欧洲", "TikTok", "YouTube", "Instagram", "社媒", "KOL", "达人", "投放", "广告", "素材", "品牌", "传播", "文案",
  "内容", "小红书", "抖音", "短视频", "直播", "活动", "策划", "用户调研", "调研", "问卷", "竞品", "增长", "拉新", "留存", "转化", "数据分析", "SQL", "Python", "Excel",
  "看板", "A/B", "PRD", "需求", "电商", "游戏", "AI", "大模型", "英语", "小语种", "芬兰语", "翻译", "项目管理", "跨部门", "商务", "BD",
];

const ALIASES: Record<string, string[]> = {
  海外: ["北欧", "欧洲", "东南亚", "欧美", "国际", "TikTok", "Instagram", "YouTube"],
  社媒: ["TikTok", "Instagram", "YouTube", "Facebook", "X ", "社交媒体", "账号运营"],
  KOL: ["达人", "网红", "博主", "influencer"],
  数据分析: ["数据", "CTR", "点击率", "转化率", "看板", "SQL", "Excel"],
  用户调研: ["问卷", "访谈", "调研"],
  小语种: ["芬兰语", "德语", "法语", "西班牙语", "日语", "韩语", "北欧"],
};

export function has(text: string, word: string) {
  const t = text.toLowerCase();
  return [word, ...(ALIASES[word] ?? [])].some((w) => t.includes(w.toLowerCase()));
}

/**
 * 行业 / 领域词：岗位写的是"商用机器人"，你的资料写的是"具身智能"，也算对得上。
 * 同一组里任意一个词出现在岗位里、任意一个词出现在你的素材里，就是一条匹配理由。
 */
const DOMAINS: Record<string, string[]> = {
  具身智能: ["具身智能", "具身", "机器人", "人形机器人", "机械臂", "四足", "灵巧手", "Embodied", "robot"],
  "VR/AR": ["VR", "AR", "XR", "MR", "头显", "空间计算", "虚拟现实", "增强现实", "Vision Pro", "Quest"],
  智能硬件: ["智能硬件", "硬件", "消费电子", "IoT", "可穿戴", "智能家居", "耳机", "眼镜", "传感器"],
  "AI/大模型": ["AI", "人工智能", "大模型", "LLM", "AIGC", "Agent", "智能体", "生成式", "多模态", "RAG", "机器学习"],
  自动驾驶: ["自动驾驶", "智驾", "辅助驾驶", "新能源车", "汽车"],
  游戏: ["游戏", "手游", "端游", "二次元", "电竞"],
  电商: ["电商", "跨境电商", "零售", "独立站", "Shopee", "Amazon", "亚马逊", "Temu", "SHEIN"],
  出海: ["出海", "海外", "国际化", "全球化", "本地化"],
  消费品: ["快消", "消费品", "美妆", "食品饮料", "个护"],
  金融科技: ["金融科技", "支付", "Fintech", "银行", "保险"],
  "SaaS/企业服务": ["SaaS", "企业服务", "B端", "ToB", "云计算", "云服务"],
};

function hitWord(text: string, words: string[]) {
  const t = text.toLowerCase();
  return words.find((w) => {
    const lw = w.toLowerCase();
    // AI、AR 这类短英文词要按词边界匹配，免得 "SaaS"、"MAR" 里误中
    if (/^[a-z]{1,3}$/i.test(w)) return new RegExp(`(^|[^a-z])${lw}([^a-z]|$)`, "i").test(text);
    return t.includes(lw);
  });
}

/** 素材库里的一份资料（业务知识、项目复盘、工作文档），用来补充匹配理由 */
export interface EvidenceDoc {
  id: string;
  name: string;
  category?: string;
  cardId?: string | null;
  text: string; // 开头一段就够
}

export function matchReasons(jobText: string, cards: ExperienceCard[], docs: EvidenceDoc[] = [], max = 3): MatchReason[] {
  const out: MatchReason[] = [];
  const usedLines = new Set<string>();
  const usedNeeds = new Set<string>();
  const add = (r: MatchReason) => {
    if (out.length >= max || usedNeeds.has(r.need)) return;
    usedNeeds.add(r.need);
    out.push(r);
  };

  // 1. 领域 / 行业：先看经历原句，再看素材资料
  for (const [domain, words] of Object.entries(DOMAINS)) {
    const need = hitWord(jobText, words);
    if (!need) continue;
    let found = false;
    for (const c of cards) {
      const line = c.details.find((d) => hitWord(d, words) && !usedLines.has(d)) ?? (hitWord(`${c.company} ${c.role} ${c.summary}`, words) ? `${c.company} · ${c.role}` : undefined);
      if (!line) continue;
      usedLines.add(line);
      add({ need: domain, have: line, cardId: c.id, source: "经历原句" });
      found = true;
      break;
    }
    if (found) continue;
    const doc = docs.find((d) => hitWord(`${d.name}\n${d.text}`, words));
    if (doc) add({ need: domain, have: `${doc.category ?? "资料"}《${doc.name}》`, cardId: doc.cardId ?? undefined, source: "素材资料" });
  }

  // 2. 能力关键词：只看经历原句
  for (const w of ABILITY_WORDS) {
    if (out.length >= max) break;
    if (!jobText.toLowerCase().includes(w.toLowerCase())) continue;
    for (const c of cards) {
      const line = c.details.find((d) => has(d, w) && !usedLines.has(d));
      if (!line) continue;
      usedLines.add(line);
      add({ need: w, have: line, cardId: c.id, source: "经历原句" });
      break;
    }
  }
  return out;
}

/** 生效中的偏好规则：打开着，且没过期（"这周只看上海"过了周日就不再影响排序） */
export function liveRules(mem: Pick<MemoryData, "rules">, now = new Date()) {
  const today = localDay(now);
  return mem.rules.filter((r) => r.active && (!r.until || r.until >= today));
}

/** 岗位是否命中一条偏好规则 */
export function ruleHits(rule: PrefRule, job: Pick<JobPosting, "company" | "title" | "location" | "directions" | "overseas"> & Partial<Pick<JobPosting, "industry">>) {
  switch (rule.field) {
    case "direction":
      return job.directions.includes(rule.value as never);
    case "location":
      return Boolean(job.location) && job.location.includes(rule.value);
    case "company":
      return normCompany(job.company) === normCompany(rule.value);
    case "keyword": {
      // 岗位名和行业里都找（"C端""To B"这类说法常写在行业里）；不区分大小写、忽略空格和连字符
      const norm = (s: string) => s.toLowerCase().replace(/[\s\-_]/g, "");
      const k = norm(rule.value);
      return Boolean(k) && norm(`${job.title} ${job.industry ?? ""}`).includes(k);
    }
    case "overseas":
      return job.overseas === (rule.value === "true");
  }
}

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 用户要的方向，按重要程度排：对话框里说过的（一句话设的偏好、多推的）→ 今天指定的方向 → 投递方向。
 * 岗位名里列了一串大类时，用它挑出卡片上要写的那一个（pickRole）。
 */
export function roleWants(mem: MemoryData, focus: { directions: string[]; keywords: string[] } | undefined, myDirections: string[], now = new Date()): string[] {
  const said = liveRules(mem, now)
    .filter((r) => r.weight > 0 && (r.field === "direction" || r.field === "keyword"))
    .sort((a, b) => Number(b.from === "一句话") - Number(a.from === "一句话") || b.weight - a.weight)
    .map((r) => r.value);
  return [...new Set([...said, ...(focus?.keywords ?? []), ...(focus?.directions ?? []), ...myDirections])];
}

/** 飞书招聘的岗位详情页，例如 https://xiaopeng.jobs.feishu.cn/campus/position/7671116719527725353/detail */
const FEISHU_POSITION = /\.jobs\.feishu\.cn\/\S*position\/\d{10,}/;

export function buildDeck(opts: {
  jobs: JobPosting[];
  jdText: Record<string, string>; // 已经抓到的 JD
  insights?: Record<string, InsightView>; // AI 分析过的匹配理由和差距（预取时生成；reasons 空数组 = 分析过但没找到）
  docs?: EvidenceDoc[];
  apps: Application[];
  mem: MemoryData;
  cards: ExperienceCard[];
  myDirections: string[];
  mySectors?: string[]; // 我的行业（岗位库里设置），属于这些行业的往前排
  focus?: { directions: string[]; keywords: string[] }; // 今天优先看的方向，命中的排在最前面
  includeSaved?: boolean;
  now?: Date;
}): FeedCard[] {
  const { jobs, jdText, apps, mem, cards, myDirections } = opts;
  const now = opts.now ?? new Date();
  const today = localDay(now);
  const swiped = new Map(mem.swipes.map((s) => [s.jobId, s.action]));
  const appliedCompanies = new Set(apps.map((a) => normCompany(a.company)).filter((c) => c.length >= 2));
  const appliedJobs = new Set(apps.flatMap((a) => [a.jobId, ...(a.jobIds ?? [])]));
  const rules = liveRules(mem, now);
  const wants = roleWants(mem, opts.focus, myDirections, now);
  const resumeWords = resumeRoleWords(cards.map((c) => c.role ?? ""));

  const out: FeedCard[] = [];
  for (const raw of jobs) {
    // 只推飞书招聘（字节的招聘系统）上的具体岗位：插件只接了它，能一键填表；只有官网入口、要自己去官网扒的不推（用户定的）。
    // 其他岗位还在岗位库 / 表格视图里
    // 示例岗位（岗位库还空着时给新用户看的）不受这个限制
    if (raw.source !== "示例" && !FEISHU_POSITION.test(`${raw.link ?? ""} ${(raw as JobPosting & { jdUrl?: string }).jdUrl ?? ""}`)) continue;
    // 岗位名是一串大类的（公司官网入口）：卡片上只写最对口的一个
    const job = splitRoles(raw.title).length ? { ...raw, title: pickRole(raw.title, wants, resumeWords) } : raw;
    const s = swiped.get(job.id);
    if (s && !(s === "save" && opts.includeSaved)) continue;
    if (appliedJobs.has(job.id) || appliedCompanies.has(normCompany(job.company))) continue;
    if (job.deadlineAt && job.deadlineAt < today) continue;

    const text = `${job.title} ${job.industry} ${job.note} ${jdText[job.id] ?? ""}`;
    const ai = opts.insights?.[job.id];
    const reasons = ai?.reasons.length ? ai.reasons : matchReasons(text, cards, opts.docs ?? []);
    // 方向、行业、偏好规则、临近截止：打分时的调整项
    let adjust = 0;
    if (myDirections.length && job.directions.some((d) => myDirections.includes(d))) adjust += 15;
    if (opts.mySectors?.length && sectorsOf(job).some((x) => opts.mySectors!.includes(x))) adjust += 10;
    for (const r of rules) if (ruleHits(r, job)) adjust += r.weight;
    const badges: string[] = [];
    if (job.deadlineAt) {
      const days = Math.round((new Date(job.deadlineAt).getTime() - new Date(today).getTime()) / 86400000);
      if (days <= 7) {
        badges.push(days === 0 ? "🔥 今天截止" : `🔥 ${days} 天后截止`);
        adjust += 5;
      }
    }
    // 按 JD 分析过：用 AI 对上的点数（不用规则兜底的理由）和差距算分
    const gaps = ai?.gaps ?? null;
    const { score, scoreBasis } = cardScore(gaps === null ? reasons.length : ai!.reasons.length, gaps?.length ?? null);
    if (job.createdAt.slice(0, 10) >= localDay(new Date(now.getTime() - 2 * 86400000))) badges.push("新");
    if (job.overseas) badges.push("海外");
    if (s === "save") badges.push("稍后再看");
    if (job.siteOnly) badges.push("只有官网入口");
    const focusHit = Boolean(
      opts.focus &&
        (job.directions.some((d) => opts.focus!.directions.includes(d)) || opts.focus.keywords.some((k) => `${job.title} ${job.industry}`.toLowerCase().includes(k.toLowerCase()))),
    );
    if (focusHit) badges.unshift("今日优先");
    out.push({
      job,
      score,
      scoreBasis,
      adjust,
      reasons,
      gaps: gaps ?? [],
      badges,
      jdPreview: jdText[job.id]?.slice(0, 400),
      analyzed: Boolean(ai),
    });
  }
  // 今天优先看的方向在最前；其次具体岗位，只有官网入口的公司条目（要自己去官网找岗位）排在后面
  const focusFirst = (c: FeedCard) => Number(!c.badges.includes("今日优先"));
  return out.sort(
    (a, b) =>
      focusFirst(a) - focusFirst(b) ||
      Number(Boolean(a.job.siteOnly)) - Number(Boolean(b.job.siteOnly)) ||
      rankOf(b) - rankOf(a) ||
      (a.job.deadlineAt ?? "9").localeCompare(b.job.deadlineAt ?? "9"),
  );
}

/* ---------------- 从滑动里学习（长期记忆） ---------------- */

export const SKIP_REASONS = ["地点不合适", "不想做这个方向", "对公司不感兴趣", "要求不匹配"] as const;

/**
 * 记下一次滑动，并看看能不能学到新的偏好。
 * 返回这次新学到的规则（前端弹"记住了：…"，可以撤销）。
 */
export function learnFromSwipe(mem: MemoryData, swipe: Swipe): PrefRule | null {
  mem.swipes.push(swipe);
  const at = swipe.at;
  const make = (p: Omit<PrefRule, "id" | "active" | "createdAt" | "bySwipe">): PrefRule | null => {
    if (mem.rules.some((r) => r.field === p.field && r.value === p.value && Math.sign(r.weight) === Math.sign(p.weight))) return null;
    const rule: PrefRule = { ...p, id: newId(), active: true, createdAt: at, bySwipe: swipe.jobId };
    mem.rules.push(rule);
    return rule;
  };

  // 1. 左滑时点了理由：直接学
  if (swipe.action === "skip") {
    if (swipe.reasons.includes("对公司不感兴趣")) return make({ text: `不再推「${swipe.company}」的岗位`, field: "company", value: swipe.company, weight: -100, from: "跳过理由" });
    if (swipe.reasons.includes("地点不合适") && swipe.location) {
      const city = swipe.location.split(/[、,，/\s]/)[0];
      return make({ text: `少推工作地点在${city}的岗位`, field: "location", value: city, weight: -15, from: "跳过理由" });
    }
    // 「不想做这个方向」指的是职能词前面的细分方向（整车、硬件、泊车…），不是产品经理这个职能（用户明确说过）。
    // 职位名里看不出细分方向时（例如只写「产品经理」）不学，免得把整个职能都压下去
    const said = swipe.reasons.map(focusFromReason).find(Boolean);
    if (said || swipe.reasons.includes(directionReason(""))) {
      const focus = said || roleFocus(swipe.title, swipe.company);
      if (focus) return make({ text: `不想做「${focus}」方向，之后少推职位名带「${focus}」的岗位`, field: "keyword", value: focus, weight: -20, from: "跳过理由" });
    }
  }

  // 2. 滑动规律：最近 6 次里同一细分方向（职位名里的修饰词）跳过 3 次、一次没投，才少推这个细分方向；不按产品/运营这种大方向学
  const focus = swipe.action === "skip" ? roleFocus(swipe.title, swipe.company) : "";
  if (focus) {
    const same = mem.swipes.slice(-6).filter((s) => roleFocus(s.title, s.company) === focus);
    if (same.filter((s) => s.action === "skip").length >= 3 && !same.some((s) => s.action === "apply")) {
      const r = make({ text: `连续跳过了几个「${focus}」方向的岗位，之后少推这类`, field: "keyword", value: focus, weight: -15, from: "滑动规律" });
      if (r) return r;
    }
  }
  // 海外岗位投得多：多推
  if (swipe.action === "apply" && swipe.overseas) {
    const overseasApplies = mem.swipes.filter((s) => s.action === "apply" && s.overseas).length;
    if (overseasApplies >= 2) return make({ text: "你偏好海外相关的岗位，之后优先推这类", field: "overseas", value: "true", weight: 12, from: "滑动规律" });
  }
  return null;
}

/** 撤回最后一次滑动，连同它学到的规则 */
export function undoLastSwipe(mem: MemoryData): Swipe | null {
  const last = mem.swipes.pop();
  if (!last) return null;
  mem.rules = mem.rules.filter((r) => !(r.bySwipe === last.jobId && r.createdAt === last.at));
  return last;
}

/**
 * 有效投递：今天在官网真正提交了的公司（同一家投几个岗位只算一家）。右滑只是"想投"，不算。
 * 证据是投递记录里今天的事件：投递工作台里点了"已提交"、收到"投递成功"邮件、岗位库里点了"我已投递"。
 */
export function submittedToday(apps: Application[], now = new Date()): string[] {
  const today = localDay(now);
  return apps
    .filter((a) =>
      a.events.some((e) => e.date && localDay(new Date(e.date)) === today && (e.kind === "投递确认" || e.title.startsWith("在投递工作台定制简历并投递"))),
    )
    .map((a) => a.company);
}

export function todayStats(mem: MemoryData, now = new Date()) {
  const today = localDay(now);
  const list = mem.swipes.filter((s) => localDay(new Date(s.at)) === today);
  return {
    applied: list.filter((s) => s.action === "apply").length,
    skipped: list.filter((s) => s.action === "skip").length,
    saved: list.filter((s) => s.action === "save").length,
    learned: mem.rules.filter((r) => r.active && localDay(new Date(r.createdAt)) === today).map((r) => r.text),
  };
}
