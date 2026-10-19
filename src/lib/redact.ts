/**
 * 本地脱敏：发给云端模型前，把敏感信息换成占位符；结果回来后再换回去。
 * 全部在本机用规则完成，不借助任何外部服务。
 *
 * 屏蔽内容：
 *  - 你填的敏感词（公司名、客户名、项目代号……）
 *  - 联系方式：邮箱、手机号、身份证号、微信号
 *  - 人名：带称呼的（张伟经理、王老师）、有上下文线索的（和张伟讨论、负责人：李娜）、英文名（mentor Alice）、@某人
 *  - 昵称：阿X、小X/老X（X 为姓）、X哥/X姐/X总、叠字（婷婷）、双字母（yy）
 *  - 表格和数据块：整张表格、连续多行以数字为主的内容（通常是图表数据）
 * 规则识别会有误判，隐私检查页可以逐个放行（加入"不屏蔽的词"）。
 */

export interface AutoRules {
  contact: boolean;
  person: boolean;
  nickname: boolean;
  table: boolean;
}

export const DEFAULT_RULES: AutoRules = { contact: true, person: true, nickname: true, table: true };

export interface RedactSettings {
  sensitiveTerms: string[];
  allowTerms?: string[];
  autoRules?: Partial<AutoRules>;
}

export interface Hit {
  placeholder: string;
  original: string;
  label: string;
  count: number;
}

export interface RedactResult {
  text: string;
  map: Record<string, string>;
  hits: Hit[];
}

/** 跨文件共享的上下文：在一份文件里识别出的人名/昵称，在所有文件里都屏蔽 */
export interface RedactContext {
  terms: string[];
  allow: string[];
  rules: AutoRules;
  people: Set<string>;
  nicknames: Set<string>;
}

/* ---------------- 词表 ---------------- */

const SURNAMES =
  "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤";
const DOUBLE_SURNAMES = ["欧阳", "司马", "诸葛", "上官", "慕容", "东方", "夏侯", "令狐", "皇甫", "尉迟", "公孙", "司徒", "长孙"];
const S = `(?:${DOUBLE_SURNAMES.join("|")}|[${SURNAMES}])`;
const CJK = "[\\u4e00-\\u9fa5]";

/** 默认不屏蔽的常见词（避免"小程序""高级经理""拼多多"这类被误伤） */
const BUILTIN_ALLOW = [
  "小程序", "小红书", "小米", "小时", "小组", "小结", "小学", "小说", "小型", "小于", "小伙伴", "小计", "小数", "小众", "小区", "小店", "小视频", "小姐姐", "小哥哥",
  "老师", "老板", "老牌", "老用户", "老化", "老年", "老客", "老品", "老版",
  "阿里", "阿里巴巴", "阿里云", "阿姨", "阿拉伯", "阿根廷", "阿尔", "阿联酋", "阿富汗", "阿迪达斯", "阿斯利康",
  "拼多多", "多多", "滴滴", "陌陌", "当当", "探探", "嘀嗒",
  "高级", "高层", "高端", "常务", "项目", "文案", "任课", "方案", "石油", "江苏", "江西", "金融", "金牌", "黄金", "周末", "周报", "周会", "周期",
  "于是", "余额", "程序", "程度", "白领", "白皮书", "万元", "钱包", "马上", "田野", "谢谢", "许多", "向上", "史上", "毛利", "龙头", "严格", "付费", "付款", "方向", "方法", "方面", "段落",
  "任何", "任务", "任职", "常见", "常用", "高效", "高度", "高质量", "方便", "方式", "严重", "严谨", "白天", "金额", "程序员", "向量", "付出", "许可", "段位", "于此", "余下", "万一", "钱款",
  "学姐", "学长", "师姐", "师兄", "师哥", "大哥", "大姐", "老总", "各位", "同学们",
];

