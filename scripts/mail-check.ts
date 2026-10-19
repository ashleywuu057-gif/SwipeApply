/**
 * 邮件公司名识别的回归样例（纯函数，不读写数据）。
 * 运行：npx tsx --tsconfig tsconfig.json scripts/mail-check.ts
 */
import assert from "node:assert/strict";
import { extractCompany, looksLikeCompany } from "@/lib/tracker-logic";

const cases: { name: string; from: string; subject: string; body?: string; known?: string[]; want: string }[] = [
  {
    name: "标题里的【2027届】不是公司名，从“来自XX的”取",
    from: "ehr04@bilibili.com",
    subject: "来自哔哩哔哩的面试邀请（视频面试__Product -Overseas 海外产品【2027届】）",
    want: "哔哩哔哩",
  },
  {
    name: "以前误识别的“2027届”在已知公司里，也不能拿来匹配；用发件人名称",
    from: '"内蒙古伊利实业集团股份有限公司" <yilihr@mail.hrtools.cn>',
    subject: "候选人AI面试通知",
    body: "欢迎参加伊利集团2027届校园招聘AI面试",
    known: ["2027届", "小鹏集团"],
    want: "内蒙古伊利实业集团股份有限公司",
  },
  {
    name: "正常的【公司】标题照旧",
    from: "noreply@mokahr.com",
    subject: "【小鹏集团】AI产品经理 一面邀请",
    want: "小鹏集团",
  },
  {
    name: "已知公司优先",
    from: "hr@xiaopeng.com",
    subject: "面试邀请",
    body: "感谢您投递小鹏集团的岗位",
    known: ["小鹏集团"],
    want: "小鹏集团",
  },
];

let failed = 0;
for (const c of cases) {
  const got = extractCompany(c.from, c.subject, c.body ?? "", c.known ?? []);
  try {
    assert.equal(got, c.want);
    console.log(`✓ ${c.name}`);
  } catch {
    failed++;
    console.log(`✗ ${c.name}：得到「${got}」，应为「${c.want}」`);
  }
}
for (const bad of ["2027届", "2026", "秋招", "海外产品岗位"]) assert.equal(looksLikeCompany(bad), false, bad);
console.log(failed ? `${failed} 条失败` : "全部通过");
process.exit(failed ? 1 : 0);
