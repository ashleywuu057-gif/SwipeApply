import { llmConfig } from "@/lib/extract";
import { redactSources } from "@/lib/pipeline";
import { redact } from "@/lib/redact";

/** 发送前预览：返回脱敏后、将要发给云端模型的原文 */
export async function POST(req: Request) {
  const { sourceIds } = (await req.json()) as { sourceIds: string[] };
  const { items, ctx, map } = await redactSources(sourceIds ?? []);
  const cfg = llmConfig();
  return Response.json({
    llm: { enabled: cfg.enabled, host: cfg.host, model: cfg.model },
    items: items.map((i) => ({
      sourceId: i.source.id,
      name: i.source.name,
      sentName: redact(i.source.name, ctx, map).text,
      note: i.source.note,
      redacted: i.redacted,
      hits: i.hits,
    })),
  });
}
