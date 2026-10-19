import { llmConfig } from "@/lib/extract";
import { classifyIntent, intentContext, INTENTS, jobsOfCompany, type Intent, type IntentPack } from "@/lib/native/intent";
import { getBrief, peekJd } from "@/lib/native/intel";
import { findJob } from "@/lib/native/jobs";
import { factFrom } from "@/lib/native/resume";
import { checkRules, parsePrefs, saveSaid } from "@/lib/native/say";
import { updateMemory } from "@/lib/native/store";
import type { JobPosting } from "@/lib/tracker-types";

/**
 * 统一入口：首页对话框说的一句话。先识别意图，再交给对应的环节，返回前端该怎么展示。
 * intent 参数：用户在「你是想…」的反问里点了选项，直接按它处理，不再识别。
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { text?: string; intent?: string; jobId?: string };
  const text = String(b.text ?? "").trim().slice(0, 300);
  if (!text) return Response.json({ error: "说一句你想做什么" }, { status: 400 });
  if (!llmConfig().enabled) return Response.json({ error: "没有配置大模型（.env.local 里的 LLM_*），暂时用不了对话框" }, { status: 400 });

  const ctx = await intentContext();
  const forced = INTENTS.find((i) => i === b.intent);
  const pack: IntentPack = forced ? { intent: forced, confidence: 1, company: "", experience: "", by: "规则" } : await classifyIntent(text, ctx);
  // 从反问里点了「修改简历 / 了解这家公司」：还要知道是哪家公司（从选项里点了具体岗位的不用再识别）
  if ((forced === "company" || forced === "resume") && !b.jobId) pack.company = (await classifyIntent(text, ctx)).company;
  const picked = b.jobId ? await findJob(b.jobId) : null;

  // 没把握：反问一句，不猜
  if (!forced && pack.intent !== "other" && pack.confidence < 0.6) {
    return Response.json({ kind: "clarify", pack, text: "你是想……", options: CLARIFY });
  }

  try {
    switch (pack.intent) {
      case "prefs": {
        // 意图识别已经顺便拆好规则就直接核对，省一次模型调用；从反问里点进来的、规则兜底的再单独拆
        const { rules, unclear } = pack.prefs ? checkRules(pack.prefs) : await parsePrefs(text);
        const saved = rules.length ? await updateMemory((m) => saveSaid(m, rules)) : [];
        return Response.json({ kind: "prefs", pack, rules: saved, unclear });
      }
      case "fact": {
        // 补充事实只记用户原话，之后写简历可以作为依据
        const fact = factFrom(text, undefined, "首页对话");
        await updateMemory((m) => void m.facts.push(fact));
        return Response.json({ kind: "fact", pack, fact: { id: fact.id, text: fact.text } });
      }
      case "resume": {
        const target = picked ?? undefined;
        const jobs = target ? [target] : pack.company ? await jobsOfCompany(pack.company, ctx.recent) : ctx.recent.slice(0, 1);
        if (!jobs.length) {
          return Response.json({
            kind: "reply",
            pack,
            text: pack.company ? `岗位库里还没有「${pack.company}」的岗位。` : "还没有定制过简历：先在下面右滑一个岗位，再告诉我怎么改。",
          });
        }
        if (jobs.length > 1 && !target) return Response.json({ kind: "pick", pack, intent: "resume", text: "改哪个岗位的简历？", options: jobs.slice(0, 4).map(brief) });
        return Response.json({ kind: "resume", pack, job: brief(jobs[0]), instruction: text });
      }
      case "company": {
        const jobs = picked ? [picked] : pack.company ? await jobsOfCompany(pack.company, ctx.recent) : [];
        if (!jobs.length) {
          return Response.json({
            kind: "reply",
            pack,
            text: pack.company ? `岗位库里还没有「${pack.company}」的岗位，暂时只能了解岗位库里的公司。` : "想了解哪家公司？说出公司名就行。",
          });
        }
        const job = jobs[0];
        const jd = await peekJd(job);
        const b2 = await getBrief(job, jd.text); // 有缓存直接用；没有就在后台生成，前端轮询
        return Response.json({ kind: "company", pack, job: brief(job), brief: b2 });
      }
      default:
        return Response.json({
          kind: "reply",
          pack,
          text: "我可以帮你：调整推荐的岗位（「别推 To B」）、修改某个岗位的简历（「快手那段写得更数据化」）、了解一家公司（「米哈游最近在做什么」），或者记下你的一段经历。",
        });
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

const CLARIFY: { intent: Intent; label: string }[] = [
  { intent: "prefs", label: "调整推荐的岗位" },
  { intent: "resume", label: "修改简历" },
  { intent: "company", label: "了解这家公司" },
  { intent: "fact", label: "记下我的经历" },
];

function brief(j: JobPosting) {
  return { jobId: j.id, company: j.company, title: j.title };
}
