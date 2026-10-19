import type { AppState, ProfileData, ProfileFile } from '../shared/types';

/** 履历版本管理：编辑保存生成新的不可变快照，历史版本保留。 */

export class ProfileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

export function sameProfileContent(a: ProfileFile, b: ProfileFile): boolean {
  return stableStringify({ name: a.name, source: a.source, data: a.data }) ===
    stableStringify({ name: b.name, source: b.source, data: b.data });
}

export function nextVersionId(state: AppState, profileId: string): string {
  const existing = new Set(state.profiles.map((profile) => profile.profileVersionId));
  let index = state.profiles.filter((profile) => profile.profileId === profileId).length + 1;
  let candidate = `${profileId}-v${index}`;
  while (existing.has(candidate)) {
    index += 1;
    candidate = `${profileId}-v${index}`;
  }
  return candidate;
}

export function findProfile(state: AppState, profileVersionId: string): ProfileFile | null {
  return state.profiles.find((profile) => profile.profileVersionId === profileVersionId) ?? null;
}

export function getActiveProfile(state: AppState): ProfileFile | null {
  if (!state.activeProfileVersionId) return null;
  return findProfile(state, state.activeProfileVersionId);
}

export type ImportOutcome =
  | { kind: 'idempotent'; profileVersionId: string }
  | { kind: 'imported'; profileVersionId: string }
  | { kind: 'saved-as-new'; profileVersionId: string };

/** 导入履历：同 versionId 且内容相同为幂等；内容不同必须由用户选择另存。 */
export function importProfile(
  state: AppState,
  file: ProfileFile,
  onConflict: 'reject' | 'save-as-new',
): { state: AppState; outcome: ImportOutcome } {
  const existing = findProfile(state, file.profileVersionId);
  if (existing) {
    if (sameProfileContent(existing, file)) {
      return {
        state: { ...state, activeProfileVersionId: existing.profileVersionId },
        outcome: { kind: 'idempotent', profileVersionId: existing.profileVersionId },
      };
    }
    if (onConflict === 'reject') {
      throw new ProfileError(
        'VERSION_CONFLICT',
        `已存在同名版本 ${file.profileVersionId} 且内容不同。快照不会被覆盖，可以选择另存为新版本。`,
      );
    }
    const versionId = nextVersionId(state, file.profileId);
    const copy: ProfileFile = { ...file, profileVersionId: versionId, createdAt: new Date().toISOString() };
    return {
      state: { ...state, profiles: [...state.profiles, copy], activeProfileVersionId: versionId },
      outcome: { kind: 'saved-as-new', profileVersionId: versionId },
    };
  }
  return {
    state: { ...state, profiles: [...state.profiles, file], activeProfileVersionId: file.profileVersionId },
    outcome: { kind: 'imported', profileVersionId: file.profileVersionId },
  };
}

/**
 * 保存编辑：生成新版本快照。
 * demo/fictional 标识不可在编辑器中切换为真实资料。
 */
export function saveProfileVersion(
  state: AppState,
  profileId: string,
  name: string,
  data: ProfileData,
): { state: AppState; profileVersionId: string } {
  const series = state.profiles.filter((profile) => profile.profileId === profileId);
  const base = series[series.length - 1];
  if (!base) throw new ProfileError('PROFILE_NOT_FOUND', `找不到履历系列 ${profileId}`);

  const versionId = nextVersionId(state, profileId);
  const snapshot: ProfileFile = {
    kind: 'applykit-profile',
    schemaVersion: 1,
    profileId,
    profileVersionId: versionId,
    name,
    createdAt: new Date().toISOString(),
    source: base.source,
    data,
  };
  return {
    state: { ...state, profiles: [...state.profiles, snapshot], activeProfileVersionId: versionId },
    profileVersionId: versionId,
  };
}

/** 虚构资料只能在 loopback 演示页面填写。 */
export function isDemoProfile(profile: ProfileFile): boolean {
  return profile.source.type === 'demo' || profile.source.status === 'fictional';
}

export function isLoopbackOrigin(origin: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}
