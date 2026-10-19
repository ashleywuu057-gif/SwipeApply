import { parseFile } from "@/lib/parse";
import { newId, readLibrary, saveSourceText, updateLibrary } from "@/lib/store";
import type { SourceDoc } from "@/lib/types";

export async function GET() {
  const lib = await readLibrary();
  return Response.json({ sources: lib.sources });
}

/** 上传文件 → 本地解析成纯文本 → 保存到 data/sources */
export async function POST(req: Request) {
  const form = await req.formData();
  const note = String(form.get("note") ?? "");
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  const created: SourceDoc[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const file of files) {
    try {
      const { kind, text } = await parseFile(file.name, Buffer.from(await file.arrayBuffer()));
      if (!text) throw new Error("没有解析出文字（如果是扫描件/图片，MVP 暂不支持 OCR）");
      const doc: SourceDoc = {
        id: newId(),
        name: file.name,
        kind,
        note,
        chars: text.length,
        importedAt: new Date().toISOString(),
      };
      await saveSourceText(doc.id, text);
      created.push(doc);
    } catch (e) {
      errors.push({ name: file.name, error: (e as Error).message });
    }
  }

  await updateLibrary((lib) => {
    lib.sources.push(...created);
  });
  return Response.json({ created, errors });
}
