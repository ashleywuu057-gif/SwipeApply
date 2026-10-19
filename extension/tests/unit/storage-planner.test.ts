import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProfileFile } from '../../src/shared/types';
import type { ScanResult } from '../../src/shared/protocol';
import { scanResultSchema } from '../../src/shared/protocol';
import { planRun } from '../../src/background/planner';
import { fieldFingerprint, formFingerprint } from '../../src/shared/fingerprints';
import { normalizeLabel } from '../../src/shared/normalize';
import type { ControlKind, FieldDescriptor, FieldOption } from '../../src/shared/types';

const root = path.resolve(__dirname, '../..');
const demoProfile = JSON.parse(readFileSync(path.join(root, 'fixtures/profile.demo.json'), 'utf8')) as ProfileFile;

/* ------------------------------ 存储：写入队列 ------------------------------ */

interface FakeStorage {
  data: Record<string, unknown>;
  setCalls: number;
}

function installFakeChrome(): FakeStorage {
  const store: FakeStorage = { data: {}, setCalls: 0 };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store.data[key] }),
        set: async (items: Record<string, unknown>) => {
          store.setCalls += 1;
          Object.assign(store.data, JSON.parse(JSON.stringify(items)));
        },
        getBytesInUse: async () => JSON.stringify(store.data).length,
        setAccessLevel: async () => undefined,
      },
    },
  };
  return store;
}

describe('U11 存储写入：revision 校验与 mutation 去重', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('重复的 requestId 不会重复写入', async () => {
    installFakeChrome();
    const storage = await import('../../src/background/storage');
    storage.__resetForTests();

    const first = await storage.mutate({ requestId: 'req-1' }, ({ state }) => ({
      state: { ...state, settings: { timezone: 'Asia/Tokyo' } },
      data: 'first',
    }));
    expect(first).toBe('first');
    const revisionAfterFirst = (await storage.getState()).revision;

    const retry = await storage.mutate({ requestId: 'req-1' }, ({ state }) => ({
      state: { ...state, settings: { timezone: 'Europe/Paris' } },
      data: 'second',
    }));
    expect(retry).toBeUndefined();
    const state = await storage.getState();
    expect(state.revision).toBe(revisionAfterFirst);
    expect(state.settings.timezone).toBe('Asia/Tokyo');
  });

  it('expectedRevision 不一致时拒绝写入并提示重新载入', async () => {
    installFakeChrome();
    const storage = await import('../../src/background/storage');
    storage.__resetForTests();

    await storage.mutate({ requestId: 'req-a' }, ({ state }) => ({ state, data: null }));
    await expect(
      storage.mutate({ requestId: 'req-b', expectedRevision: 0 }, ({ state }) => ({ state, data: null })),
    ).rejects.toThrow(/重新载入/);
  });

  it('写入前校验失败时保留上一次成功的数据', async () => {
    const store = installFakeChrome();
    const storage = await import('../../src/background/storage');
    storage.__resetForTests();

    await storage.mutate({ requestId: 'ok-1' }, ({ state }) => ({
      state: { ...state, profiles: [demoProfile] },
      data: null,
    }));
    const setsAfterValid = store.setCalls;

    await expect(
      storage.mutate({ requestId: 'bad-1' }, ({ state }) => ({
        state: { ...state, activeProfileVersionId: 42 as unknown as string },
        data: null,
      })),
    ).rejects.toThrow(/校验失败/);

    expect(store.setCalls).toBe(setsAfterValid);
    expect((await storage.getState()).profiles).toHaveLength(1);
  });

  it('损坏的存储进入只读状态，不清空数据', async () => {
    const store = installFakeChrome();
    store.data['applykit.state.v1'] = { schemaVersion: 1, revision: 'not-a-number' };
    const storage = await import('../../src/background/storage');
    storage.__resetForTests();

    await expect(storage.getState()).rejects.toThrow();
    expect(storage.getUnreadable()).not.toBeNull();
    expect(store.data['applykit.state.v1']).toEqual({ schemaVersion: 1, revision: 'not-a-number' });
  });
});

/* --------------------------------- 计划生成 --------------------------------- */

