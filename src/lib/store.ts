import "server-only";
import { promises as fs } from "fs";
import path from "path";
import type { Evidence, LibraryData } from "./types";

/**
 * 所有数据都存在本机项目目录下的 data/ 文件夹里，不上传任何服务器。
 * data/library.json      卡片、资料清单、设置
 * data/sources/<id>.txt  每份资料解析出的纯文本
 * data/evidence.json     从复盘、工作文档里提炼的证据条目
 */
const DATA_DIR = path.join(process.cwd(), "data");
const LIB_FILE = path.join(DATA_DIR, "library.json");
const SRC_DIR = path.join(DATA_DIR, "sources");

const EMPTY: LibraryData = {
  cards: [],
  sources: [],
  settings: { sensitiveTerms: [], allowTerms: [], autoRules: { contact: true, person: true, nickname: true, table: true } },
};

async function ensureDirs() {
  await fs.mkdir(SRC_DIR, { recursive: true });
}

export async function readLibrary(): Promise<LibraryData> {
  await ensureDirs();
  try {
    const raw = await fs.readFile(LIB_FILE, "utf8");
    const data = JSON.parse(raw) as Partial<LibraryData>;
    return {
      cards: data.cards ?? [],
      sources: data.sources ?? [],
      settings: {
        ...EMPTY.settings,
        ...(data.settings ?? {}),
        autoRules: { ...EMPTY.settings.autoRules, ...(data.settings?.autoRules ?? {}) },
      },
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

// 简单的串行写锁，避免并发请求把文件写坏
let writeChain: Promise<unknown> = Promise.resolve();

export async function updateLibrary<T>(fn: (lib: LibraryData) => T | Promise<T>): Promise<T> {
  const run = writeChain.then(async () => {
    const lib = await readLibrary();
    const result = await fn(lib);
    const tmp = LIB_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(lib, null, 2), "utf8");
    await fs.rename(tmp, LIB_FILE);
    return result;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

function safeId(id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error("非法 id");
  return id;
}

export async function saveSourceText(id: string, text: string) {
  await ensureDirs();
  await fs.writeFile(path.join(SRC_DIR, `${safeId(id)}.txt`), text, "utf8");
}

export async function readSourceText(id: string): Promise<string> {
  try {
    return await fs.readFile(path.join(SRC_DIR, `${safeId(id)}.txt`), "utf8");
  } catch {
    return "";
  }
}

export async function deleteSourceText(id: string) {
  await fs.rm(path.join(SRC_DIR, `${safeId(id)}.txt`), { force: true });
}

/* ---------------- 证据条目：data/evidence.json ---------------- */

const EVIDENCE_FILE = path.join(DATA_DIR, "evidence.json");

export async function readEvidence(): Promise<Evidence[]> {
  try {
    return JSON.parse(await fs.readFile(EVIDENCE_FILE, "utf8")) as Evidence[];
  } catch {
    return [];
  }
}

let evidenceChain: Promise<unknown> = Promise.resolve();

export async function updateEvidence<T>(fn: (list: Evidence[]) => T | Promise<T>): Promise<T> {
  const run = evidenceChain.then(async () => {
    const list = await readEvidence();
    const result = await fn(list);
    await ensureDirs();
    const tmp = EVIDENCE_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(list, null, 2), "utf8");
    await fs.rename(tmp, EVIDENCE_FILE);
    return result;
  });
  evidenceChain = run.catch(() => undefined);
  return run;
}

export function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
