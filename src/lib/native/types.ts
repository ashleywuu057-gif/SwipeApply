/* ================= 新版（AI 原生）：岗位流 + 投递工作台 ================= */

import type { JobPosting } from "../tracker-types";

/** 一次滑动 */
export type SwipeAction = "skip" | "apply" | "save";
export interface Swipe {
  jobId: string;
  action: SwipeAction;
  reasons: string[]; // 左滑时点的理由
  at: string;
  // 记下当时的岗位特征，岗位被删掉以后也能继续用来学习
  company: string;
  title: string;
  directions: string[];
  location: string;
  overseas: boolean;
}

/**
 * AI 从滑动里学到的岗位偏好（长期记忆，看得见、能撤销）。
 * field + value 决定影响哪些岗位；weight < 0 少推，> 0 多推。
 */
export interface PrefRule {
  id: string;
  text: string; // "你对纯运营岗兴趣不大，之后少推这类"
  field: "direction" | "location" | "company" | "keyword" | "overseas";
  value: string;
  weight: number;
  active: boolean;
  from: "滑动规律" | "跳过理由" | "手动" | "一句话";
  until?: string; // 有效到哪天（YYYY-MM-DD，含当天），例如"这周只看上海"；不填 = 长期有效
  bySwipe?: string; // 由哪次滑动产生（撤回那次滑动时一起撤掉）
  createdAt: string;
}

/** 写作偏好：你改简历时 AI 总结出来、经你确认的规则，之后生成简历都会遵守 */
export interface WritingPref {
  id: string;
  text: string; // "不用'赋能''抓手'这类词"
  active: boolean;
  createdAt: string;
}

/** 你在投递时补充的事实（AI 问你、你回答的），之后可以作为简历的依据 */
export interface Fact {
  id: string;
  text: string;
  question?: string;
  from: string; // 哪次投递补充的，例如"米哈游 · 海外市场"
  createdAt: string;
}

export interface MemoryData {
  swipes: Swipe[];
  rules: PrefRule[];
  writing: WritingPref[];
  facts: Fact[];
  /** 你手动改过的简历句子（AI 用来总结写作偏好） */
  edits: { before: string; after: string; at: string }[];
  profile: Profile;
}

/** 简历抬头：只存在本机，永远不发给模型 */
export interface Profile {
  nickname: string; // 首页打招呼用
  name: string;
  phone: string;
  email: string;
  education: string; // 每段一行"学校 专业 时间"，下面的行是课程、GPA、奖项等要点
  extra: string; // 工作技能&其他：每行一条，例如"语言能力：英语雅思7.5"
  photo?: string; // 证件照（压缩后的 data URL），导出简历时放右上角
}

/* ---------------- 岗位流 ---------------- */

export interface FeedCard {
  job: JobPosting;
  score: number; // 0-100，卡片上的匹配度
  scoreBasis: "证据" | "粗估"; // 证据 = 按 JD 分析过，知道对上几点、差几点；粗估 = 规则估的
  adjust: number; // 方向、行业、偏好、截止带来的调整（AI 分析回来后前端据此重算分数）
  reasons: MatchReason[]; // 翻到背面看的"为什么推给你"
  gaps: string[]; // JD 看重、你素材里没找到证据的点
  badges: string[]; // "3 天后截止""新""海外"
  jdPreview?: string; // 已经抓到的 JD 前几行
  analyzed?: boolean; // AI 已经分析过匹配理由（没有理由也算）
  sample?: boolean;
}

/** AI 分析的结果：gaps 为 null = 还没按 JD 分析过（只按岗位名分析，或旧版缓存） */
export interface InsightView {
  reasons: MatchReason[];
  gaps: string[] | null;
}

export interface MatchReason {
  need: string; // JD 要求 / 岗位特点
  have: string; // 你的对应经历（原句）或资料名
  cardId?: string;
  source?: "经历原句" | "素材资料" | "AI 分析";
}

/* ---------------- 投递工作台 ---------------- */

export interface JdInfo {
  jobId: string;
  text: string; // 岗位职责和要求
  status: "ok" | "empty" | "failed" | "searching";
  by: "网页" | "模型整理" | "浏览器" | "搜索" | "剪藏" | "手动" | "示例";
  url?: string; // JD 实际来自哪个网页
  sourceTitle?: string;
  error?: string; // 没找到时，每一步试了什么
  warn?: string; // 找到了但可能不对（例如发布时间较早，可能是往年的）
  updatedAt: string;
  v?: number;
}

export interface BriefRef {
  id: number;
  title: string;
  url: string;
  site: string;
}

/** 公司速览（按公司缓存，第二次打开秒开） */
export interface CompanyBrief {
  company: string;
  status: "ready" | "generating" | "failed";
  basis: "联网" | "模型知识" | "示例";
  intro: string;
  businessLine: string; // 这个岗位所在的业务条线
  products: { name: string; desc: string; refs: number[] }[];
  facts: { text: string; refs: number[] }[]; // 其他要点：规模、近期动态
  refs: BriefRef[];
  error?: string;
  updatedAt: string;
}

