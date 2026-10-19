import "server-only";
import type { RawMail } from "./mail";
import type { Application, MailItem, MailKind } from "./tracker-types";
import { classifyMail, extractCompany, extractLink, extractTime, looksLikeCompany, matchApplication } from "./tracker-logic";
import { chatJson } from "./extract";
import { buildContext, redact, restore } from "./redact";
import { readLibrary } from "./store";

const KINDS: MailKind[] = ["投递确认", "测评", "笔试", "AI面", "面试", "HR面", "Offer", "未通过", "其他"];

const MAIL_PROMPT = `你是求职邮件助手。下面是一封招聘相关邮件（人名、联系方式已替换为占位符）。
只根据邮件内容判断，输出 JSON：
{"kind":"投递确认|测评|笔试|AI面|面试|HR面|Offer|未通过|其他","company":"发出邮件的公司名，没有就留空","time":"测评、AI面写作答截止时间；笔试、面试有固定场次写开始时间，没有就写截止时间。只写了“收到后72小时内”这类相对期限的，按【发送时间】推算。格式 YYYY-MM-DDTHH:mm，没有就留空"}
不要编造邮件里没有的信息。只输出 JSON。`;

/** 规则识别；规则拿不准（类型不明、缺公司或缺时间）且允许时，发脱敏后的邮件给模型补充 */
export async function processMails(raw: RawMail[], apps: Application[], known: string[], useLLM: boolean): Promise<MailItem[]> {
  let ctx: ReturnType<typeof buildContext> | null = null;
  if (useLLM) {
    const lib = await readLibrary();
    ctx = buildContext(lib.settings, raw.map((m) => `${m.subject}\n${m.text}`));
  }

  const out: MailItem[] = [];
  for (const m of raw) {
    const text = `${m.subject}\n${m.text}`;
    let kind = classifyMail(m.subject, m.text);
    let company = extractCompany(m.from, m.subject, m.text, known);
    let scheduledAt = ["测评", "笔试", "AI面", "面试", "HR面"].includes(kind) ? extractTime(text, new Date(m.date), kind) : undefined;
    let by: MailItem["by"] = "规则";

    const unsure = kind === "其他" || !company || (["测评", "笔试", "AI面", "面试", "HR面"].includes(kind) && !scheduledAt);
    if (useLLM && ctx && unsure) {
      try {
        const map: Record<string, string> = {};
        // 公司名不屏蔽（招聘方是公开信息），只屏蔽人名、联系方式等
        const safe = redact(`【发件人】${m.from}\n【发送时间】${sentLocal(m.date)}\n【标题】${m.subject}\n【正文】\n${m.text.slice(0, 2500)}`, { ...ctx, terms: [] }, map).text;
        const r = restore(await chatJson(MAIL_PROMPT, safe), map) as { kind?: MailKind; company?: string; time?: string } | null;
        if (r) {
          if (r.kind && KINDS.includes(r.kind) && kind === "其他") kind = r.kind;
          if (r.company && !company && looksLikeCompany(r.company)) company = r.company.trim();
          if (r.time && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.time) && !scheduledAt) scheduledAt = r.time;
          by = "模型";
        }
      } catch {
        // 模型失败就用规则结果
      }
    }

    out.push({
      id: `inbox-${m.uid}`,
      messageId: m.messageId,
      from: m.from,
      subject: m.subject,
      date: m.date,
      snippet: m.text.replace(/\s+/g, " ").trim().slice(0, 200),
      kind,
      company,
      scheduledAt,
      link: kind === "其他" ? undefined : extractLink(m.text),
      applicationId: matchApplication(company, m.subject, m.text, apps),
      by,
      status: "待确认", // 识别不出类型的也留给你看一眼，不自动忽略
    });
  }
  return out;
}

function sentLocal(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