const REDUP_ALLOW = new Set(
  "常常 看看 刚刚 渐渐 慢慢 天天 人人 往往 偏偏 仅仅 稍稍 默默 纷纷 处处 时时 事事 样样 个个 年年 月月 日日 步步 层层 重重 久久 统统 足足 整整 轻轻 好好 想想 试试 说说 聊聊 谈谈 等等 谢谢 哈哈 呵呵 嘻嘻 妈妈 爸爸 哥哥 姐姐 弟弟 妹妹 爷爷 奶奶 宝宝 星星 多多 滴滴 陌陌 当当 探探 明明 白白 清清 楚楚 高高 大大 小小 长长 短短 早早 快快 满满 实实 在在 家家 户户 点点 滴滴 方方 面面 条条 框框 平平 淡淡 普普 通通 冷冷 暖暖 静静 悄悄 常常".split(" "),
);

const ROLE = "经理|总监|老师|同学|主管|组长|老板|导师|同事|主任|院长|教授|博士|学长|学姐|师兄|师姐|leader|mentor|Leader|Mentor|HR";
const CUE = "和|跟|与|向|找|问|请|让|叫|被|给|由|帮|陪|同|对接|汇报给|抄送";
const LABEL = "姓名|负责人|对接人|汇报人|作者|联系人|审核人|面试官|导师|mentor|Mentor|leader|Leader|Owner|owner|PM|PMO|经办人|署名|签字";
const BOUND = "(?=$|[\\s，。、；：！？,.;:!?（）()“”\"'的说在和与跟是也都就把被向对给让一起了们会将已来去要可还])";

/* ---------------- 主函数 ---------------- */

export function buildContext(settings: RedactSettings, texts: string[]): RedactContext {
  const ctx: RedactContext = {
    terms: clean(settings.sensitiveTerms),
    allow: clean([...(settings.allowTerms ?? []), ...BUILTIN_ALLOW]),
    rules: { ...DEFAULT_RULES, ...(settings.autoRules ?? {}) },
    people: new Set(),
    nicknames: new Set(),
  };
  // 预扫描所有文件，收集人名和昵称
  for (const t of texts) {
    const p = protect(t, ctx.allow);
    if (ctx.rules.person) detectPeople(p.text).forEach((n) => ctx.people.add(p.restore(n)));
    if (ctx.rules.nickname) detectNicknames(p.text).forEach((n) => ctx.nicknames.add(p.restore(n)));
  }
  const allowSet = new Set(ctx.allow);
  for (const set of [ctx.people, ctx.nicknames]) for (const n of [...set]) if (allowSet.has(n) || n.length < 2) set.delete(n);
  return ctx;
}

export function redact(input: string, ctx: RedactContext, map: Record<string, string> = {}): RedactResult {
  const reverse = new Map(Object.entries(map).map(([k, v]) => [v, k]));
  const counters: Record<string, number> = {};
  for (const k of Object.keys(map)) {
    const m = k.match(/^【(.+?)(\d+)】$/);
    if (m) counters[m[1]] = Math.max(counters[m[1]] ?? 0, Number(m[2]));
  }
  const hitCount = new Map<string, { label: string; n: number }>();
  const p = protect(input, ctx.allow);
  let text = p.text;

  const ph = (label: string, raw: string) => {
    const original = p.restore(raw);
    let key = reverse.get(original);
    if (!key) {
      counters[label] = (counters[label] ?? 0) + 1;
      key = `【${label}${counters[label]}】`;
      reverse.set(original, key);
      map[key] = original;
    }
    const h = hitCount.get(key) ?? { label, n: 0 };
    h.n++;
    hitCount.set(key, h);
    return key;
  };
  // 只在"还没被替换"的文字上执行规则，不碰已有的占位符
  const apply = (re: RegExp, fn: (m: string, ...g: string[]) => string) => {
    text = text
      .split(/(【[^【】]+?\d+】)/)
      .map((part, i) => (i % 2 ? part : part.replace(re, fn as (substring: string, ...args: unknown[]) => string)))
      .join("");
  };
  const replaceWords = (words: Iterable<string>, label: string) => {
    const list = [...words].sort((a, b) => b.length - a.length);
    for (const w of list) apply(new RegExp(escapeRe(p.protectWord(w)), "gi"), (m) => ph(label, m));
  };

  // 1. 表格和数据块（整块替换）
  if (ctx.rules.table) {
    text = replaceBlocks(text, (block, kind) => ph(kind, block));
  }
  // 2. 用户敏感词
  replaceWords(ctx.terms, "敏感词");
  // 3. 联系方式
  if (ctx.rules.contact) {
    apply(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (m) => ph("邮箱", m));
    apply(/(?<!\d)\d{17}[\dXx](?!\d)/g, (m) => ph("身份证", m));
    apply(/(?<!\d)1[3-9]\d{9}(?!\d)/g, (m) => ph("手机", m));
    apply(/(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/g, (m) => ph("电话", m));
    apply(/(微信|WeChat|wechat|wx|vx|VX)[:：\s]*[A-Za-z][\w-]{5,19}/g, (m) => ph("微信", m));
  }
  // 4. 人名（包括在其他文件里识别出的）
  if (ctx.rules.person) {
    replaceWords(ctx.people, "人名");
    apply(/(?<![\w.])@[\w\u4e00-\u9fa5]{1,16}/g, (m) => ph("人名", m));
  }
  // 5. 昵称
  if (ctx.rules.nickname) replaceWords(ctx.nicknames, "昵称");

  text = p.restore(text);
  const hits = [...hitCount.entries()].map(([placeholder, h]) => ({
    placeholder,
    original: map[placeholder],
    label: h.label,
    count: h.n,
  }));
  return { text, map, hits };
}

/** 把模型返回结果里的占位符还原成原文 */
export function restore<T>(value: T, map: Record<string, string>): T {
  if (typeof value === "string") return value.replace(/【[^【】]+?\d+】/g, (k) => map[k] ?? k) as T;
  if (Array.isArray(value)) return value.map((v) => restore(v, map)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v, map)])) as T;
  }
  return value;
}

