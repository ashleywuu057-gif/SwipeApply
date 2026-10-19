import "server-only";
import { createHash } from "crypto";
import { resumeKeywords } from "./campus-search";
import { readApply, readMemory } from "./native/store";
import type { Profile, Resume } from "./native/types";
import { readLibrary } from "./store";
import { normCompany } from "./tracker-logic";
import { readTracker } from "./tracker-store";
import type { JobPosting } from "./tracker-types";

/**
 * 和浏览器插件「投简助手 ApplyKit」（extension/ 目录，MIT）对接：
 * - 插件点「从SwipeApply同步履历」时，把简历抬头、固定的教育经历，和这个岗位定稿的定制简历（只有勾选的经历、改好的句子）
 *   转成 ApplyKit 的履历格式（applykit-profile schemaVersion 1），由插件去填网申表单；没有定制简历就不同步，不会把整个素材库填上去
 * - 插件里确认「已在官网提交」后通知这里，记进我的投递，算一次有效投递
 * 只在本机之间传：插件请求的是 localhost。
 */

type PartialDate = { year: number; month?: number };
type EndDate = PartialDate | { present: true };

function parseDate(s: string | undefined): PartialDate | null {
  const m = (s ?? "").match(/(\d{4})\s*[.\-/年]?\s*(\d{1,2})?/);
  if (!m) return null;
  const year = +m[1];
  const month = m[2] ? +m[2] : undefined;
  if (year < 1900 || year > 2100) return null;
  return month && month >= 1 && month <= 12 ? { year, month } : { year };
}

function parseEnd(s: string | undefined): EndDate | null {
  return /至今|现在|present|now/i.test(s ?? "") ? { present: true } : parseDate(s);
}

/** "2025.06–2025.09" / "2025.06-至今" */
function parseRange(s: string): [PartialDate | null, EndDate | null] {
  const [a, b] = s.split(/\s*[-–—~至]+\s*(?=\d{4}|至今|现在)/);
  return [parseDate(a), parseEnd(b)];
}

const DATE_RANGE = /(\d{4}[./-]\d{1,2}\s*[-–—~至]+\s*(?:\d{4}[./-]\d{1,2}|至今|今))\s*$/;
const clean = (l: string) => l.replace(/^[\s•·\-*]+/, "").trim();

/** 教育经历：和导出简历用同一份文字（每段一行"学校 专业 时间"，下面是要点） */
function educationFrom(text: string) {
  const blocks: { school: string; major: string | null; range: string; items: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = clean(raw);
    if (!line) continue;
    const m = line.match(DATE_RANGE);
    if (m) {
      const head = line.slice(0, m.index).trim().split(/\s+|\s*·\s*/).filter(Boolean);
      blocks.push({ school: head[0] ?? line, major: head.slice(1).join(" ") || null, range: m[1], items: [] });
    } else if (blocks.length) blocks[blocks.length - 1].items.push(line);
  }
  const awards: string[] = [];
  const records = blocks.map((b, i) => {
    const [start, end] = parseRange(b.range);
    const endDate = end && "year" in end ? end : null;
    const text = `${b.school} ${b.major ?? ""} ${b.items.join(" ")}`;
    // 学历：写明了就按写的；没写时，多段里最早的一段是本科、其余是研究生
    const degreeLevel = /博士|PhD|DPhil/i.test(text)
      ? "doctor"
      : /硕士|研究生|MPhil|MSc|MA\b|Master/i.test(text)
        ? "master"
        : /本科|学士|Bachelor/i.test(text) || i === blocks.length - 1
          ? "bachelor"
          : "master";
    const gpa = b.items.join(" ").match(/GPA[:：\s]*([\d.]+)\s*\/\s*([\d.]+)/i);
    // 排名只在所在的那一行里找，不跨行
    const ranking = b.items.map((it) => it.match(/(专业|年级|班级)?排名[^；;，,。\s]*/)).find(Boolean);
    for (const it of b.items) {
      const a = it.match(/^(奖项|荣誉|获奖)[:：]\s*(.+)$/);
      if (a) awards.push(...splitOutsideQuotes(a[2]));
    }
    const now = new Date();
    const enrolled = endDate ? endDate.year > now.getFullYear() || (endDate.year === now.getFullYear() && (endDate.month ?? 12) >= now.getMonth() + 1) : null;
    return {
      id: `edu-${i + 1}`,
      ...(i === 0 ? { primary: true } : {}),
      school: b.school.slice(0, 200),
      department: null,
      degreeLevel,
      enrollmentStatus: enrolled === null ? null : enrolled ? "enrolled" : "graduated",
      major: b.major?.slice(0, 200) ?? null,
      startDate: start,
      endDate,
      gpa: gpa?.[1] ?? null,
      gpaScale: gpa?.[2] ?? null,
      description: b.items.filter((x) => !/^(奖项|荣誉|获奖)[:：]/.test(x)).join("\n") || null,
      majorRanking: ranking?.[0]?.slice(0, 50) ?? null,
    };
  });
  return { records, awards };
}

