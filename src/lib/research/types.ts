/* ================= P1 公司业务调研 ================= */

/** 信息渠道（对应"官方公开资料 / 第三方渠道 / 第一手资料"） */
export type ChannelGroup = "官方公开资料" | "第三方渠道";

/** 来源可信度：A 官方与交易所披露 > B 研究机构与头部行业媒体 > C 一般媒体 > D 论坛与自媒体 */
export type Tier = "A" | "B" | "C" | "D";

export interface Source {
  id: number; // 报告里引用用的编号 [1] [2]
  url: string;
  title: string;
  site: string;
  date?: string;
  group: ChannelGroup;
  channel: string; // 官网、财报、招聘广告、公众号、行业媒体、研究机构、证券交易所、用户论坛……
  tier: Tier;
}

/** 调研 agent 记录的一条发现：必须附原文摘录，且摘录必须出现在已读网页里 */
export interface Finding {
  id: number;
  subject: "目标公司" | "参照产品";
  section: string; // 业务条线 / 主要产品 / 商业模式 / 业务位置 / 目标用户和市场 / 近一年动态 / 竞争格局 / 增长和运营 / 团队与招聘
  claim: string;
  quote: string;
  sourceId: number;
}

export interface TraceStep {
  at: string;
  kind: "思考" | "搜索" | "阅读" | "记录" | "驳回" | "结束" | "错误" | "阶段";
  text: string;
}

/** 最终报告 */
export interface Report {
  jd: {
    abilities: {
      name: string;
      detail: string;
      match: "强" | "中" | "弱";
      evidence: { cardId: string; label: string; quote: string; verified: boolean }[];
      gap: string;
    }[];
    conclusion: string;
  };
  businessLine: {
    type: string; // 电商 / 直播 / 广告 / AI / 游戏 / 本地生活……
    position: string;
    products: { name: string; desc: string; refs: number[] }[];
    conclusion: string;
  };
  channels: {
    found: { group: ChannelGroup; channel: string; sources: number[] }[];
    firstHand: string[]; // 建议自己去做的第一手调研
  };
  competitive: {
    goal: string;
    reference: string; // 参照产品（来自我的某段实习）
    relation: "直接竞品" | "间接竞品" | "替代品" | "";
    relationReason: string;
    dimensions: { name: string; target: string; reference: string; insight: string; refs: number[] }[];
    swot: { S: string[]; W: string[]; O: string[]; T: string[] };
    conclusion: string;
    transferable: string[];
    talkingPoints: string[];
  };
  homework: string[];
  /** 业务题预判：结合调研发现，面试官可能问的业务题（每道都有来源；旧报告没有这一项） */
  bizQuestions?: { q: string; why: string; refs: number[]; use: { cardId: string; label: string; quote: string; verified: boolean }[] }[];
  warnings: string[];
}

export interface Usage {
  steps: number;
  searches: number;
  reads: number;
  accepted: number;
  rejected: number;
  promptTokens: number;
  completionTokens: number;
}

export interface Research {
  id: string;
  company: string;
  jobTitle: string;
  jd: string;
  applicationId?: string;
  from?: "面试准备"; // 收到面试邮件后自动发起的
  budget?: { steps: number; searches: number; reads: number }; // 不填用默认预算；面试临近时减半
  refCardId?: string; // 参照的经历卡片；空 = 自动选择
  refLabel?: string; // 例如"星河广告 · 媒介策划实习生"
  refCompany?: string;
  status: "排队中" | "调研中" | "生成报告" | "完成" | "失败";
  error?: string;
  trace: TraceStep[];
  sources: Source[];
  findings: Finding[];
  report?: Report;
  usage: Usage;
  createdAt: string;
  finishedAt?: string;
}
