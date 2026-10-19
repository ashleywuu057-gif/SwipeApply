/**
 * 岗位的细分方向：职位名里「产品经理」「运营」这类职能词前面的修饰词，例如
 *   【27届校招】整车产品经理培训生 → 整车
 *   RC/RM专项-硬件产品经理       → 硬件
 *   具身数据产品经理-觅蜂子公司   → 具身数据
 *   产品经理（硬件方向）          → 硬件
 * 左滑「不想做这个方向」时，用户不喜欢的是这个细分方向，不是产品经理这个职能（用户明确说过），所以按它来学。
 * 前端（跳过理由按钮）和后端（学偏好）共用，纯函数，不依赖服务端。
 */

const ROLE = /(产品经理|产品运营|产品策划|产品专员|产品助理|产品|运营|策划|分析师|设计师|工程师|研究员|专员|经理)/;
const GENERIC = /(\d{2,4}届|校招|校园招聘|应届|实习生?|管培生?|培训生|储备|高级|资深|初级|中级|海外|国际|全球|集团|总部|方向)/g;

export function roleFocus(title: string, company = ""): string {
  // 括号里写明的方向优先：产品经理（硬件方向）
  const inBracket = title.match(/[（(]([^（）()]{1,8}?)方向[）)]/);
  if (inBracket) return clean(inBracket[1], company);
  const t = title.replace(/【[^】]*】|\[[^\]]*\]|[（(][^）)]*[）)]/g, "");
  const m = t.match(ROLE);
  if (!m || m.index === undefined) return "";
  const before = clean(t.slice(0, m.index).split(/[-—_/·|｜\s]+/).filter(Boolean).at(-1) ?? "", company);
  if (before) return before;
  // 职能词在前、方向写在后面：产品经理-整车
  const after = t.slice(m.index + m[0].length).match(/^[-—_·\s]+([^-—_·\s]{2,8})/);
  return after ? clean(after[1], company) : "";
}

function clean(s: string, company: string) {
  let v = s.replace(GENERIC, "").trim();
  if (company) v = v.replace(company, "").trim();
  if (v.length > 8) v = v.slice(-6);
  return v.length >= 2 ? v : "";
}

/*
 * 一个岗位名里列了一串大类（「开发/算法/产品/运营」「技术、美术、产品、运营等」，jobworthy 来的公司官网入口）：
 * 卡片上只写一个——先看用户要的方向（对话框里说的、今天指定的、投递方向），再看和简历最相关的（用户明确要求）。
 */
const LIST_SEP = /\s*[/、,，;；|｜\n]\s*/;
const LIST_TAIL = /(等.*|全面开放|全大类岗位|岗位全面开放|多个岗位|各类岗位)$/;

/**
 * 只用空格隔开的一串（「技术类 游戏策划类 美术类」）：按空格拆；不带汉字的小段（AI、Java）并到后一段，
 * 免得把「AI 视频设计」「Product Manager」拆散
 */
function bySpace(s: string): string[] {
  const chunks = s.trim().split(/\s+/);
  if (chunks.length < 2) return [s];
  const out: string[] = [];
  let carry = "";
  for (const c of chunks) {
    if (/[一-龥]/.test(c)) {
      out.push(carry ? `${carry} ${c}` : c);
      carry = "";
    } else carry = carry ? `${carry} ${c}` : c;
  }
  if (carry && out.length) out[out.length - 1] += ` ${carry}`;
  else if (carry) out.push(carry);
  return out;
}

/** 拆成各个岗位；不是一串大类就返回空数组 */
export function splitRoles(title: string): string[] {
  const parts = title
    .trim()
    .replace(LIST_TAIL, "")
    .split(LIST_SEP)
    .flatMap(bySpace)
    // 去掉「技术研发类：」这种分组前缀、「（多方向）」这种没信息的括号
    .map((s) =>
      s
        .replace(/^[^：:]{1,8}[：:]\s*/, "")
        .replace(/[（(](多方向|多个方向|若干|不限)[）)]/g, "")
        .replace(LIST_TAIL, "")
        .replace(/^(全|各)/, "")
        .trim(),
    )
    .filter((s) => s.length >= 2);
  return parts.length >= 2 ? parts : [];
}

const ROLE_WORDS = ["产品", "运营", "设计", "美术", "研发", "技术", "开发", "算法", "数据", "市场", "营销", "销售", "策划", "商业化", "策略", "用户研究", "职能", "发行", "游戏", "AI", "管培"];
const RELATED: Record<string, string[]> = { 产品: ["策划"], 运营: ["发行"], 设计: ["美术"], 研发: ["开发", "程序", "技术"], 技术: ["开发", "程序", "研发"], 市场: ["营销", "品牌"] };
/** 简历里的职能词（例如「商业化策略产品经理」→ 商业化、策略、产品） */
export const resumeRoleWords = (roles: string[]) => ROLE_WORDS.filter((w) => roles.some((r) => r.toLowerCase().includes(w.toLowerCase())));

/**
 * 挑一个岗位：wants 是用户要的方向（命中一个 +10，越靠前越重要），resume 是简历里的职能词（每个 +2）。都没命中就用第一个。
 * 只剩大类名时补个「岗」字，例如「产品」→「产品岗」。
 */
export function pickRole(title: string, wants: string[], resume: string[]): string {
  const parts = splitRoles(title);
  if (!parts.length) return title;
  const has = (p: string, w: string) => Boolean(w) && p.toLowerCase().includes(w.toLowerCase());
  // 近义的大类（游戏公司把产品叫策划）：命中算一半
  const near = (p: string, w: string) => (RELATED[w] ?? []).some((r) => has(p, r));
  const score = (p: string) =>
    wants.reduce((n, w, i) => n + (has(p, w) ? 10 + Math.max(0, 5 - i) : near(p, w) ? 5 : 0), 0) + resume.reduce((n, w) => n + (has(p, w) ? 2 : near(p, w) ? 1 : 0), 0);
  const best = parts.reduce((a, b) => (score(b) > score(a) ? b : a));
  return /(经理|师|生|员|岗|官|专家|顾问)$/.test(best) ? best : `${best.replace(/类$/, "")}岗`;
}

/** 跳过理由按钮上的字：有细分方向就写出来，让用户知道学的是什么 */
export const directionReason = (focus: string) => (focus ? `不想做「${focus}」方向` : "不想做这个方向");
/** 从理由里取回细分方向 */
export const focusFromReason = (reason: string) => reason.match(/^不想做「(.+)」方向$/)?.[1] ?? "";
