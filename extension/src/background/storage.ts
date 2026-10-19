import { appStateSchema } from '../shared/schemas';
import type { ActiveRunMeta, AppState } from '../shared/types';
import { createEmptyState, fillDefaults, migrateState } from './migrations';

/**
 * 唯一持久化写入口。写操作串行排队，读最新状态 → 校验 revision → 生成副本 → 一次 set。
 */

export const STATE_KEY = 'applykit.state.v1';
export const ACTIVE_RUNS_KEY = 'applykit.active-runs.v1';

export const MAX_PROCESSED_MUTATIONS = 100;
export const MAX_RECENT_RUNS = 50;
/** 接近该阈值时拒绝继续增长并提示导出整理。 */
export const SOFT_QUOTA_BYTES = 7 * 1024 * 1024;

export class StorageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface UnreadableState {
  reason: string;
  details: Array<{ path: string; message: string }>;
  raw: unknown;
}

let cachedState: AppState | null = null;
let unreadable: UnreadableState | null = null;
let initPromise: Promise<void> | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

async function readRaw(key: string): Promise<unknown> {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

/** 所有消息处理都等待同一个初始化 Promise。 */
export function ensureInitialized(): Promise<void> {
  if (!initPromise) initPromise = initialize();
  return initPromise;
}

async function initialize(): Promise<void> {
  try {
    // 限制内容脚本直接读存储；旧版本 Chrome 没有这个 API 时忽略。
    const storage = chrome.storage.local as chrome.storage.LocalStorageArea & {
      setAccessLevel?: (options: { accessLevel: string }) => Promise<void>;
    };
    await storage.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    /* 该 API 不可用时继续，后台仍是唯一写入口。 */
  }

  const raw = await readRaw(STATE_KEY);
  const migrated = migrateState(raw);
  if (migrated.status === 'unreadable') {
    unreadable = { reason: migrated.reason, details: migrated.details, raw: migrated.raw };
    cachedState = null;
    return;
  }
  cachedState = fillDefaults(migrated.state);
  if (migrated.status === 'empty') {
    await chrome.storage.local.set({ [STATE_KEY]: cachedState });
  }
  await cleanupExpiredRuns();
}

export function getUnreadable(): UnreadableState | null {
  return unreadable;
}

export async function getState(): Promise<AppState> {
  await ensureInitialized();
  if (!cachedState) {
    throw new StorageError('STATE_UNREADABLE', unreadable?.reason ?? '本地数据无法读取');
  }
  return cachedState;
}

export interface MutationContext {
  state: AppState;
}

export interface MutationOutcome<T> {
  state: AppState;
  data: T;
}

export type Mutator<T> = (context: MutationContext) => MutationOutcome<T> | Promise<MutationOutcome<T>>;

export interface MutateOptions {
  requestId: string;
  expectedRevision?: number;
  /**
   * 后台自身的记账（例如运行报告）不算用户编辑，不推进 revision，
   * 否则打开着的工作台页面会因为一次填写就全部失效。
   */
  bumpRevision?: boolean;
}

/** 写操作：串行、校验 revision、requestId 去重、一次 set。 */
export async function mutate<T>(options: MutateOptions, mutator: Mutator<T>): Promise<T> {
  await ensureInitialized();
  const run = writeChain.then(async () => {
    if (!cachedState) throw new StorageError('STATE_UNREADABLE', unreadable?.reason ?? '本地数据无法读取');

    const done = cachedState.processedMutations.find((entry) => entry.requestId === options.requestId);
    if (done) {
      // 重试同一个 mutation 直接回应成功，不重复写入。
      return { duplicated: true as const, value: undefined as unknown as T };
    }
    if (options.expectedRevision !== undefined && options.expectedRevision !== cachedState.revision) {
      throw new StorageError(
        'REVISION_CONFLICT',
        `数据已被其他页面修改（当前版本 ${cachedState.revision}，你的页面是 ${options.expectedRevision}），请重新载入后再试`,
      );
    }

    const outcome = await mutator({ state: cachedState });
    const bump = options.bumpRevision !== false;
    const nextRevision = bump ? cachedState.revision + 1 : cachedState.revision;
    const processed = [
      ...outcome.state.processedMutations.filter((entry) => entry.requestId !== options.requestId),
      { requestId: options.requestId, revision: nextRevision },
    ].slice(-MAX_PROCESSED_MUTATIONS);

    const nextState: AppState = {
      ...outcome.state,
      revision: nextRevision,
      recentRuns: outcome.state.recentRuns.slice(-MAX_RECENT_RUNS),
      processedMutations: processed,
    };

    const validated = appStateSchema.safeParse(nextState);
    if (!validated.success) {
      const first = validated.error.issues[0];
      throw new StorageError(
        'INVALID_STATE',
        `写入前校验失败：${first ? `${first.path.join('.')} ${first.message}` : '未知错误'}`,
      );
    }

    const serialized = JSON.stringify(nextState);
    const size = new TextEncoder().encode(serialized).length;
    if (size > SOFT_QUOTA_BYTES && size > JSON.stringify(cachedState).length) {
      throw new StorageError(
        'QUOTA_SOFT_LIMIT',
        `本地数据已达 ${(size / 1024 / 1024).toFixed(2)} MiB，接近上限。请先导出备份并清理旧运行记录。`,
      );
    }

    try {
      await chrome.storage.local.set({ [STATE_KEY]: nextState });
    } catch (error) {
      // 配额错误时保持上次成功状态。
      throw new StorageError('QUOTA_EXCEEDED', `写入本地存储失败：${(error as Error).message}。已保留上一次成功的数据。`);
    }
    cachedState = nextState as AppState;
    return { duplicated: false as const, value: outcome.data };
  });

  writeChain = run.catch(() => undefined);
  const result = await run;
  if (result.duplicated) {
    // 幂等重试：返回当前状态派生的空结果由调用方处理。
    return undefined as unknown as T;
  }
  return result.value;
}

/** 活动运行元数据独立保存，不进入 AppState 或备份。 */
export async function getActiveRuns(): Promise<ActiveRunMeta[]> {
  const raw = await readRaw(ACTIVE_RUNS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is ActiveRunMeta =>
    !!entry && typeof entry === 'object' && typeof (entry as ActiveRunMeta).runId === 'string');
}

export async function setActiveRuns(runs: ActiveRunMeta[]): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_RUNS_KEY]: runs.slice(-20) });
}

