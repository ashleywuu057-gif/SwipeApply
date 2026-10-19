import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  applyImport, buildRecord, changeStatus, confirmSubmitted, findDuplicates, planImport, putRecord,
} from '../../src/background/applications';
import { createEmptyState, migrateState } from '../../src/background/migrations';
import { importProfile, saveProfileVersion, isDemoProfile, isLoopbackOrigin } from '../../src/background/profiles';
import { applicableRules, upsertMapping } from '../../src/background/rules';
import { isContentSender, isTrustedUiSender } from '../../src/shared/protocol';
import { fieldFingerprint, formFingerprint } from '../../src/shared/fingerprints';
import { normalizeLabel } from '../../src/shared/normalize';
import type { AppState, ApplicationRecord, FieldDescriptor, ProfileFile } from '../../src/shared/types';

const root = path.resolve(__dirname, '../..');
const demoProfile = JSON.parse(readFileSync(path.join(root, 'fixtures/profile.demo.json'), 'utf8')) as ProfileFile;
const NOW = '2026-09-03T12:00:00.000Z';

function stateWithProfile(): AppState {
  const empty = createEmptyState();
  return { ...empty, profiles: [demoProfile], activeProfileVersionId: demoProfile.profileVersionId };
}

async function makeRecord(state: AppState, over: Partial<Parameters<typeof buildRecord>[1]> = {}): Promise<ApplicationRecord> {
  const built = await buildRecord(state, {
    id: null, company: '星帆科技（演示）', role: 'AI 应用开发实习生（演示）', location: '杭州',
    sourceUrl: 'http://127.0.0.1:4173/basic.html?jobId=demo-basic-001',
    canonicalUrl: 'http://127.0.0.1:4173/basic.html?jobId=demo-basic-001',
    externalJobId: 'demo-basic-001', profileVersionId: demoProfile.profileVersionId,
    status: 'planned', blocker: 'none', nextAction: null, notes: null, ...over,
  }, NOW);
  return built.record;
}

describe('U10 投递状态迁移', () => {
  it('新记录不能直接是已投递', async () => {
    await expect(makeRecord(stateWithProfile(), { status: 'applied' })).rejects.toThrow(/新记录只能是/);
  });

  it('没有提交证据不能改成已投递或后续阶段', async () => {
    const record = await makeRecord(stateWithProfile());
    expect(() => changeStatus({ record, next: 'applied', blocker: 'none', reason: null, now: NOW }))
      .toThrow(/确认入口/);
    expect(() => changeStatus({ record, next: 'interview', blocker: 'none', reason: null, now: NOW }))
      .toThrow(/没有提交证据/);
  });

  it('用户确认后才写入 appliedAt 与证据', async () => {
    const record = await makeRecord(stateWithProfile());
    const applied = confirmSubmitted({ record, appliedAt: NOW, note: null, now: NOW });
    expect(applied.status).toBe('applied');
    expect(applied.appliedAt).toBe(NOW);
    expect(applied.submissionEvidence).toMatchObject({ kind: 'user-confirmed', successSeen: true });
    expect(applied.timeline.at(-1)).toMatchObject({ from: 'planned', to: 'applied' });
  });

  it('已投递后可以进入后续阶段', async () => {
    const record = await makeRecord(stateWithProfile());
    const applied = confirmSubmitted({ record, appliedAt: NOW, note: null, now: NOW });
    const interview = changeStatus({ record: applied, next: 'interview', blocker: 'none', reason: null, now: NOW });
    expect(interview.status).toBe('interview');
    expect(interview.appliedAt).toBe(NOW);
  });

  it('回退已投递必须给出理由，并追加 timeline', async () => {
    const record = await makeRecord(stateWithProfile());
    const applied = confirmSubmitted({ record, appliedAt: NOW, note: null, now: NOW });
    expect(() => changeStatus({ record: applied, next: 'ready', blocker: 'none', reason: null, now: NOW }))
      .toThrow(/必须填写理由/);
    const corrected = changeStatus({ record: applied, next: 'ready', blocker: 'none', reason: '之前误标记', now: NOW });
    expect(corrected.appliedAt).toBeNull();
    expect(corrected.submissionEvidence).toBeNull();
    expect(corrected.timeline).toHaveLength(applied.timeline.length + 1);
  });

  it('普通编辑不会改写 appliedAt、证据或旧 timeline', async () => {
    let state = stateWithProfile();
    const record = await makeRecord(state);
    const applied = confirmSubmitted({ record, appliedAt: NOW, note: null, now: NOW });
    state = putRecord(state, applied);
    const edited = await buildRecord(state, {
      id: applied.id, company: applied.company, role: applied.role, location: '上海',
      sourceUrl: applied.sourceUrl, canonicalUrl: applied.canonicalUrl, externalJobId: applied.externalJobId,
      profileVersionId: applied.profileVersionId, status: applied.status, blocker: applied.blocker,
      nextAction: '准备面试', notes: null,
    }, '2026-09-04T00:00:00.000Z');
    expect(edited.record.appliedAt).toBe(NOW);
    expect(edited.record.submissionEvidence).toEqual(applied.submissionEvidence);
    expect(edited.record.timeline).toEqual(applied.timeline);
    expect(edited.record.location).toBe('上海');
  });
});

