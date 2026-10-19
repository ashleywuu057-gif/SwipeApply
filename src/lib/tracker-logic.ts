/**
 * P2 的识别规则（纯函数，全部在本机运行）：
 * 岗位方向归类、截止日期解析、表格列名识别、招聘邮件识别、时间和链接提取、邮件对应投递记录。
 */
import type { Application, AppSnapshot, Direction, EventKind, JobPosting, MailKind, Sector, Stage } from "./tracker-types";
import { STAGE_RANK } from "./tracker-types";

/* ---------------- 岗位方向 ---------------- */

const DIRECTION_RULES: [Direction, RegExp][] = [
  ["产品", /产品|product|\bPM\b|策划/i],
  ["运营", /运营|operation|社区|内容|用户增长/i],
  ["市场/品牌", /市场|营销|品牌|marketing|brand|公关|PR\b|广告|投放|增长|growth|传播|媒介/i],
  ["战略/分析", /战略|strategy|投资|咨询|分析|analyst|研究|商业化|经营/i],
  ["技术", /研发|开发|工程师|算法|engineer|developer|测试|数据科学|架构|前端|后端|客户端|芯片|硬件/i],
  ["设计", /设计|design|UI|UX|交互|视觉/i],
  ["销售/商务", /销售|sales|BD|商务|客户经理|渠道|大客户|KA/i],
  ["职能", /HR|人力|招聘|财务|会计|法务|行政|审计|风控|供应链|采购/i],
];

export function directionsOf(title: string, note = ""): Direction[] {
  const text = `${title} ${note}`;
  const hit = DIRECTION_RULES.filter(([, re]) => re.test(text)).map(([d]) => d);
  return hit.length ? hit : ["其他"];
}

export function isOverseas(...texts: string[]) {
  return /海外|国际|出海|global|overseas|international|跨境|东南亚|北美|欧洲|新加坡/i.test(texts.join(" "));
}

/* ---------------- 行业 ---------------- */