export async function upsertActiveRun(meta: ActiveRunMeta): Promise<void> {
  const runs = await getActiveRuns();
  const next = runs.filter((entry) => entry.runId !== meta.runId);
  next.push(meta);
  await setActiveRuns(next);
}

export async function removeActiveRun(runId: string): Promise<void> {
  const runs = await getActiveRuns();
  await setActiveRuns(runs.filter((entry) => entry.runId !== runId));
}

const RUN_META_TTL_MS = 30 * 60 * 1000;

export async function cleanupExpiredRuns(): Promise<void> {
  const runs = await getActiveRuns();
  const now = Date.now();
  const alive = runs.filter((entry) => now - Date.parse(entry.lastSeenAt) < RUN_META_TTL_MS);
  if (alive.length !== runs.length) await setActiveRuns(alive);
}

export async function usageBytes(): Promise<number> {
  try {
    return await chrome.storage.local.getBytesInUse(null);
  } catch {
    return 0;
  }
}

/** 完整备份恢复：整库替换，先校验再一次写入。 */
export async function replaceState(nextState: AppState, requestId: string): Promise<AppState> {
  await ensureInitialized();
  const validated = appStateSchema.safeParse(nextState);
  if (!validated.success) {
    throw new StorageError('INVALID_STATE', '备份文件未通过校验，已保留现有数据');
  }
  const base = validated.data as AppState;
  const restored: AppState = {
    ...base,
    revision: (cachedState?.revision ?? 0) + 1,
    processedMutations: [{ requestId, revision: (cachedState?.revision ?? 0) + 1 }],
  };
  await chrome.storage.local.set({ [STATE_KEY]: restored });
  cachedState = restored;
  unreadable = null;
  return restored;
}

/** 仅供测试重置模块内缓存。 */
export function __resetForTests(): void {
  cachedState = null;
  unreadable = null;
  initPromise = null;
  writeChain = Promise.resolve();
}

export { createEmptyState };
