/* ================= P2 投递看板：数据结构 ================= */

/** 岗位方向（把各家五花八门的岗位名统一成这几类） */
export const DIRECTIONS = ["产品", "运营", "市场/品牌", "战略/分析", "技术", "设计", "销售/商务", "职能", "其他"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** 公司所属行业（按公司名和岗位信息判断，一家公司可以同时属于几类，例如 SHEIN 是互联网 + 出海） */
export const SECTORS = ["互联网", "AI", "出海", "外企", "金融", "制造/硬件", "快消/零售", "其他"] as const;
export type Sector = (typeof SECTORS)[number];
export const DEFAULT_MY_SECTORS: Sector[] = ["互联网", "AI", "出海", "外企"];

/** 岗位库里的一条岗位（来自导入的共享表格或手动添加） */
export interface JobPosting {
  id: string;
  company: string;
  title: string;
  location: string;
  deadline: string; // 原文，例如"2026/10/15""招满即止"
  deadlineAt?: string; // 能解析出来的日期 YYYY-MM-DD
  link: string;
  jdUrl?: string; // 这个岗位的详情页（写着岗位职责和任职要求的那一页），和网申入口 link 可以不同
  siteOnly?: boolean; // 公司级条目：只有校招官网入口和招聘方向，还没有具体岗位（来自 jobworthy）
  noticeUrl?: string; // 官方招聘公告（公众号文章等）
  expandedAt?: string; // 已经在官网按简历关键词找过具体岗位
  batch: string; // 届别 / 批次，例如"2027届秋招"
  industry: string;
  note: string; // 内推码、备注
  directions: Direction[];
  overseas: boolean; // 岗位名或备注里有"海外/国际/出海"
  source: string; // 来自哪个导入文件，或"手动"
  starred: boolean;
  createdAt: string;
}

/** 投递状态：前 7 个按顺序推进，最后两个是结束状态 */
export const STAGES = ["已投递", "测评", "笔试", "AI面", "面试", "HR面", "Offer", "未通过", "放弃"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_RANK: Record<Stage, number> = { 已投递: 1, 测评: 2, 笔试: 3, AI面: 4, 面试: 5, HR面: 6, Offer: 7, 未通过: 9, 放弃: 9 };

/** 看板的列 */
export const COLUMNS: { title: string; stages: Stage[] }[] = [
  { title: "已投递", stages: ["已投递"] },
  { title: "测评 / 笔试", stages: ["测评", "笔试"] },
  { title: "AI面", stages: ["AI面"] },
  { title: "面试中", stages: ["面试", "HR面"] },
  { title: "Offer", stages: ["Offer"] },
  { title: "已结束", stages: ["未通过", "放弃"] },
];

export type EventKind = "投递确认" | "测评" | "笔试" | "AI面" | "面试" | "HR面" | "Offer" | "未通过" | "备注";

export interface TimelineEvent {
  id: string;
  date: string; // 发生/收到的时间 ISO
  kind: EventKind;
  title: string;
  scheduledAt?: string; // 笔试/面试的时间 ISO（本地时间，不带时区）
  link?: string;
  source: "邮件" | "手动";
  mailId?: string;
}

/** 一条投递记录 */
export interface Application {
  id: string;
  jobId?: string;
  jobIds?: string[]; // 同一家公司投了多个岗位时，合并成一条记录
  company: string;
  title: string;
  link: string;
  stage: Stage;
  appliedAt: string; // 不知道投递日期时为空字符串（例如从手动记录表导入的）
  events: TimelineEvent[];
  notes: string;
  updatedAt: string;
  /** 投递时这个岗位的特征：岗位被删掉以后也能用来统计哪类岗位推进得好（以后训练排序模型的数据） */
  snapshot?: AppSnapshot;
  /** 每次阶段变化的时间（updateTracker 保存时自动记） */
  stageLog?: { stage: Stage; at: string }[];
}

export interface AppSnapshot {
  directions: Direction[];
  sectors: Sector[];
  overseas: boolean;
  location: string;
  via: "岗位流" | "插件" | "表格导入" | "邮件" | "手动";
  /** 以下几项只有从岗位流投递时才有：投递时的证据匹配分、对上的点数、差距数、简历怎么生成的 */
  score?: number;
  reasonCount?: number;
  gapCount?: number;
  resumeBy?: string;
}

export type MailKind = EventKind | "其他";

/** 从邮箱读到的一封招聘邮件（只保存标题、发件人、摘要和识别结果，不保存全文） */
export interface MailItem {
  id: string; // 邮箱 + UID
  messageId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  kind: MailKind;
  company: string;
  scheduledAt?: string;
  link?: string;
  applicationId?: string; // 建议对应的投递记录
  by: "规则" | "模型";
  status: "待确认" | "已应用" | "已忽略";
}

/** 岗位订阅源：公开可下载的秋招汇总表（CSV / Excel / Markdown 表格 / 网页表格），每天自动拉取 */
export interface JobFeed {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastFetchedAt?: string;
  lastAdded?: number;
  lastError?: string;
}

export interface AutoRunLog {
  at: string;
  added: number;
  errors: string[];
  trigger: "定时" | "手动";
}

/** 今天优先看什么：方向和关键词都空 = 都行，按平常的顺序推 */
export interface TodayFocus {
  date: string; // YYYY-MM-DD（本地日期）
  directions: Direction[];
  keywords: string[];
}

export interface TrackerSettings {
  myDirections: Direction[]; // 我的方向，岗位库默认只看这些
  mySectors?: Sector[]; // 我的行业，没设置过按 DEFAULT_MY_SECTORS
  onboardedAt?: string; // 导入简历后 AI 第一次推断过投递方向的时间（推断过就不再重复）
  autoFocus?: { directions: Direction[]; sectors: Sector[]; why: string; by: "AI" | "规则"; at: string }; // AI 当时自动设的方向，首页当天说明一句按什么推的
  todayFocus?: TodayFocus; // 岗位流首页问的「今天优先看什么方向」，只在当天有效
  activeApply?: { jobId: string; at: string }; // 最近在投递工作台点「确认简历，去投递」的岗位：网申页地址对不上岗位时，插件用它的定制简历
  agendaDone?: Record<string, string>; // 日程里打勾的条目（日程 key 或 follow-投递id）→ 打勾时间；60 天后自动清掉
  lastSyncAt?: string;
  lastSyncUid?: number;
  lastMailAutoSlot?: string; // "YYYY-MM-DD HH:MM"，这个时间点的自动同步已经跑过
  feeds: JobFeed[];
  dailyTime: string; // 每天自动更新的时间，默认 "09:00"
  lastAutoRunDate?: string; // YYYY-MM-DD，当天已经跑过就不再跑
  lastAutoRun?: AutoRunLog;
  webSearch?: boolean; // 每日更新时是否用千问联网搜索新岗位（噪音较大，默认关）
  jobworthy?: boolean; // 每日更新时是否同步 jobworthy 校招公司清单，没设置过按开启算
  lastJobworthy?: { at: string; added: number; expanded: number; updated?: string; error?: string };
  jobKeywords?: string[]; // 在官网找岗位用的关键词，没设置过从经历卡片的岗位名里取
  lastSearch?: { at: string; added: number; error?: string };
}

export interface TrackerData {
  jobs: JobPosting[];
  applications: Application[];
  mails: MailItem[];
  settings: TrackerSettings;
}