// 公司名单只收常见的校招公司，名单外的靠行业、岗位里的关键词判断
const SECTOR_COMPANIES: [Sector, RegExp][] = [
  ["互联网", /字节|抖音|TikTok|腾讯|阿里|淘宝|天猫|饿了么|蚂蚁|美团|京东|拼多多|pdd|Temu|百度|网易|快手|小红书|哔哩哔哩|bilibili|B站|滴滴|携程|去哪儿|微博|新浪|搜狐|畅游|得物|唯品会|货拉拉|哈啰|作业帮|好未来|高途|猿辅导|BOSS直聘|知乎|爱奇艺|腾讯音乐|迅雷|metaapp|米哈游|莉莉丝|叠纸|鹰角|Shopee|Sea\b|SHEIN|希音|金山|WPS|小米|OPPO|vivo|荣耀|华为|水滴|快看|喜马拉雅|微众|陆金所|零跑/i],
  ["AI", /商汤|智谱|月之暗面|Kimi|MiniMax|百川|阶跃星辰|零一万物|科大讯飞|讯飞|寒武纪|地平线|第四范式|云从|旷视|依图|DeepSeek|深度求索|面壁|宇树|优必选|松延动力|智元|银河通用|云天励飞|出门问问|思必驰|OpenAI|Anthropic/i],
  ["出海", /SHEIN|希音|Temu|TikTok|Shopee|Sea\b|Lazada|AliExpress|速卖通|安克|Anker|传音|Transsion|大疆|DJI|追觅|石头科技|影石|Insta360|拓竹|Bambu|韶音|Shokz|莉莉丝|米哈游|名创优品|泡泡玛特|Tapo|TP-?Link|致欧|赛维|绿联/i],
  ["外企", /amazon|亚马逊|微软|Microsoft|Google|谷歌|苹果|Apple|Meta\b|IBM|Intel|英特尔|德州仪器|高通|Qualcomm|英伟达|NVIDIA|AMD|三星|Samsung|索尼|Sony|西门子|Siemens|博世|Bosch|施耐德|Schneider|ABB|霍尼韦尔|飞利浦|联合利华|Unilever|宝洁|P&G|欧莱雅|雀巢|Nestl|玛氏|百事|可口可乐|达能|亿滋|强生|辉瑞|阿斯利康|赛诺菲|诺华|罗氏|默沙东|拜耳|巴斯夫|沃尔玛|山姆|宜家|IKEA|麦当劳|星巴克|耐克|阿迪达斯|LVMH|麦肯锡|McKinsey|BCG|波士顿咨询|贝恩|Bain|罗兰贝格|埃森哲|Accenture|德勤|普华永道|PwC|安永|毕马威|KPMG|高盛|摩根|花旗|汇丰|HSBC|渣打|Shopee|Sea\b/i],
  ["快消/零售", /联合利华|宝洁|欧莱雅|雀巢|玛氏|百事|可口可乐|达能|亿滋|蒙牛|伊利|农夫山泉|元气森林|沃尔玛|山姆|宜家|名创优品|泡泡玛特|安踏|李宁/i],
  ["制造/硬件", /海尔|海信|TCL|美的|格力|京东方|长电|特变电工|施耐德|博世|西门子|德州仪器|比亚迪|蔚来|理想|小鹏|宁德|中兴|大疆|追觅|影石|拓竹|韶音|亿道|长江存储|晶盛|三星/i],
];
const SECTOR_WORDS: [Sector, RegExp][] = [
  ["互联网", /互联网|电商|游戏|社交|短视频|直播|App\b|本地生活/i],
  ["AI", /人工智能|\bAI\b|AIGC|大模型|机器学习|算法|智能体|Agent|机器人/i],
  ["出海", /出海|跨境|海外|国际化|global|overseas/i],
  ["外企", /外企|外资|跨国|500强外/i],
  ["金融", /银行|证券|基金|保险|信托|金融|资管|支付|券商/i],
  ["快消/零售", /快消|零售|食品|饮料|美妆|日化|消费品/i],
  ["制造/硬件", /制造|硬件|芯片|半导体|集成电路|电子|汽车|新能源|能源|装备|家电|工业/i],
];

export function sectorsOf(j: Pick<JobPosting, "company" | "title" | "industry" | "note">): Sector[] {
  const out = new Set<Sector>();
  for (const [s, re] of SECTOR_COMPANIES) if (re.test(j.company)) out.add(s);
  const text = `${j.company} ${j.industry} ${j.title}`;
  for (const [s, re] of SECTOR_WORDS) if (re.test(text)) out.add(s);
  return out.size ? [...out] : ["其他"];
}

/** 投递记录上的岗位特征快照。有岗位就用岗位的，没有就按公司名和岗位名推断 */
export function snapshotOf(
  app: Pick<Application, "company" | "title">,
  job: Pick<JobPosting, "company" | "title" | "industry" | "note" | "location" | "directions" | "overseas"> | undefined,
  via: AppSnapshot["via"],
  extra: Partial<AppSnapshot> = {},
): AppSnapshot {
  const j = job ?? { company: app.company, title: app.title, industry: "", note: "", location: "", directions: directionsOf(app.title), overseas: isOverseas(app.company, app.title) };
  return { directions: j.directions, sectors: sectorsOf(j), overseas: j.overseas, location: j.location, via, ...extra };
}

/* ---------------- 截止日期 ---------------- */

export function parseDeadline(raw: string, now = new Date()): string | undefined {
  const s = raw.trim();
  let m = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);
  if (m) return ymd(guessYear(+m[1], now), +m[1], +m[2]);
  // Excel 日期序列号
  if (/^\d{5}$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return undefined;
}

function guessYear(month: number, now: Date) {
  // 秋招跨年：现在是 9 月，看到"3月"应该是明年
  return month < now.getMonth() + 1 - 3 ? now.getFullYear() + 1 : now.getFullYear();
}

