import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { projectValue } from '../../src/shared/projection';
import { getCatalogField, readFieldValue } from '../../src/shared/field-catalog';
import { fieldFingerprint } from '../../src/shared/fingerprints';
import { normalizeLabel } from '../../src/shared/normalize';
import type {
  ControlKind, DatePart, FieldDescriptor, FieldOption, FieldRef, ProfileFile,
} from '../../src/shared/types';

const root = path.resolve(__dirname, '../..');
const demoProfile = JSON.parse(readFileSync(path.join(root, 'fixtures/profile.demo.json'), 'utf8')) as ProfileFile;
const data = demoProfile.data;

function descriptor(
  label: string,
  controlKind: ControlKind,
  options: FieldOption[] = [],
  extra: {
    maxLength?: number | null;
    datePart?: DatePart | null;
    datePrecision?: 'year' | 'month' | 'day' | null;
    datePresentValue?: string | null;
  } = {},
): FieldDescriptor {
  return {
    fieldId: `field-${label}`,
    section: 'unknown',
    sectionInstanceId: 'sec-0',
    recordInstanceId: null,
    label,
    normalizedLabel: normalizeLabel(label),
    nameHint: null,
    placeholderHint: null,
    controlKind,
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
    empty: true,
    maxLength: extra.maxLength ?? null,
    options,
    semanticFingerprint: fieldFingerprint({ section: 'unknown', label, controlKind, options, nameHint: null }),
    datePart: extra.datePart ?? null,
    datePrecision: extra.datePrecision ?? (controlKind === 'date-picker' ? 'month' : null),
    datePresentValue: extra.datePresentValue ?? null,
    degreeHint: null,
    recordIdentityHint: null,
    unsupportedReason: null,
    sensitive: false,
  };
}

function project(ref: FieldRef, target: FieldDescriptor) {
  const field = getCatalogField(ref.section, ref.field)!;
  return projectValue(readFieldValue(data, ref), target, field);
}

const masterEnd: FieldRef = { section: 'education', recordId: 'edu-demo-master', field: 'endDate' };
const masterStart: FieldRef = { section: 'education', recordId: 'edu-demo-master', field: 'startDate' };

describe('U02 日期默认值与精度', () => {
  it('只精确到月的毕业日期按约定补为 6 月 30 日', () => {
    const result = project(masterEnd, descriptor('毕业时间', 'date'));
    expect(result).toEqual({ ok: true, value: '2027-06-30' });
  });

  it('月份控件按 yyyy-mm 写入', () => {
    const result = project(masterEnd, descriptor('毕业时间', 'month'));
    expect(result).toEqual({ ok: true, value: '2027-06' });
  });

  it('分拆年/月分别得到年份与月份', () => {
    const year = project(masterStart, descriptor('入学时间', 'text', [], { datePart: { edge: 'start', unit: 'year' } }));
    expect(year).toEqual({ ok: true, value: '2024' });
    const month = project(masterStart, descriptor('入学时间', 'text', [], { datePart: { edge: 'start', unit: 'month' } }));
    expect(month).toEqual({ ok: true, value: '9' });
  });

  it('同一个日期面板表示一个年月端点时投影完整 YYYY-MM', () => {
    const result = project(masterStart, descriptor('开始时间', 'date-picker', [], {
      datePart: { edge: 'start', unit: 'month' }, datePrecision: 'month',
    }));
    expect(result).toEqual({ ok: true, value: '2024-09' });
  });

  it('教育开始时间只有年份时按约定补为 9 月', () => {
    const yearOnly = structuredClone(data);
    yearOnly.education[0]!.startDate = { year: 2024 };
    const field = getCatalogField('education', 'startDate')!;
    const value = readFieldValue(yearOnly, masterStart);
    const result = projectValue(value, descriptor('入学时间', 'select', [{ label: '9月', value: '9' }], {
      datePart: { edge: 'start', unit: 'month' },
    }), field);
    expect(result).toEqual({ ok: true, value: '9' });
  });

  it('教育起止日期只有年份时按约定补成完整日期', () => {
    const yearOnly = structuredClone(data);
    yearOnly.education[0]!.startDate = { year: 2024 };
    yearOnly.education[0]!.endDate = { year: 2027 };
    const startField = getCatalogField('education', 'startDate')!;
    const endField = getCatalogField('education', 'endDate')!;
    expect(projectValue(
      readFieldValue(yearOnly, masterStart),
      descriptor('入学日期', 'date'),
      startField,
    )).toEqual({ ok: true, value: '2024-09-01' });
    expect(projectValue(
      readFieldValue(yearOnly, masterEnd),
      descriptor('毕业日期', 'date'),
      endField,
    )).toEqual({ ok: true, value: '2027-06-30' });
  });

  it('「至今」不会被替换成今天，也不能写进日期控件', () => {
    const ref: FieldRef = { section: 'projects', recordId: 'project-demo-001', field: 'endDate' };
    const dateResult = project(ref, descriptor('结束时间', 'date'));
    expect(dateResult.ok).toBe(false);
    if (!dateResult.ok) expect(dateResult.reasonCode).toBe('REQUIRES_USER_ACTION');

    const selectResult = project(ref, descriptor('结束时间', 'select', [
      { label: '至今', value: 'present' },
      { label: '2026-03', value: '2026-03' },
    ]));
    expect(selectResult).toEqual({ ok: true, value: 'present' });
  });

  it('未来的预计毕业时间可以正常使用', () => {
    const result = project(masterEnd, descriptor('预计毕业时间', 'text'));
    expect(result).toEqual({ ok: true, value: '2027-06' });
  });
});