function descriptor(options: {
  fieldId: string;
  label: string;
  section?: FieldDescriptor['section'];
  controlKind?: ControlKind;
  options?: FieldOption[];
  recordInstanceId?: string | null;
  empty?: boolean;
  datePart?: FieldDescriptor['datePart'];
  sensitive?: boolean;
}): FieldDescriptor {
  const section = options.section ?? 'unknown';
  const controlKind = options.controlKind ?? 'text';
  const opts = options.options ?? [];
  return {
    fieldId: options.fieldId,
    section,
    sectionInstanceId: 'sec-0',
    recordInstanceId: options.recordInstanceId ?? null,
    label: options.label,
    normalizedLabel: normalizeLabel(options.label),
    nameHint: null,
    placeholderHint: null,
    controlKind,
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
    empty: options.empty ?? true,
    maxLength: null,
    options: opts,
    semanticFingerprint: fieldFingerprint({ section, label: normalizeLabel(options.label), controlKind, options: opts, nameHint: null }),
    datePart: options.datePart ?? null,
    datePrecision: null,
    datePresentValue: null,
    degreeHint: null,
    recordIdentityHint: null,
    unsupportedReason: null,
    sensitive: options.sensitive ?? false,
  };
}

function scanOf(descriptors: FieldDescriptor[], over: Partial<ScanResult> = {}): ScanResult {
  return {
    routeKey: '/basic.html',
    origin: 'http://127.0.0.1:4173',
    pageTitle: '演示',
    descriptors,
    recordInstances: [],
    addActions: [],
    adapterBindings: [],
    orderFallbackSections: [],
    jobCandidate: null,
    adapterId: 'applykit-demo',
    truncated: false,
    truncationReason: null,
    formFingerprint: formFingerprint(descriptors),
    ...over,
  };
}