function ymd(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/* ---------------- 共享表格列名识别 ---------------- */

const COLUMN_RULES: [keyof Pick<JobPosting, "company" | "title" | "location" | "deadline" | "link" | "jdUrl" | "batch" | "industry" | "note">, RegExp][] = [
  ["jdUrl", /职位链接|岗位链接|岗位详情|职位详情|JD ?链接|JD ?url/i], // 放在最前：否则会被「岗位 / 职位」「链接」抢走
  ["company", /公司|企业|单位|company/i],
  ["title", /岗位|职位|position|job|title|方向/i],
  ["location", /地点|城市|base|location|工作地/i],
  ["deadline", /截止|deadline|结束|ddl/i],
  ["link", /链接|网申|投递|官网|link|url|入口/i],
  ["batch", /届|批次|招聘类型|招聘对象|类型/i],
  ["industry", /行业|industry|领域/i],
  ["note", /内推|备注|说明|note|推荐码/i],
];

export type ColumnMap = Partial<Record<(typeof COLUMN_RULES)[number][0], number>>;

export function mapColumns(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  headers.forEach((h, i) => {
    const text = String(h ?? "").trim();
    for (const [key, re] of COLUMN_RULES) {
      if (map[key] === undefined && re.test(text)) {
        map[key] = i;
        break;
      }
    }
  });
  return map;
}

/** 找表头所在的行（很多共享表格前几行是标题、说明） */
export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const m = mapColumns(rows[i]);
    if (m.company !== undefined && (m.title !== undefined || m.link !== undefined || m.jdUrl !== undefined)) return i;
  }
  return -1;
}

/* ---------------- 公司名 ---------------- */

export function normCompany(s: string) {
  return s
    .toLowerCase()
    .replace(/[（(][^)）]*[)）]/g, "")
    .replace(/(股份有限公司|有限责任公司|有限公司|集团|科技|网络|信息技术|技术|中国|官方|招聘|校园招聘|校招|campus|recruiting|recruitment|talent|hr|team)/gi, "")
    .replace(/[\s·.\-_【】[\]]/g, "");
}

/* ---------------- 投递状态推进 ---------------- */

const KIND_TO_STAGE: Partial<Record<EventKind, Stage>> = {
  投递确认: "已投递",
  测评: "测评",
  笔试: "笔试",
  AI面: "AI面",
  面试: "面试",
  HR面: "HR面",
  Offer: "Offer",
  未通过: "未通过",
};

/** 只往前推进；未通过 / Offer 直接生效；已结束的不再被普通邮件改动 */
/**
 * 旧投递记录补数据（可重复运行）：补岗位特征快照；按时间线里的事件重放出阶段变化，
 * 重放结果和当前阶段不一致（手动改过）时，用最后更新时间补一笔。
 */
export function backfillApp(app: Application, via: AppSnapshot["via"] = "表格导入") {
  app.snapshot ??= snapshotOf(app, undefined, via);
  if (app.stageLog?.length) return;
  const events = [...app.events].sort((a, b) => a.date.localeCompare(b.date));
  let stage: Stage = "已投递";
  const log: { stage: Stage; at: string }[] = [{ stage, at: app.appliedAt || events[0]?.date || app.updatedAt }];
  for (const e of events) {
    const next = nextStage(stage, e.kind);
    if (next !== stage) log.push({ stage: (stage = next), at: e.date });
  }
  if (stage !== app.stage) log.push({ stage: app.stage, at: app.updatedAt });
  app.stageLog = log;
}

/** 走到过的最远阶段（不算"未通过""放弃"这两个结束状态） */
export function furthestStage(app: Pick<Application, "stage" | "stageLog">): Stage {
  let best: Stage = "已投递";
  for (const s of [...(app.stageLog ?? []).map((x) => x.stage), app.stage])
    if (STAGE_RANK[s] < 9 && STAGE_RANK[s] > STAGE_RANK[best]) best = s;
  return best;
}

