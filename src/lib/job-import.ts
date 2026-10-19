import "server-only";
import { newId } from "./store";
import { directionsOf, findHeaderRow, isOverseas, mapColumns, normCompany, parseCsv, parseDeadline } from "./tracker-logic";
import type { JobPosting } from "./tracker-types";

/* 岗位表格解析：手动导入和每日自动更新共用 */

export type Row = { text: string[]; links: (string | undefined)[] };

/** 读取 Excel：每个单元格同时取文字和超链接（很多表格的"投递链接"是带链接的文字） */
export async function readXlsx(buf: Buffer): Promise<Row[][]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheets: Row[][] = [];
  wb.eachSheet((ws) => {
    const rows: Row[] = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const text: string[] = [];
      const links: (string | undefined)[] = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const cell = r.getCell(c);
        const v = cell.value as unknown;
        const link =
          (cell as unknown as { hyperlink?: string }).hyperlink ??
          (v && typeof v === "object" && "hyperlink" in (v as object) ? (v as { hyperlink: string }).hyperlink : undefined);
        let t = cell.text ?? "";
        if (v instanceof Date) t = v.toISOString().slice(0, 10);
        text.push(String(t).trim());
        links.push(link);
      }
      rows.push({ text, links });
    });
    sheets.push(rows);
  });
  return sheets;
}

export function rowsToJobs(rows: Row[], source: string): { jobs: JobPosting[]; error?: string } {
  const h = findHeaderRow(rows.map((r) => r.text));
  if (h < 0) return { jobs: [], error: "没找到表头（需要至少有「公司」和「岗位」或「链接」列）" };
  const map = mapColumns(rows[h].text);
  const get = (r: Row, k: keyof typeof map) => (map[k] === undefined ? "" : (r.text[map[k]!] ?? "").trim());
  const now = new Date().toISOString();
  const jobs: JobPosting[] = [];
  let lastCompany = "";
  for (const r of rows.slice(h + 1)) {
    // 合并单元格：公司名只写在第一行
    const company = get(r, "company") || lastCompany;
    lastCompany = company;
    const title = get(r, "title");
    const linkCell = map.link === undefined ? undefined : r.links[map.link];
    const linkText = get(r, "link");
    const link = linkCell || (/^https?:\/\//.test(linkText) ? linkText : linkText.match(/https?:\/\/\S+/)?.[0] ?? "");
    const jdCell = map.jdUrl === undefined ? undefined : r.links[map.jdUrl];
    const jdText = get(r, "jdUrl");
    const jdUrl = jdCell || jdText.match(/https?:\/\/\S+/)?.[0] || "";
    if (!company || (!title && !link && !jdUrl)) continue;
    const note = get(r, "note");
    const deadline = get(r, "deadline");
    jobs.push({
      id: newId(),
      company,
      title: title || "（未写岗位）",
      location: get(r, "location"),
      deadline,
      deadlineAt: deadline ? parseDeadline(deadline) : undefined,
      link: link || jdUrl,
      ...(jdUrl ? { jdUrl } : {}),
      batch: get(r, "batch"),
      industry: get(r, "industry"),
      note,
      directions: directionsOf(title, note),
      overseas: isOverseas(title, note, get(r, "location")),
      source,
      starred: false,
      createdAt: now,
    });
  }
  return { jobs };
}

export const jobKey = (j: Pick<JobPosting, "company" | "title" | "link">) => `${normCompany(j.company)}|${j.title.trim()}|${j.link.trim()}`;


/** Markdown 表格（很多 GitHub 上的秋招汇总是这种格式）：[投递](链接) 里的链接单独取出来 */
export function parseMarkdownTables(md: string): Row[][] {
  const tables: Row[][] = [];
  let cur: Row[] = [];
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("|") && t.endsWith("|")) {
      const cells = t.slice(1, -1).split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 分隔行
      cur.push({
        text: cells.map((c) => c.replace(/\[([^\]]*)\]\(([^)]+)\)/g, "$1").replace(/<[^>]+>/g, "").trim()),
        links: cells.map((c) => c.match(/\]\((https?:[^)\s]+)\)/)?.[1] ?? c.match(/https?:\/\/[^\s)|]+/)?.[0]),
      });
    } else if (cur.length) {
      tables.push(cur);
      cur = [];
    }
  }
  if (cur.length) tables.push(cur);
  return tables;
}

/** 网页里的 <table> */
export function parseHtmlTables(html: string): Row[][] {
  const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((t) =>
    [...t[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) => {
      const cells = [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1]);
      return { text: cells.map(strip), links: cells.map((c) => c.match(/href="(https?:[^"]+)"/)?.[1]) };
    }),
  );
}

/** 读取一个文件或网址的内容，解析成若干张表 */
export async function tablesFrom(name: string, buf: Buffer, contentType = ""): Promise<Row[][]> {
  const ext = name.toLowerCase().split("?")[0].split(".").pop() ?? "";
  if (ext === "xlsx" || /spreadsheetml/.test(contentType)) return readXlsx(buf);
  const text = buf.toString("utf8");
  if (ext === "csv" || /text\/csv/.test(contentType)) return [parseCsv(text).map((t) => ({ text: t, links: [] }))];
  if (/<table/i.test(text)) return parseHtmlTables(text);
  if (/^\s*\|.*\|\s*$/m.test(text)) return parseMarkdownTables(text);
  if (text.includes(",")) return [parseCsv(text).map((t) => ({ text: t, links: [] }))];
  throw new Error("没有识别出表格（支持 CSV、Excel、Markdown 表格、网页表格）");
}

/** 把新岗位合并进岗位库，重复的跳过（旧记录没有岗位详情页、新记录有的，补上） */
export function mergeJobs(existing: JobPosting[], incoming: JobPosting[]) {
  const seen = new Map(existing.map((j) => [jobKey(j), j]));
  let added = 0;
  let dup = 0;
  for (const j of incoming) {
    const k = jobKey(j);
    const old = seen.get(k);
    if (old) {
      if (!old.jdUrl && j.jdUrl) old.jdUrl = j.jdUrl;
      dup++;
      continue;
    }
    seen.set(k, j);
    existing.push(j);
    added++;
  }
  return { added, dup };
}