describe('U07 去重提示', () => {
  it('同一岗位提示已有记录，不同岗位独立保存', async () => {
    let state = stateWithProfile();
    const first = await makeRecord(state);
    state = putRecord(state, first);

    const same = await makeRecord(state);
    expect(findDuplicates(state, same).exact?.id).toBe(first.id);

    const other = await makeRecord(state, {
      role: 'Python 后端实习生（演示）',
      sourceUrl: 'http://127.0.0.1:4173/experience.html?jobId=demo-experience-001',
      canonicalUrl: 'http://127.0.0.1:4173/experience.html?jobId=demo-experience-001',
      externalJobId: 'demo-experience-001',
    });
    expect(findDuplicates(state, other).exact).toBeNull();
  });
});

describe('CSV 与记录导入策略', () => {
  it('相同 ID 且内容相同默认跳过；冲突项可以追加为新申请', async () => {
    let state = stateWithProfile();
    const record = await makeRecord(state);
    state = putRecord(state, record);

    const identical = planImport(state, [record]);
    expect(identical.identical).toHaveLength(1);

    const changed: ApplicationRecord = { ...record, nextAction: '换了一个下一步' };
    const conflict = planImport(state, [changed]);
    expect(conflict.conflictsById).toHaveLength(1);

    const skipped = applyImport(state, [changed], 'skip-identical');
    expect(skipped.state.applications).toHaveLength(1);
    expect(skipped.state.applications[0]!.nextAction).toBe(record.nextAction);

    const appended = applyImport(state, [changed], 'append-as-new');
    expect(appended.state.applications).toHaveLength(2);
    expect(appended.state.applications[1]!.id).not.toBe(record.id);
  });
});

describe('履历版本', () => {
  it('导入同版本同内容是幂等的', () => {
    const state = createEmptyState();
    const first = importProfile(state, demoProfile, 'reject');
    expect(first.outcome.kind).toBe('imported');
    const again = importProfile(first.state, demoProfile, 'reject');
    expect(again.outcome.kind).toBe('idempotent');
    expect(again.state.profiles).toHaveLength(1);
  });

  it('同版本不同内容必须提示冲突，另存时生成新版本', () => {
    const state = importProfile(createEmptyState(), demoProfile, 'reject').state;
    const modified: ProfileFile = {
      ...demoProfile,
      data: { ...demoProfile.data, personal: { ...demoProfile.data.personal, currentCity: '北京' } },
    };
    expect(() => importProfile(state, modified, 'reject')).toThrow(/内容不同/);
    const saved = importProfile(state, modified, 'save-as-new');
    expect(saved.state.profiles).toHaveLength(2);
    expect(saved.state.profiles[0]!.data.personal.currentCity).toBe('杭州');
  });

  it('编辑保存生成新版本并保留历史', () => {
    const state = importProfile(createEmptyState(), demoProfile, 'reject').state;
    const next = structuredClone(demoProfile.data);
    next.personal.currentCity = '北京';
    const saved = saveProfileVersion(state, demoProfile.profileId, demoProfile.name, next);
    expect(saved.state.profiles).toHaveLength(2);
    expect(saved.state.profiles[0]!.data.personal.currentCity).toBe('杭州');
    expect(saved.state.activeProfileVersionId).toBe(saved.profileVersionId);
    // 经历 ID 在新版本中保持不变。
    expect(saved.state.profiles[1]!.data.education.map((item) => item.id))
      .toEqual(demoProfile.data.education.map((item) => item.id));
  });

  it('虚构资料只能在 loopback 页面使用', () => {
    expect(isDemoProfile(demoProfile)).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:4173')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:4173')).toBe(true);
    expect(isLoopbackOrigin('https://jobs.example.com')).toBe(false);
  });
});