/** 哪类岗位推进得好：按方向、行业分组，数投递数和进入测评及以后阶段的数量 */
export function progressStats(apps: Application[]) {
  const group = (keysOf: (a: Application) => string[]) => {
    const m = new Map<string, { key: string; n: number; advanced: number }>();
    for (const a of apps)
      for (const k of keysOf(a)) {
        const g = m.get(k) ?? { key: k, n: 0, advanced: 0 };
        g.n++;
        if (STAGE_RANK[furthestStage(a)] >= STAGE_RANK["测评"]) g.advanced++;
        m.set(k, g);
      }
    return [...m.values()].sort((a, b) => b.n - a.n);
  };
  return {
    total: apps.length,
    advanced: apps.filter((a) => STAGE_RANK[furthestStage(a)] >= STAGE_RANK["测评"]).length,
    byDirection: group((a) => a.snapshot?.directions ?? directionsOf(a.title)),
    bySector: group((a) => a.snapshot?.sectors ?? sectorsOf({ company: a.company, title: a.title, industry: "", note: "" })),
  };
}

export function nextStage(current: Stage, kind: EventKind): Stage {
  const target = KIND_TO_STAGE[kind];
  if (!target) return current;
  if (target === "未通过" || target === "Offer") return target;
  if (current === "未通过" || current === "放弃" || current === "Offer") return current;
  return STAGE_RANK[target] > STAGE_RANK[current] ? target : current;
}

/* ---------------- 招聘邮件识别 ---------------- */

const ATS_DOMAINS = /mokahr|moka|beisen|italent|hotjob|zhiye|dayee|feishu|jobs\.bytedance|careers|campus|nowcoder|niuke|51job|zhaopin|liepin|hr\.|talent|recruit|shixiseng|yingjiesheng|workday|greenhouse|lever\.co|smartrecruiters|successfactors/i;
const RECRUIT_WORDS = /校招|秋招|春招|招聘|笔试|面试|测评|测试邀请|offer|录用|简历|投递|网申|应聘|候选人|campus|recruit|interview|assessment|application|candidate/i;

export function isRecruiting(from: string, subject: string, body: string) {
  if (ATS_DOMAINS.test(from) && RECRUIT_WORDS.test(subject + body.slice(0, 500))) return true;
  return RECRUIT_WORDS.test(subject);
}

const KIND_RULES: [MailKind, RegExp][] = [
  ["未通过", /很遗憾|遗憾地|未能进入|未通过|不合适|婉拒|感谢您.{0,20}(关注|参与|投递).{0,40}(遗憾|未能|暂时)|人才库|unfortunately|regret|not to move forward|not been selected/i],
  ["Offer", /offer|录用通知|录用意向|意向书|录取通知|恭喜您.{0,10}(通过|获得)/i],
  ["HR面", /HR面|hr面试|人力.{0,4}面|HR ?interview/i],
  ["AI面", /AI ?面试|AI面|智能面试|AI ?interview/i],
  ["面试", /面试|interview|一面|二面|三面|终面|视频面|群面|无领导/i],
  ["笔试", /笔试|在线考试|编程考试|coding test|written test|online test|考试邀请/i],
  ["测评", /测评|性格测试|职业性格|能力测试|assessment|在线测试|OT\b/i],
  ["投递确认", /投递成功|申请成功|已收到您的(简历|申请)|简历已提交|application (received|submitted)|thank you for (applying|your application)/i],
];

/** 校招宣传：「校园招聘启动啦」「宣讲会」这类群发，正文里常写着"offer""面试"，但不是进度 */
const PROMO = /(校招|校园招聘|秋招|春招|招聘)[^。！!\n]{0,8}(启动|开启|开始啦|正式开始)|宣讲会|空中宣讲|直播宣讲/;
/** 正文里光出现 "offer" 不算（宣传邮件常写"斩获 offer"），要有发放、录用这类说法 */
const OFFER_IN_BODY = /录用通知|录用意向|意向书|录取通知|offer letter|恭喜您.{0,10}(通过|获得)|(发放|发出|给您).{0,6}offer|offer.{0,6}(发放|通知|审批)/i;

