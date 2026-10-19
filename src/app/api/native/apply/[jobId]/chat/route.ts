import { runWorkspaceAgent } from "@/lib/native/agent";
import { peekJd, getBrief } from "@/lib/native/intel";
import { findJobForMe } from "@/lib/native/jobs";
import { readApply, readMemory, saveApply, saveBrief, updateMemory } from "@/lib/native/store";
import type { ChatMsg, Resume } from "@/lib/native/types";

type Ctx = { params: Promise<{ jobId: string }> };

/** 和工作台 agent 说一句（语音转好的文字或打字） */
export async function POST(req: Request, { params }: Ctx) {
  const jobId = (await params).jobId;
  const job = await findJobForMe(jobId);
  if (!job) return Response.json({ error: "岗位不存在" }, { status: 404 });
  const b = (await req.json()) as { message: string; resume: Resume };
  const message = (b.message ?? "").trim();
  if (!message) return Response.json({ error: "说点什么吧" }, { status: 400 });

  const [jd, state, mem] = await Promise.all([peekJd(job), readApply(jobId), readMemory()]);
  const brief = await getBrief(job, jd.text);
  try {
    const r = await runWorkspaceAgent({ job, jd: jd.text, brief, resume: b.resume ?? state.resume, history: state.chat, message, mem });
    const reply: ChatMsg = { role: "assistant", text: r.reply, actions: r.actions, question: r.question, suggestion: r.suggestion };
    state.chat.push({ role: "user", text: message }, reply);
    state.resume = r.resume;
    await saveApply(state);
    if (JSON.stringify(r.brief) !== JSON.stringify(brief) && brief.basis !== "示例") await saveBrief(r.brief);
    if (r.facts.length) await updateMemory((m) => void m.facts.push(...r.facts));
    return Response.json({ state, brief: r.brief });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
