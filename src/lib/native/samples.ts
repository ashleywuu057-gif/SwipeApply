import type { ExperienceCard } from "../types";
import type { JobPosting } from "../tracker-types";
import type { CompanyBrief } from "./types";

/**
 * 示例数据：岗位库还是空的、或者还没导入经历时用，方便先体验滑卡片和工作台的手感。
 * 公司都是虚构的，卡片和页面上会标「示例」。
 */
const now = () => new Date().toISOString();
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function job(id: string, p: Partial<JobPosting> & Pick<JobPosting, "company" | "title">): JobPosting {
  return {
    id,
    location: "",
    deadline: "",
    link: "",
    batch: "2027届秋招",
    industry: "",
    note: "",
    directions: [],
    overseas: false,
    source: "示例",
    starred: false,
    createdAt: now(),
    ...p,
  };
}

export const SAMPLE_JOBS: (JobPosting & { jd: string })[] = [
  {
    ...job("sample-1", { company: "星河互娱（示例）", title: "海外市场营销管培生", location: "上海", deadline: inDays(3), deadlineAt: inDays(3), industry: "游戏", directions: ["市场/品牌"], overseas: true }),
    jd: "岗位职责：\n1. 负责游戏在东南亚、欧美市场的整合营销，制定上线期和长线期的市场策略；\n2. 管理 TikTok、YouTube、X 等社媒账号和 KOL 合作，策划本地化内容；\n3. 跟踪投放数据，分析素材表现，输出复盘并优化投放策略。\n任职要求：\n1. 2027 届本科及以上，英语或小语种可作为工作语言；\n2. 热爱游戏，熟悉海外社媒生态；\n3. 有数据分析能力，会用 Excel/SQL 者优先。",
  },
  {
    ...job("sample-2", { company: "极光智能（示例）", title: "AI 产品海外增长", location: "深圳", deadline: inDays(12), deadlineAt: inDays(12), industry: "AI", directions: ["运营", "市场/品牌"], overseas: true }),
    jd: "岗位职责：\n1. 负责 AI 应用在海外市场的用户增长，搭建投放和内容增长渠道；\n2. 做竞品分析和用户调研，提炼产品卖点，协同产品团队迭代；\n3. 搭建增长数据看板，监控核心指标。\n任职要求：\n1. 对 AI 产品有浓厚兴趣，用过主流大模型应用；\n2. 逻辑清晰，有数据分析能力；\n3. 英语流利。",
  },
  {
    ...job("sample-3", { company: "山海消费（示例）", title: "品牌策划专员", location: "杭州", deadline: "招满即止", industry: "消费品", directions: ["市场/品牌"] }),
    jd: "岗位职责：\n1. 参与品牌年度传播规划，策划新品上市活动；\n2. 撰写品牌文案，统筹小红书、抖音内容；\n3. 对接代理商，跟进项目执行。\n任职要求：\n1. 文字功底好，审美在线；\n2. 有品牌或广告公司实习经历优先。",
  },
  {
    ...job("sample-4", { company: "远帆电商（示例）", title: "跨境电商运营", location: "广州", deadline: inDays(20), deadlineAt: inDays(20), industry: "电商", directions: ["运营"], overseas: true }),
    jd: "岗位职责：\n1. 负责欧洲站点店铺日常运营，商品上新和活动报名；\n2. 分析销售数据，优化商品详情页和广告；\n3. 研究当地消费者偏好。\n任职要求：\n1. 英语读写熟练，懂德语、法语或北欧语言者优先；\n2. 细心，对数字敏感。",
  },
  {
    ...job("sample-5", { company: "青云科技（示例）", title: "产品经理（国际化）", location: "北京", deadline: inDays(8), deadlineAt: inDays(8), industry: "互联网", directions: ["产品"], overseas: true }),
    jd: "岗位职责：\n1. 负责产品国际化需求，梳理不同地区的本地化方案；\n2. 撰写 PRD，推动研发、设计落地；\n3. 通过数据和用户反馈发现问题，持续迭代。\n任职要求：\n1. 有产品思维，逻辑清晰；\n2. 英语可作为工作语言；\n3. 有互联网产品实习经历优先。",
  },
];

export const SAMPLE_CARDS: ExperienceCard[] = [
  {
    id: "sample-card-1",
    type: "实习",
    company: "某出海短视频 App（示例）",
    role: "海外市场实习生",
    start: "2025.06",
    end: "2025.09",
    summary: "北欧市场社媒运营和投放分析",
    details: [
      "负责北欧市场 TikTok 与 Instagram 账号运营，3 个月内粉丝增长 4.2 万",
      "策划 2 场本地 KOL 合作活动，单场曝光 120 万+",
      "每周整理投放数据，分析素材点击率，推动 CTR 提升 18%",
    ],
    localOnly: false,
    sourceIds: [],
    warnings: [],
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "sample-card-2",
    type: "项目",
    company: "校园咖啡品牌（示例）",
    role: "品牌策划负责人",
    start: "2024.10",
    end: "2025.01",
    summary: "从 0 到 1 做校园咖啡品牌",
    details: ["完成 300 份问卷的用户调研，确定品牌定位和主打产品", "负责小红书内容策划，单篇笔记最高点赞 5000+", "组织开业活动，首周销量 1800 杯"],
    localOnly: false,
    sourceIds: [],
    warnings: [],
    createdAt: now(),
    updatedAt: now(),
  },
];

export function sampleBrief(company: string): CompanyBrief {
  return {
    company,
    status: "ready",
    basis: "示例",
    intro: `${company}是一家虚构的示例公司，用来演示公司速览的样子。配置好模型和联网搜索后，这里会显示真实公司的介绍。`,
    businessLine: "示例业务条线：海外发行与市场",
    products: [
      { name: "示例产品 A", desc: "面向东南亚市场的休闲游戏", refs: [] },
      { name: "示例产品 B", desc: "面向欧美的社交应用", refs: [] },
    ],
    facts: [],
    refs: [],
    updatedAt: now(),
  };
}