describe('U05 枚举匹配只接受唯一等价选项', () => {
  const degreeRef: FieldRef = { section: 'education', recordId: 'edu-demo-master', field: 'degreeLevel' };

  it('唯一等价选项被选中', () => {
    const result = project(degreeRef, descriptor('学历', 'select', [
      { label: '本科', value: 'bk' },
      { label: '硕士', value: 'ss' },
      { label: '博士', value: 'bs' },
    ]));
    expect(result).toEqual({ ok: true, value: 'ss' });
  });

  it('没有等价选项时进入待处理', () => {
    const result = project(degreeRef, descriptor('学历', 'select', [
      { label: '专科及以下', value: 'a' },
      { label: '本科及以上', value: 'b' },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe('AMBIGUOUS_OPTION');
  });

  it('多个选项都能对应时进入待处理', () => {
    const result = project(degreeRef, descriptor('学历', 'select', [
      { label: '硕士', value: 'a' },
      { label: '研究生', value: 'b' },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe('AMBIGUOUS_OPTION');
  });

  it('学历层级不会被推导成学位名称', () => {
    const result = project(degreeRef, descriptor('学位名称', 'select', [
      { label: '工学硕士', value: 'a' },
      { label: '理学硕士', value: 'b' },
    ]));
    expect(result.ok).toBe(false);
  });

  it('个人信息区可以读取最高学历学习形式与英语等级投影', () => {
    const educationType = project(
      { section: 'personal', field: 'highestEducationType' },
      descriptor('学习形式', 'combobox'),
    );
    expect(educationType).toEqual({
      ok: true,
      value: expect.arrayContaining(['全国普通高等院校全日制', '全日制统招']),
    });

    const englishLevel = project(
      { section: 'personal', field: 'englishLevel' },
      descriptor('英语等级', 'combobox'),
    );
    expect(englishLevel).toEqual({
      ok: true,
      value: expect.arrayContaining(['CET-4', '大学英语四级', '四级']),
    });
    expect(project(
      { section: 'personal', field: 'englishScore' },
      descriptor('英语等级成绩', 'text'),
    )).toEqual({ ok: true, value: '500' });
  });

  it('随时到岗可安全投影为北森提供的一周内', () => {
    const result = project(
      { section: 'preferences', field: 'availabilityText' },
      descriptor('到岗时间', 'select', [
        { label: '一周内', value: 'week' },
        { label: '一个月内', value: 'month' },
        { label: '面议', value: 'negotiable' },
      ]),
    );
    expect(result).toEqual({ ok: true, value: 'week' });
  });
});

describe('多值、布尔与长度限制', () => {
  it('多个意向城市不会被擅自选第一项', () => {
    const result = project({ section: 'preferences', field: 'preferredCities' }, descriptor('意向城市', 'select', [
      { label: '杭州', value: '杭州' },
      { label: '上海', value: '上海' },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe('REQUIRES_USER_ACTION');
  });

  it('日期选择器明确提供“至今”时可投影进行中状态', () => {
    const result = project(
      { section: 'projects', recordId: 'project-demo-001', field: 'endDate' },
      descriptor('结束时间', 'date-picker', [], {
        datePart: { edge: 'end', unit: 'month' },
        datePrecision: 'month',
        datePresentValue: '至今',
      }),
    );
    expect(result).toEqual({ ok: true, value: '至今' });
  });

  it('动态 combobox 接收全部意向城市候选，由执行器与网页选项取唯一交集', () => {
    const result = project(
      { section: 'preferences', field: 'preferredCities' },
      descriptor('意向城市', 'combobox'),
    );
    expect(result).toEqual({ ok: true, value: ['杭州', '上海'] });
  });

  it('布尔 false 能选中「否」', () => {
    const result = project({ section: 'preferences', field: 'acceptsRelocation' }, descriptor('是否接受异地', 'radio', [
      { label: '是', value: 'yes' },
      { label: '否', value: 'no' },
    ]));
    expect(result).toEqual({ ok: true, value: 'no' });
  });

  it('布尔值写入 checkbox 保持 false', () => {
    const result = project({ section: 'preferences', field: 'acceptsRelocation' }, descriptor('是否接受异地', 'checkbox'));
    expect(result).toEqual({ ok: true, value: false });
  });

  it('数字可以匹配带单位的选项', () => {
    const result = project({ section: 'preferences', field: 'internshipMonths' }, descriptor('可实习月数', 'select', [
      { label: '3个月', value: '3个月' },
      { label: '6个月', value: '6个月' },
    ]));
    expect(result).toEqual({ ok: true, value: '6个月' });
  });

  it('超过网页字数限制时不截断，报告 TEXT_TOO_LONG', () => {
    const result = project({ section: 'selfIntroduction', field: 'text' }, descriptor('自我介绍', 'textarea', [], { maxLength: 20 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe('TEXT_TOO_LONG');
  });

  it('出生日期可投影到已验证的年月选择器', () => {
    const result = project({ section: 'personal', field: 'birthDate' }, descriptor('出生日期', 'date-picker'));
    expect(result).toEqual({ ok: true, value: '2002-04' });
  });

  it('完整日期选择器保留已有日，其他月精度日期按约定补为 1 日', () => {
    const birth = project(
      { section: 'personal', field: 'birthDate' },
      descriptor('出生日期', 'date-picker', [], { datePrecision: 'day' }),
    );
    expect(birth).toEqual({ ok: true, value: '2002-04-15' });

    const award = project(
      { section: 'awards', recordId: 'award-demo-001', field: 'date' },
      descriptor('获奖时间', 'date-picker', [], { datePrecision: 'day' }),
    );
    expect(award).toEqual({ ok: true, value: '2025-11-01' });
  });

  it('只要求年份的选择器不虚构月份', () => {
    const result = project(
      { section: 'awards', recordId: 'award-demo-001', field: 'date' },
      descriptor('获奖时间', 'date-picker', [], { datePrecision: 'year' }),
    );
    expect(result).toEqual({ ok: true, value: '2025' });
  });

  it('普通 date 控件仍然需要年月日', () => {
    const result = project({ section: 'personal', field: 'birthDate' }, descriptor('出生日期', 'date'));
    expect(result).toEqual({ ok: true, value: '2002-04-15' });
  });

  it('「至今」可直接投影为经历分区的 checkbox', () => {
    const result = project(
      { section: 'projects', recordId: 'project-demo-001', field: 'endDate' },
      descriptor('至今', 'checkbox'),
    );
    expect(result).toEqual({ ok: true, value: true });
  });

  it('履历中没有的内容报告 SOURCE_MISSING', () => {
    const result = project({ section: 'personal', field: 'github' }, descriptor('GitHub', 'text'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe('SOURCE_MISSING');
  });
});