describe('计划生成', () => {
  it('未展开分区的诊断进入报告提示，但不生成新增或填入动作', () => {
    const diagnostics = ['教育经历尚未展开字段，请先在网页添加经历，再重新扫描；本轮未自动点击添加。'];
    const scan = scanResultSchema.parse(scanOf([], { diagnostics }));
    const plan = planRun({ scan, profile: demoProfile, rules: [] });
    expect(plan.recordBindingNotes).toEqual(diagnostics);
    expect(plan.actions).toEqual([]);
    expect(plan.addRequests).toEqual([]);
    expect(scanResultSchema.safeParse(scanOf([])).success).toBe(true);
    expect(scanResultSchema.safeParse(scanOf([], { diagnostics: Array(31).fill('提示') })).success).toBe(false);
  });

  it('每个字段落在且仅落在一个结果中，动作与待处理项之和等于字段数', () => {
    const descriptors = [
      descriptor({ fieldId: 'f1', label: '姓名', section: 'personal' }),
      descriptor({ fieldId: 'f2', label: 'GitHub', section: 'personal' }),
      descriptor({ fieldId: 'f3', label: '出生日期', section: 'personal', controlKind: 'date' }),
      descriptor({ fieldId: 'f4', label: '未知标签', section: 'personal' }),
      descriptor({ fieldId: 'f5', label: '自我介绍', controlKind: 'textarea' }),
    ];
    const plan = planRun({ scan: scanOf(descriptors), profile: demoProfile, rules: [] });
    expect(plan.actions.length + plan.results.length).toBe(descriptors.length);
    const ids = [...plan.actions.map((a) => a.fieldId), ...plan.results.map((r) => r.fieldId)];
    expect(new Set(ids).size).toBe(descriptors.length);
    expect(plan.actions.map((action) => action.fieldId).sort()).toEqual(['f1', 'f3', 'f5']);
    expect(plan.results.find((r) => r.fieldId === 'f2')?.reasonCode).toBe('SOURCE_MISSING');
    expect(plan.actions.find((action) => action.fieldId === 'f3')?.value).toBe('2002-04-15');
    expect(plan.results.find((r) => r.fieldId === 'f4')?.reasonCode).toBe('NO_MATCH');
  });

  it('默认不覆盖已有内容：动作的 overwrite 为 false', () => {
    const descriptors = [descriptor({ fieldId: 'f1', label: '姓名', section: 'personal', empty: false })];
    const plan = planRun({ scan: scanOf(descriptors), profile: demoProfile, rules: [] });
    expect(plan.actions[0]?.overwrite).toBe(false);
  });

  it('敏感字段只有在站点适配器精确绑定且本地履历明确保存时才进入计划', () => {
    const idField = descriptor({ fieldId: 'id-number', label: '证件号码', section: 'personal', sensitive: true });
    const exact = planRun({
      scan: scanOf([idField], {
        adapterId: 'beisen-zhiye-phoenix',
        adapterBindings: [{ fieldId: 'id-number', section: 'personal', field: 'identityNumber' }],
      }),
      profile: demoProfile,
      rules: [],
    });
    expect(exact.actions).toEqual([
      expect.objectContaining({ fieldId: 'id-number', value: '320000200001010000' }),
    ]);

    const generic = planRun({ scan: scanOf([idField]), profile: demoProfile, rules: [] });
    expect(generic.actions).toEqual([]);
    expect(generic.results).toEqual([
      expect.objectContaining({ fieldId: 'id-number', reasonCode: 'REQUIRES_USER_ACTION' }),
    ]);

    const manualOverride = planRun({
      scan: scanOf([idField], {
        adapterId: 'beisen-zhiye-phoenix',
        adapterBindings: [{ fieldId: 'id-number', section: 'personal', field: 'identityNumber' }],
      }),
      profile: demoProfile,
      rules: [],
      manualBindings: new Map([['id-number', { section: 'personal', field: 'email' }]]),
    });
    expect(manualOverride.actions).toEqual([]);
    expect(manualOverride.results).toEqual([
      expect.objectContaining({ fieldId: 'id-number', reasonCode: 'REQUIRES_USER_ACTION' }),
    ]);
  });

  it('两段教育按学历层级分别绑定，不串位', () => {
    const descriptors = [
      descriptor({ fieldId: 'm-school', label: '学校', section: 'education', recordInstanceId: 'edu-0' }),
      descriptor({ fieldId: 'm-major', label: '专业', section: 'education', recordInstanceId: 'edu-0' }),
      descriptor({ fieldId: 'b-school', label: '学校', section: 'education', recordInstanceId: 'edu-1' }),
      descriptor({ fieldId: 'b-major', label: '专业', section: 'education', recordInstanceId: 'edu-1' }),
    ];
    const scan = scanOf(descriptors, {
      recordInstances: [
        { section: 'education', sectionInstanceId: 'sec-0', recordInstanceId: 'edu-0', degreeHint: 'master', identityHint: null, order: 0 },
        { section: 'education', sectionInstanceId: 'sec-1', recordInstanceId: 'edu-1', degreeHint: 'bachelor', identityHint: null, order: 1 },
      ],
    });
    const plan = planRun({ scan, profile: demoProfile, rules: [] });
    const byId = new Map(plan.actions.map((action) => [action.fieldId, action]));
    expect(byId.get('m-school')?.value).toBe('示例理工大学');
    expect(byId.get('m-major')?.value).toBe('软件工程');
    expect(byId.get('b-school')?.value).toBe('示例工程学院');
    expect(byId.get('b-major')?.value).toBe('计算机科学与技术');
  });

  it('页面记录少于履历且有新增按钮时请求新增，数量不超过缺口', () => {
    const descriptors = [
      descriptor({ fieldId: 'p-name', label: '项目名称', section: 'projects', recordInstanceId: 'proj-0' }),
      descriptor({ fieldId: 'p-role', label: '项目职责', section: 'projects', recordInstanceId: 'proj-0' }),
    ];
    const scan = scanOf(descriptors, {
      recordInstances: [
        { section: 'projects', sectionInstanceId: 'sec-0', recordInstanceId: 'proj-0', degreeHint: null, identityHint: null, order: 0 },
      ],
      addActions: [{ section: 'projects', sectionInstanceId: 'sec-0', label: '新增项目经历' }],
      orderFallbackSections: ['projects'],
    });
    const plan = planRun({ scan, profile: demoProfile, rules: [] });
    expect(plan.addRequests).toEqual([{ section: 'projects', sectionInstanceId: 'sec-0', count: 1 }]);
  });

  it('页面记录已经足够时不再请求新增（重复运行不会重复新增）', () => {
    const descriptors = [
      descriptor({ fieldId: 'p1', label: '项目名称', section: 'projects', recordInstanceId: 'proj-0' }),
      descriptor({ fieldId: 'p2', label: '项目名称', section: 'projects', recordInstanceId: 'proj-1' }),
    ];
    const scan = scanOf(descriptors, {
      recordInstances: [
        { section: 'projects', sectionInstanceId: 'sec-0', recordInstanceId: 'proj-0', degreeHint: null, identityHint: null, order: 0 },
        { section: 'projects', sectionInstanceId: 'sec-0', recordInstanceId: 'proj-1', degreeHint: null, identityHint: null, order: 1 },
      ],
      addActions: [{ section: 'projects', sectionInstanceId: 'sec-0', label: '新增项目经历' }],
      orderFallbackSections: ['projects'],
    });
    const plan = planRun({ scan, profile: demoProfile, rules: [] });
    expect(plan.addRequests).toHaveLength(0);
  });

  it('网页多出的完全空白经历保留结果但按记录标记为可折叠提示', () => {
    const descriptors = ['edu-0', 'edu-1', 'edu-2'].map((recordInstanceId, index) => descriptor({
      fieldId: `school-${index}`,
      label: '学校名称',
      section: 'education',
      recordInstanceId,
    }));
    const scan = scanOf(descriptors, {
      recordInstances: ['edu-0', 'edu-1', 'edu-2'].map((recordInstanceId, order) => ({
        section: 'education' as const,
        sectionInstanceId: 'sec-0',
        recordInstanceId,
        degreeHint: null,
        identityHint: null,
        order,
      })),
      orderFallbackSections: ['education'],
    });
    const plan = planRun({ scan, profile: demoProfile, rules: [] });
    expect(plan.excessEmptyRecordInstanceIds).toEqual(['edu-2']);
    expect(plan.recordBindingNotes).toContain(
      '教育经历：网页多出 1 条完全空白的记录，履历中没有对应经历；详情已按记录折叠，请在网页删除空记录或手动补充。',
    );
    expect(plan.results).toEqual([
      expect.objectContaining({ fieldId: 'school-2', reasonCode: 'SOURCE_MISSING' }),
    ]);
  });

  it('网页已经勾选至今时不再重复报告同一条记录的空结束日期', () => {
    const endDate = descriptor({
      fieldId: 'project-end',
      label: '结束时间',
      section: 'projects',
      controlKind: 'date-picker',
      recordInstanceId: 'project-0',
    });
    const checkedPresent = {
      ...descriptor({
        fieldId: 'project-present',
        label: '结束时间至今',
        section: 'projects',
        controlKind: 'checkbox',
        recordInstanceId: 'project-0',
        empty: false,
      }),
      disabled: true,
    };
    const scan = scanOf([endDate, checkedPresent], {
      recordInstances: [{
        section: 'projects',
        sectionInstanceId: 'sec-0',
        recordInstanceId: 'project-0',
        degreeHint: null,
        identityHint: null,
        order: 0,
      }],
      orderFallbackSections: ['projects'],
    });
    const plan = planRun({ scan, profile: demoProfile, rules: [] });
    expect(plan.results.map((result) => result.fieldId)).toEqual(['project-present']);
  });

  it('本轮计划勾选至今也会去掉同记录无来源的禁用结束日期提示', () => {
    const endDate = {
      ...descriptor({
        fieldId: 'project-end',
        label: '结束时间',
        section: 'projects',
        controlKind: 'date-picker',
        recordInstanceId: 'project-0',
        datePart: { edge: 'end' as const, unit: 'month' as const },
      }),
      disabled: true,
    };
    const present = descriptor({
      fieldId: 'project-present',
      label: '结束时间至今',
      section: 'projects',
      controlKind: 'checkbox',
      recordInstanceId: 'project-0',
    });
    const scan = scanOf([endDate, present], {
      adapterBindings: [
        { fieldId: 'project-end', section: 'projects', field: 'endDate' },
        { fieldId: 'project-present', section: 'projects', field: 'endDate' },
      ],
      recordInstances: [{
        section: 'projects',
        sectionInstanceId: 'sec-0',
        recordInstanceId: 'project-0',
        degreeHint: null,
        identityHint: null,
        order: 0,
      }],
      orderFallbackSections: ['projects'],
    });
    const plan = planRun({ scan, profile: demoProfile, rules: [] });
    expect(plan.actions).toEqual([
      expect.objectContaining({ fieldId: 'project-present', kind: 'checkbox', value: true }),
    ]);
    expect(plan.results.map((result) => result.fieldId)).not.toContain('project-end');
  });

  it('计划里不含任何模型调用或可执行片段', () => {
    const descriptors = [descriptor({ fieldId: 'f1', label: '姓名', section: 'personal' })];
    const plan = planRun({ scan: scanOf(descriptors), profile: demoProfile, rules: [] });
    const serialized = JSON.stringify(plan.actions);
    expect(serialized).not.toMatch(/function|=>|javascript:|querySelector/);
  });
});