/** 按顿号、逗号分开，但引号里的不分（"创新、创意及创业"挑战赛是一个奖） */
function splitOutsideQuotes(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of s) {
    if ("“「『《(（".includes(ch)) depth++;
    else if ("”」』》)）".includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && "、，,；;".includes(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 工作技能&其他里的语言成绩：英语雅思7.0、日语N1 */
function languagesFrom(extra: string) {
  const out: { id: string; language: string; certificate: string | null; score: string | null; examDate: null }[] = [];
  const t = extra.replace(/\s+/g, "");
  const ielts = t.match(/雅思\s*([\d.]+)/);
  if (ielts) out.push({ id: "lang-ielts", language: "英语", certificate: "雅思（IELTS）", score: ielts[1], examDate: null });
  const toefl = t.match(/托福\s*(\d{2,3})/);
  if (toefl) out.push({ id: "lang-toefl", language: "英语", certificate: "托福（TOEFL）", score: toefl[1], examDate: null });
  const cet = t.match(/CET-?([46])\s*(\d{3})?/i);
  if (cet) out.push({ id: `lang-cet${cet[1]}`, language: "英语", certificate: `大学英语${cet[1] === "4" ? "四" : "六"}级`, score: cet[2] ?? null, examDate: null });
  for (const m of t.matchAll(/([一-龥]{2,6}语)(ECL|DELF|DELE|JLPT|TOPIK|HSK)?([A-C][12]|N[1-5])/g)) {
    if (m[1] === "英语") continue;
    out.push({ id: `lang-${out.length + 1}`, language: m[1], certificate: m[2] ?? null, score: m[3], examDate: null });
  }
  return out.map((l, i) => (i === 0 ? { ...l, primary: true } : l));
}

const normUrl = (u: string) => u.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();

/** 网申页地址对应岗位库里的哪个岗位（完全相同，或同一个站点下路径是前缀关系） */
export function matchJob(url: string | null | undefined, jobs: JobPosting[]): JobPosting | undefined {
  if (!url) return undefined;
  const u = normUrl(url);
  const links = (j: JobPosting) => [j.jdUrl, j.link].filter((x): x is string => Boolean(x)).map(normUrl);
  const exact = jobs.find((j) => links(j).includes(u));
  if (exact) return exact;
  return jobs.find((j) => !j.siteOnly && links(j).some((l) => l.includes("/") && (u.startsWith(l) || l.startsWith(u)) && l.split("/").length > 2));
}

export async function buildApplyKitProfile(url?: string | null) {
  const [mem, lib, tracker] = await Promise.all([readMemory(), readLibrary(), readTracker()]);
  const p: Profile = mem.profile;
  if (!p.name?.trim()) throw new Error("还没有填简历抬头：在投递工作台里填好姓名、手机、邮箱");
  // 只填这个岗位定稿的定制简历（勾选的经历 + 改好的句子），绝不把整个素材库填上去。
  // 先按网申页地址对岗位；对不上（例如飞书官网的申请页）就用你最近在投递工作台点「确认简历，去投递」的岗位。
  const resumeOf = async (j: JobPosting | undefined) => (j ? ((await readApply(j.id).catch(() => null))?.resume ?? null) : null);
  const byUrl = matchJob(url, tracker.jobs);
  const active = tracker.settings.activeApply ? tracker.jobs.find((j) => j.id === tracker.settings.activeApply!.jobId) : undefined;
  let job: JobPosting | undefined;
  let resume: Resume | null = null;
  for (const j of [byUrl, active]) {
    const r = await resumeOf(j);
    if (r) {
      job = j;
      resume = r;
      break;
    }
  }
  if (!job || !resume)
    throw new Error(
      byUrl || active
        ? `「${(byUrl ?? active)!.company} · ${(byUrl ?? active)!.title}」还没有定制简历：先在投递工作台生成并确认简历，再点「确认简历，去投递」`
        : "还不知道你在投哪个岗位：先在SwipeApply的投递工作台里为这个岗位生成简历，点「确认简历，去投递」，再回来同步",
    );
  const cards = lib.cards.filter((c) => c.company?.trim());
  const exps = resume.experiences
    .filter((e) => e.include)
    .map((e) => {
      const card = cards.find((c) => c.id === e.cardId);
      const [start, end] = card ? [parseDate(card.start), parseEnd(card.end)] : parseRange(e.time);
      return { kind: card?.type ?? "实习", company: e.company, title: e.role, start, end, description: e.bullets.map((b) => b.text).join("\n") };
    });
  // 同一家公司同一岗位的卡片只保留一条
  const seenExp = new Set<string>();
  const unique = exps.filter((e) => {
    const k = `${normCompany(e.company)}|${e.title}`;
    if (seenExp.has(k)) return false;
    seenExp.add(k);
    return true;
  });
  // 实习卡片 → 实习经历；项目、比赛卡片 → 项目经历
  const internships = unique
    .filter((e) => e.kind === "实习")
    .slice(0, 20)
    .map((e, i) => ({
      id: `intern-${i + 1}`,
      ...(i === 0 ? { primary: true } : {}),
      company: e.company.slice(0, 200),
      department: null,
      title: e.title?.slice(0, 200) || null,
      city: null,
      startDate: e.start,
      endDate: e.end,
      description: e.description.slice(0, 10000) || null,
    }));
  const projects = unique
    .filter((e) => e.kind !== "实习")
    .slice(0, 20)
    .map((e, i) => ({
      id: `project-${i + 1}`,
      ...(i === 0 ? { primary: true } : {}),
      name: e.company.slice(0, 300),
      role: e.title?.slice(0, 200) || null,
      startDate: e.start,
      endDate: e.end,
      url: null,
      description: e.description.slice(0, 10000) || null,
    }));

  const { records: education, awards } = educationFrom(p.education ?? "");
  const phone = (p.phone ?? "").replace(/^\s*\(?\+86\)?\s*/, "").replace(/\s+/g, "");
  const data = {
    personal: {
      fullName: p.name.trim().slice(0, 100),
      englishName: null,
      email: p.email?.trim() || null,
      phone: /^[+]?[0-9][0-9\s()-]{4,}$/.test(phone) ? phone : null,
      birthDate: null,
      currentCity: null,
      homepage: null,
      github: null,
    },
    preferences: {
      targetRoles: [...new Set([...(job ? [job.title] : []), ...resumeKeywords(lib.cards.map((c) => c.role ?? ""))])].slice(0, 20).map((x) => x.slice(0, 100)),
      preferredCities: [],
      availabilityText: null,
      internshipMonths: null,
      daysPerWeek: null,
      acceptsRelocation: null,
    },
    education,
    internships,
    projects,
    languages: languagesFrom(p.extra ?? ""),
    awards: awards.slice(0, 20).map((name, i) => ({ id: `award-${i + 1}`, name: name.slice(0, 300), date: null, issuer: null, description: null })),
    selfIntroduction: null,
  };

  // 内容不变时版本号不变：插件重复同步不会多出一个版本
  const hash = createHash("sha1").update(JSON.stringify(data)).digest("hex").slice(0, 12);
  return {
    job: job ? { id: job.id, company: job.company, title: job.title } : null,
    file: {
      kind: "applykit-profile" as const,
      schemaVersion: 1 as const,
      profileId: "jobprep",
      profileVersionId: `jobprep-${hash}`,
      name: job ? `SwipeApply · ${job.company} ${job.title}`.slice(0, 200) : "SwipeApply",
      createdAt: new Date().toISOString(),
      source: { type: "import" as const, status: "user-reviewed" as const, note: "来自SwipeApply（本机同步）" },
      data,
    },
  };
}
