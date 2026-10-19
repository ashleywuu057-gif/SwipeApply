/**
 * 从上传的简历原文里读出「简历抬头」：姓名、电话、邮箱、教育经历、工作技能&其他。
 * 只在本机用规则读，不经过模型（姓名、电话这些在发给模型前本来就会被脱敏，模型也看不到）。
 * 读不准的就留空，导入最后一步「确认简历抬头」让用户改。
 *
 * 版式上的规律（PDF 抽出来的文字）：
 * - 模块标题单独一行（「教育经历」「实习经历」「工作技能&其他」）；有的 PDF 里标题会排到姓名前面
 * - 要点以空格或圆点开头；一条要点太长时折到下一行，下一行开头没有空格
 * - 学校那一行以起止时间结尾（2021.09-2025.06）
 */
import type { Profile } from "./native/types";

const CJK = "[\\u4e00-\\u9fa5]";
const DATE_RANGE = /\d{4}\s*[.\-/年]\s*\d{1,2}\s*月?\s*[-–—~～至到]+\s*(?:\d{4}\s*[.\-/年]\s*\d{1,2}\s*月?|至今|今|present|now)/i;
const SECTION = /^(教育经历|教育背景|学历背景|学历|education|实习经历|工作经历|工作经验|项目经历|项目经验|校园经历|在校经历|实践经历|社会实践|科研经历|研究经历|获奖情况|获奖经历|荣誉奖项|荣誉证书|奖项|证书|技能|专业技能|个人技能|技能证书|技能特长|工作技能.*|技能.{0,4}其他|其他|其它|其他信息|附加信息|补充信息|自我评价|个人评价|个人总结|兴趣爱好|internships?|experience|skills?.*|projects?|awards?)$/i;
const EDU = /^(教育经历|教育背景|学历背景|学历|education)$/i;
const SKILLS = /^(技能|专业技能|个人技能|技能证书|技能特长|工作技能.*|技能.{0,4}其他|其他|其它|其他信息|附加信息|补充信息|skills?.*)$/i;
const NOT_NAME = /经历|经验|技能|教育|背景|项目|实习|工作|简历|个人|信息|奖项|荣誉|证书|评价|爱好|其他|校园|实践|求职|意向|联系|电话|邮箱|自我/;

const PHONE = /(?:\(\s*\+?86\s*\)\s*|\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// 要点符号：常见圆点，加上 Word 导出 PDF 时的 Wingdings 符号（落在 Unicode 私用区，例如 U+F09F）
const BULLET = /^[\s•·●○◆◇■□▪▫►▶➢✓✔\-*-]+/;

const isSection = (l: string) => l.length <= 12 && SECTION.test(l.replace(/\s+/g, ""));
const isContact = (l: string) => PHONE.test(l) || EMAIL.test(l) || /电话|手机|邮箱|微信|e-?mail/i.test(l);

/** 一段里的行合成要点：以空格/圆点开头或带起止时间的是新的一行，其余接到上一行后面（PDF 折行） */
function items(raw: string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const t = r.replace(BULLET, "").trim();
    if (!t) continue;
    const fresh = BULLET.test(r) || DATE_RANGE.test(t) || !out.length;
    if (fresh) out.push(t);
    else out[out.length - 1] += t;
  }
  return out;
}

/** 姓名：前几行里单独的 2~4 个汉字（或英文名），不是模块标题、不是联系方式；也认「姓名：张三」 */
function findName(lines: string[]): string {
  for (const l of lines.slice(0, 40)) {
    const m = l.match(new RegExp(`姓\\s*名\\s*[:：]\\s*(${CJK}{2,4})`));
    if (m) return m[1];
  }
  for (const l of lines.slice(0, 6)) {
    const t = l.replace(/\s+/g, "").replace(/(的)?(个人)?(简历|resume|cv)$/i, "");
    if (new RegExp(`^${CJK}{2,4}$`).test(t) && !NOT_NAME.test(t) && !isSection(l.trim())) return t;
    if (/^[A-Z][a-z]+(?: [A-Z][a-z]+){1,2}$/.test(l.trim())) return l.trim();
  }
  return "";
}

/** 取某个模块下面的行（到下一个模块标题为止），去掉混进来的姓名和联系方式行 */
function section(lines: string[], which: RegExp, name: string): string[] {
  const i = lines.findIndex((l) => l.trim().length <= 12 && which.test(l.trim().replace(/\s+/g, "")));
  if (i < 0) return [];
  const body: string[] = [];
  for (const l of lines.slice(i + 1)) {
    // 下一个模块标题，或者中英文简历里英文版开始（单独一行的英文名）就停
    if (isSection(l.trim()) || /^[A-Z][a-z]+(?: [A-Z][a-z]+){1,2}$/.test(l.trim())) break;
    if (isContact(l) || (name && l.replace(/\s+/g, "") === name)) continue;
    body.push(l);
  }
  return body;
}

export function profileFromText(text: string): Partial<Profile> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const name = findName(lines);
  const head = lines.slice(0, 40).join("\n");
  const phone = head.match(PHONE)?.[0].trim() ?? "";
  const email = head.match(EMAIL)?.[0] ?? "";
  const education = items(section(lines, EDU, name)).slice(0, 12).join("\n");
  const extra = items(section(lines, SKILLS, name)).slice(0, 8).join("\n");
  const out: Partial<Profile> = {};
  if (name) out.name = name;
  if (phone) out.phone = phone;
  if (email) out.email = email;
  if (education) out.education = education;
  if (extra) out.extra = extra;
  return out;
}

/** 只填还空着的栏，不覆盖用户已经填过的；返回填了哪些 */
export function fillProfile(current: Profile, found: Partial<Profile>): { profile: Profile; filled: (keyof Profile)[] } {
  const profile = { ...current };
  const filled: (keyof Profile)[] = [];
  for (const k of ["name", "phone", "email", "education", "extra"] as const) {
    if (!String(profile[k] ?? "").trim() && found[k]) {
      profile[k] = found[k]!;
      filled.push(k);
    }
  }
  if (!profile.nickname?.trim() && profile.name) profile.nickname = profile.name.slice(-2);
  return { profile, filled };
}
