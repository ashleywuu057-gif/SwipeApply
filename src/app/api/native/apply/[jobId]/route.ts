import { llmConfig } from "@/lib/extract";
import { searchConfig } from "@/lib/research/search";
import { peekJd, getBrief } from "@/lib/native/intel";
import { findJobForMe } from "@/lib/native/jobs";
import { readApply, readMemory } from "@/lib/native/store";

type Ctx = { params: Promise<{ jobId: string }> };

/** 工作台的全部状态：岗位、JD、公司速览（没有就在后台生成）、简历、对话 */
export async function GET(_req: Request, { params }: Ctx) {
  const { jobId } = await params;
  const job = await findJobForMe(jobId);
  if (!job) return Response.json({ error: "岗位不存在" }, { status: 404 });
  const [jd, state, mem] = await Promise.all([peekJd(job), readApply(jobId), readMemory()]);
  const brief = await getBrief(job, jd.text);
  return Response.json({
    job,
    jd,
    brief,
    state,
    profile: mem.profile,
    writing: mem.writing.filter((w) => w.active),
    config: { llm: llmConfig().enabled, search: searchConfig().enabled },
  });
}
