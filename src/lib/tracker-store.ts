import "server-only";
import { promises as fs } from "fs";
import path from "path";
import type { TrackerData } from "./tracker-types";

/** P2 的数据单独存一个文件：data/tracker.json（只在本机） */
const FILE = path.join(process.cwd(), "data", "tracker.json");

const EMPTY: TrackerData = {
  jobs: [],
  applications: [],
  mails: [],
  settings: { myDirections: [], feeds: [], dailyTime: "09:00" },
};

export async function readTracker(): Promise<TrackerData> {
  try {
    const d = JSON.parse(await fs.readFile(FILE, "utf8")) as Partial<TrackerData>;
    return {
      jobs: d.jobs ?? [],
      applications: d.applications ?? [],
      mails: d.mails ?? [],
      settings: { ...EMPTY.settings, ...(d.settings ?? {}) },
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

let chain: Promise<unknown> = Promise.resolve();

export async function updateTracker<T>(fn: (d: TrackerData) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const d = await readTracker();
    const before = new Map(d.applications.map((a) => [a.id, a.stage]));
    const result = await fn(d);
    // 阶段有变化（包括新建）就记一笔时间，不用每个改阶段的地方各自去记
    const now = new Date().toISOString();
    for (const a of d.applications) {
      if (before.get(a.id) === a.stage) continue;
      (a.stageLog ??= []).push({ stage: a.stage, at: before.has(a.id) ? now : a.appliedAt || now });
    }
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(d, null, 2), "utf8");
    await fs.rename(tmp, FILE);
    return result;
  });
  chain = run.catch(() => undefined);
  return run;
}
