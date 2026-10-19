import "server-only";

/**
 * 生成简历的实时进度（只在内存里，生成完就没用了）：工作台等待时轮询，显示 AI 此刻真正在做哪一步。
 * 每一步的说明都来自真实数据（JD 拆出了几个要点、检索出几条素材、核对出几条待核对），不是写死的动画文案。
 */
export interface GenStep {
  label: string;
  detail?: string;
  at: number; // 开始时间（毫秒）
  done: boolean;
}

function store() {
  const g = globalThis as unknown as { __genProgress?: Map<string, GenStep[]> };
  g.__genProgress ??= new Map();
  return g.__genProgress;
}

/** 开始新的一轮：清掉上一次的记录 */
export function startProgress(jobId: string) {
  store().set(jobId, []);
  return (label: string, detail?: string) => step(jobId, label, detail);
}

/** 进入下一步（上一步自动标为完成） */
export function step(jobId: string, label: string, detail?: string) {
  const steps = store().get(jobId) ?? [];
  for (const s of steps) s.done = true;
  steps.push({ label, detail, at: Date.now(), done: false });
  store().set(jobId, steps);
}

/** 给当前这一步补充说明（例如检索完了，补上挑出了几条） */
export function note(jobId: string, detail: string) {
  const s = store().get(jobId)?.at(-1);
  if (s) s.detail = detail;
}

export function finishProgress(jobId: string, label?: string, detail?: string) {
  if (label) step(jobId, label, detail);
  for (const s of store().get(jobId) ?? []) s.done = true;
}

export function readProgress(jobId: string): GenStep[] {
  return store().get(jobId) ?? [];
}