describe('U06 缓存规则与结构变化', () => {
  function makeDescriptor(label: string, options: Array<{ label: string; value: string }> = []): FieldDescriptor {
    return {
      fieldId: `field-${label}`, section: 'personal', sectionInstanceId: 'sec-0', recordInstanceId: null,
      label, normalizedLabel: normalizeLabel(label), nameHint: null, placeholderHint: null,
      controlKind: 'text', required: false, disabled: false, readOnly: false, visible: true, empty: true,
      maxLength: null, options,
      semanticFingerprint: fieldFingerprint({ section: 'personal', label: normalizeLabel(label), controlKind: 'text', options, nameHint: null }),
      datePart: null, datePrecision: null, datePresentValue: null, degreeHint: null, recordIdentityHint: null, unsupportedReason: null, sensitive: false,
    };
  }

  const descriptors = [makeDescriptor('联系信箱入口'), makeDescriptor('姓名')];
  const scope = {
    origin: 'http://127.0.0.1:4173',
    routeKey: '/edge-cases.html',
    formFingerprint: formFingerprint(descriptors),
  };

  it('结构相同的表单可以复用规则', () => {
    const saved = upsertMapping(createEmptyState(), {
      scope, section: 'personal', fieldLabel: '联系信箱入口', controlKind: 'text',
      fieldFingerprint: descriptors[0]!.semanticFingerprint, sourceField: 'email',
      recordSelector: { kind: 'single' },
    }, NOW);
    expect(applicableRules(saved.state, scope, descriptors)).toHaveLength(1);
  });

  it('标签或选项变化后规则失效', () => {
    const saved = upsertMapping(createEmptyState(), {
      scope, section: 'personal', fieldLabel: '联系信箱入口', controlKind: 'text',
      fieldFingerprint: descriptors[0]!.semanticFingerprint, sourceField: 'email',
      recordSelector: { kind: 'single' },
    }, NOW);
    const changed = [makeDescriptor('联系信箱入口（新版）'), makeDescriptor('姓名')];
    const newScope = { ...scope, formFingerprint: formFingerprint(changed) };
    expect(applicableRules(saved.state, newScope, changed)).toHaveLength(0);
  });

  it('同一指纹出现多次时规则失效，避免填错字段', () => {
    const saved = upsertMapping(createEmptyState(), {
      scope, section: 'personal', fieldLabel: '联系信箱入口', controlKind: 'text',
      fieldFingerprint: descriptors[0]!.semanticFingerprint, sourceField: 'email',
      recordSelector: { kind: 'single' },
    }, NOW);
    const duplicated = [...descriptors, makeDescriptor('联系信箱入口')];
    expect(applicableRules(saved.state, { ...scope, formFingerprint: scope.formFingerprint }, duplicated)).toHaveLength(0);
  });

  it('规则不保存任何具体内容', () => {
    const saved = upsertMapping(createEmptyState(), {
      scope, section: 'personal', fieldLabel: '联系信箱入口', controlKind: 'text',
      fieldFingerprint: descriptors[0]!.semanticFingerprint, sourceField: 'email',
      recordSelector: { kind: 'single' },
    }, NOW);
    const serialized = JSON.stringify(saved.mapping);
    expect(serialized).not.toContain('lin@example.com');
    expect(serialized).not.toContain('00000000000');
  });
});

describe('U12 存储版本升级与损坏保护', () => {
  it('空存储得到初始状态', () => {
    const result = migrateState(undefined);
    expect(result.status).toBe('empty');
  });

  it('合法状态原样通过', () => {
    const state = stateWithProfile();
    const result = migrateState(JSON.parse(JSON.stringify(state)));
    expect(result.status).toBe('ok');
  });

  it('未来版本进入只读提示，不清空数据', () => {
    const result = migrateState({ ...createEmptyState(), schemaVersion: 99 });
    expect(result.status).toBe('unreadable');
    if (result.status === 'unreadable') expect(result.reason).toContain('99');
  });

  it('损坏数据不会被重置为空库', () => {
    const broken = { ...createEmptyState(), profiles: 'not-an-array' };
    const result = migrateState(broken);
    expect(result.status).toBe('unreadable');
    if (result.status === 'unreadable') expect(result.raw).toBe(broken);
  });
});

describe('U11 消息来源检查', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';

  it('只接受扩展自己的 popup.html 与 app.html', () => {
    expect(isTrustedUiSender({ id, url: `chrome-extension://${id}/popup.html` }, id)).toBe(true);
    expect(isTrustedUiSender({ id, url: `chrome-extension://${id}/app.html#review/run-1` }, id)).toBe(true);
    expect(isTrustedUiSender({ id, url: `chrome-extension://${id}/evil.html` }, id)).toBe(false);
    expect(isTrustedUiSender({ id: 'other', url: `chrome-extension://other/popup.html` }, id)).toBe(false);
    expect(isTrustedUiSender({ id, url: 'https://jobs.example.com/apply' }, id)).toBe(false);
  });

  it('内容脚本不能冒充管理界面', () => {
    const contentSender = {
      id,
      url: 'https://jobs.example.com/apply',
      frameId: 0,
      tab: { id: 7 } as chrome.tabs.Tab,
    };
    expect(isTrustedUiSender(contentSender, id)).toBe(false);
    expect(isContentSender(contentSender, id)).toBe(true);
    expect(isContentSender({ ...contentSender, frameId: 3 }, id)).toBe(false);
    expect(isContentSender({ id, url: `chrome-extension://${id}/popup.html` }, id)).toBe(false);
  });
});
