import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bindRecords, matchField, type MatchContext, type RecordSummary } from '../../src/shared/matching';
import { fieldFingerprint } from '../../src/shared/fingerprints';
import { normalizeLabel } from '../../src/shared/normalize';
import { jobCandidateFromHeuristic } from '../../src/content/job-posting';
import type { ControlKind, FieldDescriptor, FieldOption, ProfileFile, SectionKind } from '../../src/shared/types';

const root = path.resolve(__dirname, '../..');
const demoProfile = JSON.parse(readFileSync(path.join(root, 'fixtures/profile.demo.json'), 'utf8')) as ProfileFile;

interface DescriptorOptions {
  fieldId?: string;
  section?: SectionKind;
  label: string;
  controlKind?: ControlKind;
  options?: FieldOption[];
  recordInstanceId?: string | null;
  nameHint?: string | null;
  placeholderHint?: string | null;
  empty?: boolean;
}

function descriptor(options: DescriptorOptions): FieldDescriptor {
  const section = options.section ?? 'unknown';
  const controlKind = options.controlKind ?? 'text';
  const opts = options.options ?? [];
  return {
    fieldId: options.fieldId ?? `field-${options.label}`,
    section,
    sectionInstanceId: 'sec-0',
    recordInstanceId: options.recordInstanceId ?? null,
    label: options.label,
    normalizedLabel: normalizeLabel(options.label),
    nameHint: options.nameHint ?? null,
    placeholderHint: options.placeholderHint ?? null,
    controlKind,
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
    empty: options.empty ?? true,
    maxLength: null,
    options: opts,
    semanticFingerprint: fieldFingerprint({
      section,
      label: normalizeLabel(options.label),
      controlKind,
      options: opts,
      nameHint: options.nameHint ?? null,
    }),
    datePart: null,
    datePrecision: null,
    datePresentValue: null,
    degreeHint: null,
    recordIdentityHint: null,
    unsupportedReason: null,
    sensitive: false,
  };
}

function context(overrides: Partial<MatchContext> = {}): MatchContext {
  return {
    data: demoProfile.data,
    profileId: demoProfile.profileId,
    rules: [],
    recordBindings: new Map(),
    ...overrides,
  };
}

describe('U03 分区内同名字段不交叉', () => {
  it('站点适配器的明确语义优先于通用同名别名', () => {
    const field = descriptor({ fieldId: 'city-list', label: '意向城市', section: 'preferences', controlKind: 'combobox' });
    const result = matchField(field, context({
      adapterBindings: new Map([['city-list', { section: 'preferences', field: 'preferredCities' }]]),
    }));
    expect(result.kind === 'matched' && result.source).toEqual({ section: 'preferences', field: 'preferredCities' });
  });

  it('个人姓名、学校与公司名称各归各的分区', () => {
    const personal = matchField(descriptor({ label: '姓名', section: 'personal' }), context());
    expect(personal.kind === 'matched' && personal.source).toEqual({ section: 'personal', field: 'fullName' });

    const bindings = new Map([['edu-0', { ok: true as const, recordId: 'edu-demo-master', reason: 'degree' as const }]]);
    const school = matchField(
      descriptor({ label: '学校', section: 'education', recordInstanceId: 'edu-0' }),
      context({ recordBindings: bindings }),
    );
    expect(school.kind === 'matched' && school.source).toEqual({
      section: 'education',
      recordId: 'edu-demo-master',
      field: 'school',
    });

    const internBindings = new Map([['intern-0', { ok: true as const, recordId: 'intern-demo-001', reason: 'unique' as const }]]);
    const company = matchField(
      descriptor({ label: '公司名称', section: 'internships', recordInstanceId: 'intern-0' }),
      context({ recordBindings: internBindings }),
    );
    expect(company.kind === 'matched' && company.source).toEqual({
      section: 'internships',
      recordId: 'intern-demo-001',
      field: 'company',
    });
  });

  it('学校地址、现居地、户籍地不会被合并成同一个字段', () => {
    const current = matchField(descriptor({ label: '现居地', section: 'personal' }), context());
    expect(current.kind === 'matched' && current.source.field).toBe('currentCity');

    const nativePlace = matchField(descriptor({ label: '籍贯', section: 'personal' }), context());
    expect(nativePlace.kind === 'matched' && nativePlace.source.field).toBe('nativePlace');

    for (const label of ['学校地址', '户籍地']) {
      const result = matchField(descriptor({ label, section: 'education' }), context());
      expect(result.kind).toBe('rejected');
      if (result.kind === 'rejected') expect(result.reasonCode).toBe('NO_MATCH');
    }
  });

  it('只有弱提示时不自动填写', () => {
    const result = matchField(
      descriptor({ label: '请填写', section: 'personal', placeholderHint: '邮箱' }),
      context(),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.reasonCode).toBe('NO_MATCH');
  });
});

