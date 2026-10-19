import "server-only";
import { readLibrary, readSourceText } from "./store";
import { buildContext, redact } from "./redact";

/**
 * 对选中的资料统一脱敏：先扫描所有文件收集人名/昵称，再逐份替换。
 * 共用一张占位符表，保证预览和实际发送完全一致。
 */
export async function redactSources(sourceIds: string[]) {
  const lib = await readLibrary();
  const docs = [];
  for (const id of sourceIds) {
    const src = lib.sources.find((s) => s.id === id);
    if (src) docs.push({ source: src, original: await readSourceText(id) });
  }
  const ctx = buildContext(lib.settings, docs.flatMap((d) => [d.original, d.source.name, d.source.note]));
  const map: Record<string, string> = {};
  const items = docs.map((d) => {
    const r = redact(d.original, ctx, map);
    return { ...d, redacted: r.text, hits: r.hits };
  });
  return { items, map, ctx };
}