/** 简历里的一条 bullet：每条都能追溯到素材库原句 */
export interface Bullet {
  id: string;
  text: string;
  source: string; // 依据的原句（卡片原句或你补充的事实）
  status: "原句" | "改写" | "手动" | "待核对";
  issue?: string; // 核对没通过的原因
}

export interface ResumeExp {
  cardId: string;
  include: boolean;
  company: string;
  role: string;
  time: string;
  bullets: Bullet[];
}

export interface Resume {
  jobId: string;
  experiences: ResumeExp[];
  skills: string[];
  skillsPos?: number; // 技能块排在第几段经历之后（卡片可以拖动排序），不填放最后
  portfolio: { label: string; url: string }[];
  gaps: string[]; // JD 要求、但素材库里没找到证据的点（AI 会问你）
  by: "模型" | "规则" | "示例";
  updatedAt: string;
}

/* ---------------- 面试准备 ---------------- */

/** 准备材料里的一条素材：简历原句（L）或资料证据（V），原文逐字 */
export interface PrepMatch {
  ref: string; // L3 / V12（本次准备时的编号，只在这份准备里有效）
  label: string; // 属于哪段经历
  text: string; // 原文
  note?: string; // 资料证据的"问题 → 行动 → 结果"
}

export interface PrepQuestion {
  id: string;
  q: string;
  focus: string; // 考察点
  refs: string[]; // 可以用上的素材（PrepMatch.ref）
  from?: "调研"; // 深度调研报告里的业务题预判
}

export interface PrepFeedback {
  good: string; // 答得好的地方
  missing: string; // 缺了什么（按"问题 → 行动 → 结果"看）
  use: string[]; // 建议用上的素材（PrepMatch.ref，核对过存在）
  sample?: { text: string; status: "可用" | "待核对"; issue?: string }; // 参考说法：数字必须来自引用的素材
}

export interface PrepTurn {
  qid: string;
  question: string;
  followUp: boolean; // 是不是追问
  answer?: string;
  feedback?: PrepFeedback;
}

export interface PrepSession {
  id: string;
  startedAt: string;
  turns: PrepTurn[];
  summary?: string;
  done: boolean;
}

/** 准备稿里的一道追问：提到的数字必须出现在它引用的素材里，否则标"待核对" */
export interface PlanQuestion {
  q: string;
  kind: "做了什么" | "数字口径" | "个人贡献" | "重来" | "其他";
  refs: string[]; // PrepPlan.materials 里的 ref
  status: "可用" | "待核对";
  issue?: string;
}

/**
 * 面试准备稿（参照一份人工写的准备稿的结构）：
 * 一、简历深挖：最该讲的几段经历 + 每段的追问三连；JD 要求里素材证明不了的风险点
 * 二、公司业务：最新情况（带来源）、团队在做什么的推断和拆解公式、业务题和答题思路（深度调研做完后补上）
 * 三、表达：为什么选这个岗位、1 分钟自我介绍主线、反问
 */
export interface PrepPlan {
  materials: PrepMatch[]; // 准备稿引用的素材（比"最匹配的经历"多，按 JD 要点挑）
  points: string[]; // JD 要点
  deepDive: { cardId: string; label: string; points: number[]; why: string; questions: PlanQuestion[]; transfer: string }[];
  risks: { need: string; why: string; prep: string[] }[];
  pitch: { whyRole: string; intro: string; focus: string[]; ask: string[] };
  business?: {
    researchId: string;
    facts: { text: string; refs: number[] }[]; // refs：调研来源编号
    model: string; // 团队在做什么（推断）
    formulas: string[];
    questions: { q: string; approach: string; use: string[] }[]; // use：materials 里的 ref
  };
  error?: string; // 生成失败的原因（准备材料其余部分照常可用）
  at: string;
}

/** 一场面试的准备（按投递记录存：data/native/prep/<投递id>.json） */
export interface PrepData {
  appId: string;
  company: string;
  title: string;
  round: "面试" | "AI面" | "HR面";
  scheduledAt?: string;
  link?: string; // 面试链接（来自邮件）
  mailId?: string;
  jobId: string; // 用来找 JD 和公司速览的岗位（岗位库里没有时是临时的 prep-<投递id>）
  jobTitle?: string; // 对上的岗位库岗位名（页面上显示，对错了你能看出来）
  status: "preparing" | "ready" | "failed";
  step?: string; // 正在做哪一步，给页面显示进度
  error?: string;
  jd: { text: string; url?: string; by?: string; warn?: string };
  researchId?: string; // 这场面试对应的深度调研（旧数据没有）
  researchNote?: string; // 没有发起调研的原因
  plan?: PrepPlan; // 面试准备稿（旧数据没有）
  matches: PrepMatch[];
  questions: PrepQuestion[];
  sessions: PrepSession[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  actions?: string[]; // agent 这一轮做了什么（改了哪句、查了什么）
  question?: string; // agent 反问你的问题
  suggestion?: { kind: "writing"; text: string }; // 建议记住的写作偏好，等你确认
}