describe('U04 多教育、多项目与排序', () => {
  const educations: RecordSummary[] = [
    { id: 'edu-demo-master', degreeLevel: 'master', identity: '示例理工大学' },
    { id: 'edu-demo-bachelor', degreeLevel: 'bachelor', identity: '示例工程学院' },
  ];

  it('按页面标注的学历层级绑定', () => {
    const bound = bindRecords(
      [
        { recordInstanceId: 'a', degreeHint: 'bachelor', identityHint: null, order: 0 },
        { recordInstanceId: 'b', degreeHint: 'master', identityHint: null, order: 1 },
      ],
      educations,
    );
    expect(bound.get('a')).toMatchObject({ ok: true, recordId: 'edu-demo-bachelor' });
    expect(bound.get('b')).toMatchObject({ ok: true, recordId: 'edu-demo-master' });
  });

  it('两个全空容器在通用模式下不按顺序猜测', () => {
    const bound = bindRecords(
      [
        { recordInstanceId: 'a', degreeHint: null, identityHint: null, order: 0 },
        { recordInstanceId: 'b', degreeHint: null, identityHint: null, order: 1 },
      ],
      educations,
    );
    expect(bound.get('a')).toMatchObject({ ok: false, reasonCode: 'AMBIGUOUS_RECORD' });
    expect(bound.get('b')).toMatchObject({ ok: false, reasonCode: 'AMBIGUOUS_RECORD' });
  });

  it('适配器明确允许按顺序时才使用顺序', () => {
    const bound = bindRecords(
      [
        { recordInstanceId: 'a', degreeHint: null, identityHint: null, order: 0 },
        { recordInstanceId: 'b', degreeHint: null, identityHint: null, order: 1 },
      ],
      educations,
      { allowOrderFallback: true },
    );
    expect(bound.get('a')).toMatchObject({ ok: true, recordId: 'edu-demo-master', reason: 'order' });
    expect(bound.get('b')).toMatchObject({ ok: true, recordId: 'edu-demo-bachelor', reason: 'order' });
  });

  it('页面只有一个槽位时优先使用履历标记的默认记录', () => {
    const bound = bindRecords(
      [{ recordInstanceId: 'only', degreeHint: null, identityHint: null, order: 0 }],
      educations,
      { defaultRecordId: 'edu-demo-bachelor' },
    );
    expect(bound.get('only')).toMatchObject({
      ok: true,
      recordId: 'edu-demo-bachelor',
      reason: 'default',
    });
  });

  it('唯一容器对唯一记录可以绑定', () => {
    const bound = bindRecords(
      [{ recordInstanceId: 'only', degreeHint: null, identityHint: null, order: 0 }],
      [{ id: 'intern-demo-001', degreeLevel: null, identity: '云笺科技（虚构）' }],
    );
    expect(bound.get('only')).toMatchObject({ ok: true, recordId: 'intern-demo-001', reason: 'unique' });
  });

  it('页面上两处同名项目进入待处理，不改绑到别的项目', () => {
    const projects: RecordSummary[] = [
      { id: 'project-demo-001', degreeLevel: null, identity: '示例知识检索助手' },
      { id: 'project-demo-002', degreeLevel: null, identity: '示例任务管理平台' },
    ];
    const bound = bindRecords(
      [
        { recordInstanceId: 'a', degreeHint: null, identityHint: '示例知识检索助手', order: 0 },
        { recordInstanceId: 'b', degreeHint: null, identityHint: '示例知识检索助手', order: 1 },
      ],
      projects,
      { allowOrderFallback: true },
    );
    expect(bound.get('a')).toMatchObject({ ok: true, recordId: 'project-demo-001', reason: 'identity' });
    expect(bound.get('b')).toMatchObject({ ok: false, reasonCode: 'AMBIGUOUS_RECORD' });
  });

  it('ID 绑定与数组位置无关：排序后仍绑定同一条记录', () => {
    const reordered = [...educations].reverse();
    const bound = bindRecords(
      [{ recordInstanceId: 'a', degreeHint: 'master', identityHint: null, order: 0 }],
      reordered,
    );
    expect(bound.get('a')).toMatchObject({ ok: true, recordId: 'edu-demo-master' });
  });

  it('履历中有两段同层级学历时报告歧义', () => {
    const twoMasters: RecordSummary[] = [
      { id: 'edu-1', degreeLevel: 'master', identity: 'A 大学' },
      { id: 'edu-2', degreeLevel: 'master', identity: 'B 大学' },
    ];
    const bound = bindRecords(
      [{ recordInstanceId: 'a', degreeHint: 'master', identityHint: null, order: 0 }],
      twoMasters,
    );
    expect(bound.get('a')).toMatchObject({ ok: false, reasonCode: 'AMBIGUOUS_RECORD' });
  });
});

