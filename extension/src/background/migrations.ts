import { appStateSchema, formatIssues } from '../shared/schemas';
import type { AppState } from '../shared/types';

/** 存储版本迁移。未知或损坏的数据进入只读恢复提示，绝不重置为空库。 */

export const CURRENT_SCHEMA_VERSION = 1;

export function createEmptyState(timezone = 'Asia/Shanghai'): AppState {
  return {
    schemaVersion: 1,
    revision: 0,
    activeProfileVersionId: null,
    profiles: [],
    applications: [],
    mappings: [],
    recentRuns: [],
    processedMutations: [],
    settings: { timezone },
  };
}

export type MigrationResult =
  | { status: 'empty'; state: AppState }
  | { status: 'ok'; state: AppState; migratedFrom: number | null }
  | { status: 'unreadable'; reason: string; details: Array<{ path: string; message: string }>; raw: unknown };

export function migrateState(raw: unknown): MigrationResult {
  if (raw === undefined || raw === null) {
    return { status: 'empty', state: createEmptyState() };
  }
  if (typeof raw !== 'object') {
    return { status: 'unreadable', reason: '存储中的数据不是对象', details: [], raw };
  }

  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { status: 'unreadable', reason: '缺少可识别的 schemaVersion', details: [], raw };
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    return {
      status: 'unreadable',
      reason: `数据版本 ${version} 高于本扩展支持的 ${CURRENT_SCHEMA_VERSION}，请升级扩展后再打开`,
      details: [],
      raw,
    };
  }

  // 版本 1 是当前版本；未来新增版本时在此逐级升级，并保留可导出的旧状态。
  const parsed = appStateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: 'unreadable',
      reason: '存储中的数据未通过校验',
      details: formatIssues(parsed.error),
      raw,
    };
  }
  return { status: 'ok', state: parsed.data as AppState, migratedFrom: version === CURRENT_SCHEMA_VERSION ? null : version };
}

/** onInstalled 只补缺省值，不清空资料。 */
export function fillDefaults(state: AppState): AppState {
  return {
    ...state,
    settings: { timezone: state.settings?.timezone || 'Asia/Shanghai' },
    profiles: state.profiles ?? [],
    applications: state.applications ?? [],
    mappings: state.mappings ?? [],
    recentRuns: state.recentRuns ?? [],
    processedMutations: state.processedMutations ?? [],
  };
}