/* ---------------- 识别规则 ---------------- */

export function detectPeople(text: string): string[] {
  const found = new Set<string>();
  const add = (n?: string) => n && n.length >= 2 && found.add(n.trim());

  // 张伟经理 / 李娜老师 / 王总监（只有姓的"王经理"不收集，交给昵称规则处理）
  for (const m of text.matchAll(new RegExp(`(${S}${CJK}{1,2}?)(?:${ROLE})`, "g"))) add(m[1]);
  // 和张伟讨论 / 找李娜确认（先试三字名，再试两字名）
  for (const m of text.matchAll(new RegExp(`(?:${CUE})(${S}${CJK}{2})${BOUND}|(?:${CUE})(${S}${CJK})`, "g"))) {
    const n = m[1] ?? m[2];
    // 三字名最后一个字是动词时，其实是两字名 + 动词（"和张伟说"）
    add(m[1] && /[说讲讨聊沟汇问请做看写发改确对会面将已来去要]$/.test(n) ? n.slice(0, -1) : n);
  }
  // 业务负责人李娜 / 面试官王芳（称呼在前、没有冒号）
  for (const m of text.matchAll(new RegExp(`(?:负责人|经理|总监|主管|面试官|招聘官|联系人|导师|组长|同事|老师|HR|hr|leader|mentor)(${S}${CJK}{2})${BOUND}|(?:负责人|经理|总监|主管|面试官|招聘官|联系人|导师|组长|同事|老师|HR|hr|leader|mentor)(${S}${CJK})`, "g"))) {
    const n = m[1] ?? m[2];
    add(m[1] && /[说讲讨聊沟汇问请做看写发改确对会面将已来去要]$/.test(n) ? n.slice(0, -1) : n);
  }
  // 负责人：李娜 / mentor: Alice Wang
  for (const m of text.matchAll(new RegExp(`(?:${LABEL})\\s*[:：]\\s*(${CJK}{2,4}|[A-Z][a-z]+(?:\\s[A-Z][a-z]+)?)`, "g"))) add(m[1]);
  // 简历抬头的本人姓名："张三 简历" / "张三的个人简历" / 开头单独一行的名字
  const first = text.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  const head = first.match(new RegExp(`^(${S}(?:(?!的)${CJK}){1,2})\\s*(?:的)?(?:个人)?(?:简历|Resume|CV)?$`, "i"));
  if (head) add(head[1]);
  // @陈晨
  for (const m of text.matchAll(/(?<![\w.])@([\u4e00-\u9fa5]{2,4}|[A-Za-z][\w]{1,15})/g)) add(m[1]);
  // mentor Alice / with Tom / Hi Jack
  for (const m of text.matchAll(/\b(?:mentor|leader|manager|boss|with|Mentor|Leader|Manager|Hi|Dear|Thanks)\s+([A-Z][a-z]{2,12})\b/g)) add(m[1]);
  return [...found];
}