/** 先看标题，标题判断不出来再看正文开头 */
export function classifyMail(subject: string, body: string): MailKind {
  for (const [k, re] of KIND_RULES) if (re.test(subject)) return k;
  const head = body.slice(0, 800);
  // 2026-10-19：快手「2027届全球校园招聘」宣传邮件因为正文里有 offer 被认成了 Offer
  if (PROMO.test(subject) || PROMO.test(head)) return "其他";
  for (const [k, re] of KIND_RULES) if (k === "Offer" ? OFFER_IN_BODY.test(head) : re.test(head)) return k;
  return "其他";
}

/** 不是公司名的词：届别、年份、招聘批次、岗位字样（例如标题里的【2027届】） */
const NOT_COMPANY = /\d{2,4}\s*届|20\d{2}|秋招|春招|实习|岗位|职位/;
export const looksLikeCompany = (s: string) => s.trim().length >= 2 && !NOT_COMPANY.test(s) && !RECRUIT_WORDS.test(s);

/** 公司名：优先匹配已有投递/岗位里的公司，其次从标题【】和发件人名称里取 */
export function extractCompany(from: string, subject: string, body: string, known: string[]): string {
  const hay = normCompany(`${from} ${subject} ${body.slice(0, 1500)}`);
  const hit = [...known]
    .filter((k) => normCompany(k).length >= 2 && looksLikeCompany(k)) // 以前误识别出的"2027届"这类不能再拿来匹配
    .sort((a, b) => normCompany(b).length - normCompany(a).length)
    .find((k) => hay.includes(normCompany(k)));
  if (hit) return hit;
  const bracket = subject.match(/[【\[]([^】\]]{2,20})[】\]]/);
  if (bracket && looksLikeCompany(bracket[1])) return bracket[1].replace(/(校园)?招聘|校招|HR/g, "").trim();
  const name = from.match(/^"?([^"<]+?)"?\s*</)?.[1] ?? "";
  const cleaned = name.replace(/(校园)?招聘(团队|中心|组)?|校招|HR|Recruiting|Recruitment|Talent|Team|Campus|noreply|no-reply/gi, "").trim();
  if (looksLikeCompany(cleaned) && !/@/.test(cleaned)) return cleaned;
  const inSubject =
    subject.match(/^([一-龥A-Za-z]{2,12}?)(?:20\d\d|校园招聘|校招|秋招|春招)/) ??
    // "来自哔哩哔哩的面试邀请"
    subject.match(/来自([一-龥A-Za-z]{2,12}?)的/) ??
    subject.match(/(?:投递|应聘|申请|关注)了?([一-龥A-Za-z]{2,10}?)(?:的|20\d\d|校园|校招|岗位|职位|$|[，,。!！\s])/) ??
    // "联合利华 UFLP 在线测评邀请"：标题开头的中文名 + 空格
    subject.match(/^([一-龥]{2,8})\s+\S/);
  const c = inSubject?.[1] ?? "";
  return looksLikeCompany(c) ? c : "";
}

/**
 * 测评 / 笔试 / 面试的时间：返回本地时间 "YYYY-MM-DDTHH:mm"。
 * - 测评、AI面要的是截止时间："A 至 B"取 B；带"截止 / 前 / 失效 / 到期"的日期优先；标了"生效"的是开始时间，不要；
 *   只写"72小时内""有效期5个自然日""3个工作日内"的，按邮件发送时间往后推
 * - 笔试、面试有固定场次（"9月10日19:00至21:00"）取开始时间，没有就按截止时间处理
 * - 只写日期没写时间的，按当天 23:59
 */
