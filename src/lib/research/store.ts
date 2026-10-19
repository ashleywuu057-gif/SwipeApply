import "server-only";
import { promises as fs } from "fs";
import path from "path";
import type { Research } from "./types";

/** 每份调研存成 data/research/<id>.json（只在本机） */
const DIR = path.join(process.cwd(), "data", "research");

const file = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error("非法 id");
  return path.join(DIR, `${id}.json`);
};

export async function saveResearch(r: Research) {
  await fs.mkdir(DIR, { recursive: true });
  const f = file(r.id);
  await fs.writeFile(f + ".tmp", JSON.stringify(r, null, 2), "utf8");
  await fs.rename(f + ".tmp", f);
}

export async function readResearch(id: string): Promise<Research | null> {
  try {
    return JSON.parse(await fs.readFile(file(id), "utf8"));
  } catch {
    return null;
  }
}

export async function listResearch(): Promise<Research[]> {
  try {
    const names = (await fs.readdir(DIR)).filter((n) => n.endsWith(".json"));
    const all = await Promise.all(names.map((n) => readResearch(n.replace(/\.json$/, ""))));
    return all.filter((r): r is Research => Boolean(r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export async function deleteResearch(id: string) {
  await fs.rm(file(id), { force: true });
}