export function detectNicknames(text: string): string[] {
  const found = new Set<string>();
  // 阿强 / 阿May
  for (const m of text.matchAll(new RegExp(`阿(?:${CJK}|[A-Z][a-z]{1,8})`, "g"))) found.add(m[0]);
  // 小王 / 老李
  for (const m of text.matchAll(new RegExp(`[小老]${S}`, "g"))) found.add(m[0]);
  // 王经理 / 李老师（只有姓 + 称呼）
  for (const m of text.matchAll(new RegExp(`${S}(?:${ROLE})`, "g"))) found.add(m[0]);
  // 强哥 / 婷姐 / 王总
  for (const m of text.matchAll(new RegExp(`(${CJK})[哥姐](?![妹弟们])`, "g"))) {
    if (!/[学师大小表堂空帅靓老亲姐哥兄弟阿各]/.test(m[1])) found.add(m[0]);
  }
  for (const m of text.matchAll(new RegExp(`${S}总(?![结体共部监裁数计额之是量价公经时和览包线分成而的])`, "g"))) found.add(m[0]);
  // 叠字：婷婷 / 园园
  for (const m of text.matchAll(new RegExp(`(${CJK})\\1`, "g"))) if (!REDUP_ALLOW.has(m[0])) found.add(m[0]);
  // 双字母：yy / JJ
  for (const m of text.matchAll(/(?<![A-Za-z])([A-Za-z])\1(?![A-Za-z])/g)) found.add(m[0]);
  return [...found];
}

const RANGE = /\d{4}\s*[.\-/年]\s*\d{1,2}\s*月?\s*[-–—~～至到]+/;

/** 找出表格和数据块，整块替换 */
function replaceBlocks(text: string, fn: (block: string, kind: string) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l) || (l.match(/\t/g)?.length ?? 0) >= 2;
  const isDataRow = (l: string) => {
    const s = l.replace(/\s/g, "");
    if (s.length < 4 || RANGE.test(l)) return false;
    const digits = s.replace(/[^\d.%,]/g, "").length;
    return digits / s.length >= 0.35 || (l.match(/\d+(?:\.\d+)?%?/g)?.length ?? 0) >= 3;
  };
  while (i < lines.length) {
    let consumed = false;
    for (const [test, kind, min] of [[isTableRow, "表格", 2], [isDataRow, "数据", 3]] as const) {
      let j = i;
      while (j < lines.length && test(lines[j])) j++;
      if (j - i < min) continue;
      const block = lines.slice(i, j).join("\n");
      // 表格里有起止时间的，多半是表格版简历，保留给模型识别经历
      if (kind === "表格" && RANGE.test(block)) continue;
      out.push(fn(block, kind));
      i = j;
      consumed = true;
      break;
    }
    if (!consumed) out.push(lines[i++]);
  }
  return out.join("\n");
}

/* ---------------- 工具 ---------------- */

/** 白名单词先换成私有字符保护起来，识别完再换回 */
function protect(text: string, allow: string[]) {
  const words = [...allow].sort((a, b) => b.length - a.length);
  const tokens: string[] = [];
  let t = text;
  for (const w of words) {
    if (!t.includes(w)) continue;
    const token = `${tokens.length}`;
    tokens.push(w);
    t = t.split(w).join(token);
  }
  const restoreFn = (s: string) => s.replace(/(\d+)/g, (_, n) => tokens[Number(n)]);
  const protectWord = (w: string) => {
    let r = w;
    tokens.forEach((tok, k) => (r = r.split(tok).join(`${k}`)));
    return r;
  };
  return { text: t, restore: restoreFn, protectWord };
}

function clean(a: string[]) {
  return [...new Set((a ?? []).map((t) => t.trim()).filter((t) => t.length >= 2))];
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
