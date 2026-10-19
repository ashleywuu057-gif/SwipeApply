export type CardType = "实习" | "项目" | "比赛";
export const CARD_TYPES: CardType[] = ["实习", "项目", "比赛"];

/** 资料分类：简历用来生成卡片；其余三类挂在卡片详情里，只分类、不改写 */
export type Category = "简历" | "业务知识" | "项目复盘" | "工作源文件";
export const CATEGORIES: Category[] = ["简历", "业务知识", "项目复盘", "工作源文件"];
export const DETAIL_CATEGORIES: Category[] = ["业务知识", "项目复盘", "工作源文件"];

export const CATEGORY_HINT: Record<Category, string> = {
  简历: "用来识别有哪些经历，生成卡片",
  业务知识: "行业和概念知识，例如广告投放知识、AI 基础概念",
  项目复盘: "复盘笔记、面试可能被问到的问题和回答",
  工作源文件: "PRD、方案、数据分析报告、周报等工作产出",
};

/** 经历卡片：只有经历骨架 */
export interface ExperienceCard {
  id: string;
  type: CardType;
  company: string;
  role: string;
  start: string; // 2024.06
  end: string; // 2024.09 / 至今
  summary: string; // 列表页显示的一句话描述
  details: string[]; // 简历里这段经历的原句，逐字保留
  localOnly: boolean; // 仅本地：不参与任何云端调用
  sourceIds: string[]; // 来自哪份简历
  warnings: string[];
  createdAt: string;
  updatedAt: string;
  /** 旧版本遗留字段（v0.1 把复盘拆进了卡片），只读展示 */
  reflection?: string;
}

/**
 * 从复盘、工作文档里提炼的一条证据：问题 → 行动 → 结果，挂在某段经历下。
 * quote 是资料里逐字保留的原文片段，写简历时它就是依据；其余字段只能用 quote 里有的信息。
 */
export interface Evidence {
  id: string;
  cardId: string;
  sourceId: string;
  quote: string;
  problem: string;
  action: string;
  result: string;
  scope: { users?: string; team?: string; money?: string; market?: string; stage?: string };
  role: "主导" | "负责" | "参与" | "协助" | ""; // 原文里写了哪个词就是哪个，没写留空
  hidden?: boolean; // 你觉得不准的可以隐藏，写简历和匹配时不用
  createdAt: string;
}

/** 导入的资料：整篇原文保存在本机，归到一个分类、一段经历（不重复出现） */
export interface SourceDoc {
  id: string;
  name: string;
  kind: string; // pdf / docx / md / txt
  note: string;
  chars: number;
  importedAt: string;
  category?: Category; // 未分类时为空
  cardId?: string | null; // 归属哪段经历；null = 不属于具体经历
  splitFrom?: string; // 由哪份文件自动切分而来
}

export interface AutoRules {
  contact: boolean; // 邮箱、手机、身份证、微信
  person: boolean; // 人名
  nickname: boolean; // 昵称
  table: boolean; // 表格和数据块
}

export interface Settings {
  sensitiveTerms: string[];
  allowTerms: string[]; // 不屏蔽的词（规则误判时放行）
  autoRules: AutoRules;
}

export interface LibraryData {
  cards: ExperienceCard[];
  sources: SourceDoc[];
  settings: Settings;
}

/** 从简历里识别出的卡片草稿（还没保存） */
export interface DraftCard
  extends Pick<ExperienceCard, "type" | "company" | "role" | "start" | "end" | "summary" | "details" | "localOnly" | "sourceIds" | "warnings"> {
  draftId: string;
  mergeIntoId?: string;
  mergeIntoLabel?: string;
}

/** 归属目标：已有卡片 / 本次新识别的草稿 / 不属于具体经历 */
export type CardRef = { kind: "card"; id: string } | { kind: "draft"; id: string } | null;

type By = "模型" | "规则" | "关键词匹配" | "随文件";

/** 自动切分出的一个小节（按原文位置切，不改写） */
export interface Segment {
  id: string;
  title: string;
  start: number;
  end: number;
  preview: string;
  category: Category;
  target: CardRef;
  by: By;
}

export interface Assignment {
  sourceId: string;
  name: string;
  category: Category;
  target: CardRef;
  by: By;
  /** 文件里各小节分类或归属不同时，建议切分 */
  segments?: Segment[];
  split?: boolean;
}