export function extractTime(text: string, sent = new Date(), kind?: string): string | undefined {
  const t = text.replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ");
  const mentions = findDates(t, sent);
  const examLike = kind === "笔试" || kind === "面试" || kind === "HR面";
  const RANGE = /^\s*(?:至|到|~|～|—|–|-|to)\s*/i;
  const AFTER_DEADLINE = /^[\s)）】\]]*(?:前|之前|以前|截止|失效|到期|过期|之间|后截止|为止)/;
  const BEFORE_DEADLINE = /(截止|截至|deadline|失效|到期|有效期至|due)[^。；;！!]{0,12}$/i;
  const AFTER_START = /^[\s)）】\]]*(?:生效|开始|起)/;

  let session: Date | undefined;
  const deadlines: Date[] = [];
  const starts = new Set<number>();
  mentions.forEach((m, i) => {
    const after = t.slice(m.end, m.end + 16);
    const before = t.slice(Math.max(0, m.start - 16), m.start);
    const range = after.match(RANGE);
    const next = mentions[i + 1];
    if (range && next && next.start - m.end <= range[0].length + 1) {
      starts.add(i); // "A 至 B"：A 是开始
      deadlines.push(next.at);
    } else if (range && m.hasTime && /^\d{1,2}[:：]\d{2}/.test(after.slice(range[0].length))) {
      session ??= m.at; // "19:00至21:00"：固定场次
    }
    if (AFTER_START.test(after) || /(从|自)\s*$/.test(before)) starts.add(i);
    else if (AFTER_DEADLINE.test(after) || BEFORE_DEADLINE.test(before)) deadlines.push(m.at);
  });

  if (examLike && session) return localTime(session);
  // 截止时间不会早于发邮件的时间；有多个取最晚的（"请于9月10日12:00前安装浏览器"这类准备事项更早）
  const valid = deadlines.filter((d) => d.getTime() > sent.getTime() - 3600_000);
  if (valid.length) return localTime(new Date(Math.max(...valid.map((d) => d.getTime()))));
  const rel = relativeDeadline(t, sent);
  if (rel) return localTime(rel);
  if (session) return localTime(session);
  // 兜底：第一个带具体时间、不是"生效"时间、晚于发信时间的日期（发信时间本身常被写成"有效期开始"）
  const rest = mentions.find((m, i) => m.hasTime && !starts.has(i) && m.at.getTime() > sent.getTime() + 3600_000);
  return rest ? localTime(rest.at) : undefined;
}

type DateMention = { at: Date; hasTime: boolean; start: number; end: number };

const WEEK = String.raw`(?:\s*(?:[（(][^）)]{1,6}[）)]|周[一二三四五六日天]|星期[一二三四五六日天]))?`;
const CLOCK = String.raw`(?:\s*(上午|下午|晚上|中午|凌晨)?\s*(\d{1,2})\s*[:：点时]\s*(\d{2})?(?:[:：]\d{2})?)?`;
const DATE_PATTERNS: { re: RegExp; parts: (m: RegExpExecArray) => (string | undefined)[] }[] = [
  // 2026年9月15日 周二 13:04 / 2026-09-15 23:59 / 2026/09/15
  { re: new RegExp(String.raw`(\d{4})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?` + WEEK + CLOCK, "g"), parts: (m) => [m[1], m[2], m[3], m[4], m[5], m[6]] },
  // 9月10日 19:00
  { re: new RegExp(String.raw`(?<![\d年/.-])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]` + WEEK + CLOCK, "g"), parts: (m) => [undefined, m[1], m[2], m[3], m[4], m[5]] },
  // 09-10 15:43
  { re: /(?<![\d/.-])(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?!\d)/g, parts: (m) => [undefined, m[1], m[2], undefined, m[3], m[4]] },
  // 英文邮件：22/09/2026 10:00（日在前）
  { re: /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/g, parts: (m) => (+m[2] > 12 ? [m[3], m[1], m[2], undefined, m[4], m[5]] : [m[3], m[2], m[1], undefined, m[4], m[5]]) },
];

