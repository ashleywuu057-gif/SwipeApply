import { llmConfig } from "@/lib/extract";
import { readLibrary, updateLibrary } from "@/lib/store";
import type { AutoRules } from "@/lib/types";

export async function GET() {
  const lib = await readLibrary();
  const cfg = llmConfig();
  return Response.json({
    settings: lib.settings,
    llm: { enabled: cfg.enabled, host: cfg.host, model: cfg.model },
  });
}

const list = (a?: string[]) => [...new Set((a ?? []).map((t) => t.trim()).filter(Boolean))];

/** 部分更新：敏感词、不屏蔽的词、自动屏蔽开关 */
export async function PUT(req: Request) {
  const body = (await req.json()) as { sensitiveTerms?: string[]; allowTerms?: string[]; autoRules?: Partial<AutoRules> };
  const settings = await updateLibrary((lib) => {
    if (body.sensitiveTerms) lib.settings.sensitiveTerms = list(body.sensitiveTerms);
    if (body.allowTerms) lib.settings.allowTerms = list(body.allowTerms);
    if (body.autoRules) lib.settings.autoRules = { ...lib.settings.autoRules, ...body.autoRules };
    return lib.settings;
  });
  return Response.json({ settings });
}