describe('匹配分值与歧义', () => {
  it('两个同分候选进入待处理，不按先后顺序消除冲突', () => {
    // 「结束时间」在项目与实习分区都存在；分区未知时不应强行选一个。
    const result = matchField(descriptor({ label: '结束时间', section: 'unknown' }), context());
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.reasonCode).toBe('AMBIGUOUS_FIELD');
  });

  it('用户规则优先于别名', () => {
    const target = descriptor({ label: '联系信箱入口', section: 'personal' });
    const rules = [
      {
        id: 'mapping-1',
        origin: 'http://127.0.0.1:4173',
        routeKey: '/edge-cases.html',
        formFingerprint: 's1:abc',
        section: 'personal' as const,
        fieldLabel: '联系信箱入口',
        controlKind: 'text' as const,
        fieldFingerprint: target.semanticFingerprint,
        sourceField: 'email',
        recordSelector: { kind: 'single' as const },
        createdAt: '2026-09-03T00:00:00.000Z',
        updatedAt: '2026-09-03T00:00:00.000Z',
        lastVerifiedAt: '2026-09-03T00:00:00.000Z',
      },
    ];
    const result = matchField(target, context({ rules }));
    expect(result.kind === 'matched' && result.source).toEqual({ section: 'personal', field: 'email' });
    expect(result.kind === 'matched' && result.reasons).toContain('user-rule');
  });

  it('重复分区缺少记录绑定时报告歧义', () => {
    const result = matchField(
      descriptor({ label: '学校', section: 'education', recordInstanceId: 'edu-x' }),
      context(),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.reasonCode).toBe('AMBIGUOUS_RECORD');
  });
});

describe('岗位候选启发式（真实站点回归）', () => {
  const fakeDocument = (title: string, href: string) =>
    ({ title, location: { href }, querySelectorAll: () => [] }) as unknown as Document;

  it('标题两边都不像岗位名时不给候选', () => {
    // app.mokahr.com 的搜狐校园招聘页标题是「搜狐 - 校园招聘」，
    // 早期版本会把「校园招聘」当公司、「搜狐」当岗位。
    expect(jobCandidateFromHeuristic(fakeDocument('搜狐 - 校园招聘', 'https://app.mokahr.com/campus_apply/sohu/36036'))).toBeNull();
  });

  it('某一边像岗位名时按语义而不是按位置切分', () => {
    const left = jobCandidateFromHeuristic(fakeDocument('后端开发实习生 - 星帆科技', 'https://jobs.example.com/a'));
    expect(left).toMatchObject({ role: '后端开发实习生', company: '星帆科技' });

    const right = jobCandidateFromHeuristic(fakeDocument('星帆科技 | 数据分析师', 'https://jobs.example.com/b'));
    expect(right).toMatchObject({ role: '数据分析师', company: '星帆科技' });
  });

  it('两边都像岗位名时放弃，不猜', () => {
    expect(jobCandidateFromHeuristic(fakeDocument('后端工程师 - 前端工程师', 'https://jobs.example.com/c'))).toBeNull();
  });
});
