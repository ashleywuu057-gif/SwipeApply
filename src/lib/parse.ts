import "server-only";

const CODE_EXT: Record<string, string> = {
  ".py": "python", ".sql": "sql", ".js": "javascript", ".ts": "typescript", ".r": "r", ".java": "java",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".sh": "bash", ".html": "html", ".css": "css",
};
const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".bmp", ".webp"];

export const SUPPORTED = [".pdf", ".docx", ".pptx", ".md", ".txt", ".csv", ".ipynb", ...Object.keys(CODE_EXT), ...IMAGE_EXT];

/** 把上传的文件解析成纯文本（全部在本机完成） */
export async function parseFile(name: string, buf: Buffer): Promise<{ kind: string; text: string }> {
  const ext = name.toLowerCase().slice(name.lastIndexOf("."));
  switch (ext) {
    case ".pdf": {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: false });
      const pages = Array.isArray(text) ? text : [text];
      const out = clean(pages.join("\n\n"));
      if (!out) throw new Error("PDF 里没有文字层（可能是扫描件），可以截图后按图片上传");
      return { kind: "pdf", text: out };
    }
    case ".docx": {
      // 先转成 HTML 再转文字，这样能保留 Word 里的标题层级（用于自动切分）
      const mammoth = await import("mammoth");
      const { value } = await mammoth.convertToHtml({ buffer: buf });
      return { kind: "docx", text: clean(htmlToText(value)) };
    }
    case ".pptx":
      return { kind: "pptx", text: clean(await pptxToText(buf)) };
    case ".md":
    case ".txt":
      return { kind: ext.slice(1), text: clean(buf.toString("utf8")) };
    case ".csv":
      return { kind: "csv", text: csvToTable(buf.toString("utf8")) };
    case ".ipynb":
      return { kind: "ipynb", text: notebookToText(buf.toString("utf8")) };
  }
  if (CODE_EXT[ext]) {
    // 代码保留缩进，用代码块包起来（自动切分时不会把注释当成标题）
    return { kind: ext.slice(1), text: fence(CODE_EXT[ext], buf.toString("utf8")) };
  }
  if (IMAGE_EXT.includes(ext)) {
    const { ocrImage } = await import("./ocr");
    const text = await ocrImage(buf);
    if (!text) throw new Error("图片里没有识别出文字");
    return { kind: "image", text: `（图片文字识别结果，可能有错字）\n${text}` };
  }
  throw new Error(`暂不支持 ${ext} 格式`);
}

function fence(lang: string, code: string) {
  return "```" + lang + "\n" + code.replace(/\r\n?/g, "\n").replace(/\s+$/, "") + "\n```";
}

/** Jupyter 笔记本：Markdown 单元格保留原文，代码单元格放进代码块；运行输出不收录 */
function notebookToText(raw: string) {
  const nb = JSON.parse(raw) as { cells?: { cell_type: string; source: string | string[] }[]; metadata?: { kernelspec?: { language?: string } } };
  const lang = nb.metadata?.kernelspec?.language ?? "python";
  return (nb.cells ?? [])
    .map((c) => {
      const src = Array.isArray(c.source) ? c.source.join("") : c.source;
      if (!src.trim()) return "";
      return c.cell_type === "code" ? fence(lang, src) : src.trim();
    })
    .filter(Boolean)
    .join("\n\n");
}

const CSV_MAX_ROWS = 500;

/** CSV 转成 "| a | b |" 表格行，脱敏时可以整块屏蔽 */
function csvToTable(raw: string) {
  const rows = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  const parse = (line: string) => {
    const cells: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = !q;
      } else if (ch === "," && !q) {
        cells.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cells.push(cur.trim());
    return "| " + cells.join(" | ") + " |";
  };
  const out = rows.slice(0, CSV_MAX_ROWS).map(parse);
  if (rows.length > CSV_MAX_ROWS) out.push(`（共 ${rows.length} 行，只收录前 ${CSV_MAX_ROWS} 行）`);
  return out.join("\n");
}

/** PPT：按页提取文字，每页一个"## 第 N 页"标题（方便自动切分），表格转成表格行，附上备注 */
async function pptxToText(buf: Buffer) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));

  const decode = (s: string) =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const paras = (xml: string) =>
    [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map((p) => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decode(t[1])).join(""))
      .filter((t) => t.trim());

  const pages: string[] = [];
  for (const [i, f] of slideFiles.entries()) {
    let xml = await zip.file(f)!.async("string");
    // 表格
    const tables: string[] = [];
    xml = xml.replace(/<a:tbl>[\s\S]*?<\/a:tbl>/g, (t) => {
      const rows = [...t.matchAll(/<a:tr[\s\S]*?<\/a:tr>/g)].map(
        (r) => "| " + [...r[0].matchAll(/<a:tc[\s\S]*?<\/a:tc>/g)].map((c) => paras(c[0]).join(" ")).join(" | ") + " |",
      );
      tables.push(rows.join("\n"));
      return "";
    });
    const body = [...paras(xml), ...tables];
    // 备注
    const rels = await zip.file(f.replace("slides/", "slides/_rels/") + ".rels")?.async("string");
    const notesTarget = rels?.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/)?.[1];
    const notesXml = notesTarget ? await zip.file(`ppt/notesSlides/${notesTarget}`)?.async("string") : undefined;
    const notes = notesXml ? paras(notesXml).filter((t) => !/^\d+$/.test(t.trim())) : [];
    if (notes.length) body.push("备注：" + notes.join("\n"));
    pages.push(`## 第 ${i + 1} 页\n` + body.join("\n"));
  }
  return pages.join("\n\n");
}

function htmlToText(html: string) {
  const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return html
    // Word 表格转成 "| a | b |" 一行一行，方便识别和整块屏蔽
    .replace(/<table[\s\S]*?<\/table>/g, (t) => {
      const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(
        (r) => "| " + [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => strip(c[1])).join(" | ") + " |",
      );
      return "\n" + rows.join("\n") + "\n";
    })
    .replace(/<h([1-6])[^>]*>/g, (_, n) => "\n" + "#".repeat(Math.min(Number(n), 3)) + " ")
    .replace(/<li[^>]*>/g, "\n- ")
    .replace(/<\/(p|h[1-6]|li|tr)>|<br\s*\/?>/g, "\n")
    .replace(/<\/t[dh]>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function clean(s: string) {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t 　]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