function findDates(t: string, sent: Date): DateMention[] {
  const out: DateMention[] = [];
  for (const { re, parts } of DATE_PATTERNS) {
    for (const m of t.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (out.some((x) => start < x.end && end > x.start)) continue;
      const [y, mo, d, ampm, h, mi] = parts(m as RegExpExecArray);
      const month = +mo!;
      const day = +d!;
      const year = y ? +y : guessYear(month, sent);
      let hour = h === undefined ? 23 : +h;
      const minute = h === undefined ? 59 : mi ? +mi : 0;
      if ((ampm === "下午" || ampm === "晚上") && hour < 12) hour += 12;
      if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) continue;
      out.push({ at: new Date(year, month - 1, day, hour, minute), hasTime: h !== undefined, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** "72小时内""有效期为5个自然日""3个工作日内""7日后失效"：从发信时间往后推 */
function relativeDeadline(t: string, sent: Date): Date | undefined {
  const re = /(\d{1,3})\s*个?\s*(小时|h\b|hours?|自然日|工作日|天|日|days?)/gi;
  for (const m of t.matchAll(re)) {
    const before = t.slice(Math.max(0, m.index! - 20), m.index);
    const after = t.slice(m.index! + m[0].length, m.index! + m[0].length + 12);
    // "24小时客服""开考前5小时"不是期限；"9月11日"的"11日"是日期不是天数
    if (/^\s*(客服|服务|热线|在线|人工)/.test(after) || /(前|月)\s*$/.test(before)) continue;
    if (!/内|有效|失效|起算|expire|within/i.test(before + after)) continue;
    const n = +m[1];
    const unit = m[2].toLowerCase();
    const d = new Date(sent);
    if (unit === "小时" || unit === "h" || unit.startsWith("hour")) d.setHours(d.getHours() + n);
    else if (unit === "工作日") for (let left = n; left > 0; ) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0 && d.getDay() !== 6) left--;
    }
    else d.setDate(d.getDate() + n);
    return d;
  }
  return undefined;
}

function localTime(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 笔试 / 面试 / 测评链接：优先带考试、面试关键词或招聘系统域名的链接 */
export function extractLink(text: string): string | undefined {
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"'）)】，。]+/g)].map((m) => m[0]);
  const good = urls.filter((u) => !/unsubscribe|logo|\.png|\.jpg|\.gif|privacy|beian/i.test(u));
  return (
    good.find((u) => /exam|test|interview|assessment|meeting|zoom|tencent|feishu|moka|beisen|zhiye|hotjob|nowcoder|dayee|italent/i.test(u)) ??
    good[0]
  );
}

/** 邮件对应哪条投递：公司名匹配；同一家公司多条时，看岗位名有没有出现在邮件里 */
export function matchApplication(company: string, subject: string, body: string, apps: Application[]): string | undefined {
  if (!company) return undefined;
  const c = normCompany(company);
  const same = apps.filter((a) => {
    const ac = normCompany(a.company);
    return ac.length >= 2 && (ac.includes(c) || c.includes(ac));
  });
  if (same.length <= 1) return same[0]?.id;
  const text = subject + body.slice(0, 2000);
  const byTitle = same.find((a) => a.title && text.includes(a.title));
  if (byTitle) return byTitle.id;
  // 选还没结束、最近更新的那条
  return same.filter((a) => STAGE_RANK[a.stage] < 9).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? same[0].id;
}

/* ---------------- CSV ---------------- */

export function parseCsv(raw: string): string[][] {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cur.trim());
      cur = "";
    } else if (ch === "\n") {
      row.push(cur.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  row.push(cur.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

/* ---------------- 网申截止（DDL） ---------------- */

/**
 * 进日程的网申截止：有明确截止日期、这家公司还没投递过、在未来 N 天内，
 * 并且是收藏的，或属于「我的方向」（没选方向时全部算）。
 */
export function upcomingDeadlines(jobs: JobPosting[], apps: Application[], myDirections: string[], now: Date, days = 30) {
  const applied = new Set(apps.flatMap((a) => [a.jobId, ...(a.jobIds ?? [])]).filter(Boolean));
  const appliedCompanies = new Set(apps.map((a) => normCompany(a.company)));
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const until = new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10);
  return jobs
    .filter((j) => j.deadlineAt && j.deadlineAt >= today && j.deadlineAt <= until && !applied.has(j.id) && !appliedCompanies.has(normCompany(j.company)))
    .filter((j) => j.starred || !myDirections.length || j.directions.some((d) => myDirections.includes(d)))
    .map((j) => ({ job: j, at: `${j.deadlineAt}T23:59` }))
    .sort((a, b) => a.at.localeCompare(b.at));
}
