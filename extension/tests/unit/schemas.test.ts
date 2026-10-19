import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  applicationsFileSchema, MAX_IMPORT_BYTES, parseImportText, profileFileSchema, partialDateSchema,
} from '../../src/shared/schemas';
import { readFieldValue } from '../../src/shared/field-catalog';
import type { ProfileFile } from '../../src/shared/types';

const root = path.resolve(__dirname, '../..');
const readFixture = (name: string) => readFileSync(path.join(root, 'fixtures', name), 'utf8');

const demoProfile = JSON.parse(readFixture('profile.demo.json')) as ProfileFile;

describe('U09 schema、导入版本与大小错误', () => {
  it('附带的虚构样例是合法实例', () => {
    expect(profileFileSchema.safeParse(demoProfile).success).toBe(true);
    expect(applicationsFileSchema.safeParse(JSON.parse(readFixture('applications.demo.json'))).success).toBe(true);
  });

  it('把投递记录文件送进履历入口会被拒绝并说明实际类型', () => {
    const result = parseImportText(readFixture('invalid/profile.wrong-kind.json'), 'applykit-profile');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe('kind');
      expect(result.errors[0]?.message).toContain('applykit-applications');
    }
  });

  it('未知 schemaVersion 被拒绝', () => {
    const result = parseImportText(readFixture('invalid/profile.future-version.json'), 'applykit-profile');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((issue) => issue.message.includes('schemaVersion'))).toBe(true);
    }
  });

  it('不存在的日期给出具体路径', () => {
    const result = parseImportText(readFixture('invalid/profile.bad-date.json'), 'applykit-profile');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toContain('birthDate.day');
    }
  });

  it('有日没有月被拒绝', () => {
    const result = parseImportText(readFixture('invalid/profile.day-without-month.json'), 'applykit-profile');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain('月');
  });

  it('非 http/https 链接被拒绝', () => {
    const result = parseImportText(readFixture('invalid/profile.bad-url.json'), 'applykit-profile');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toContain('homepage');
  });

  it('超过 2 MiB 的文件被拒绝', () => {
    const huge = JSON.stringify({ kind: 'applykit-profile', filler: 'x'.repeat(MAX_IMPORT_BYTES + 10) });
    const result = parseImportText(huge, 'applykit-profile');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain('2 MiB');
  });

  it('applied 状态缺少证据时不通过校验', () => {
    const result = parseImportText(
      readFixture('invalid/applications.applied-without-evidence.json'),
      'applykit-applications',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((issue) => issue.path.includes('appliedAt'))).toBe(true);
      expect(result.errors.some((issue) => issue.path.includes('submissionEvidence'))).toBe(true);
    }
  });
});

describe('U02 日期精度与闰年', () => {
  it('闰年 2 月 29 日合法，平年不合法', () => {
    expect(partialDateSchema.safeParse({ year: 2024, month: 2, day: 29 }).success).toBe(true);
    expect(partialDateSchema.safeParse({ year: 2025, month: 2, day: 29 }).success).toBe(false);
  });

  it('只有年份也是合法的结构化日期', () => {
    expect(partialDateSchema.safeParse({ year: 2024 }).success).toBe(true);
  });
});

describe('U01 布尔 false、数字 0 与 null', () => {
  const data = demoProfile.data;

  it('false 是有效值，不是缺失', () => {
    const value = readFieldValue(data, { section: 'preferences', field: 'acceptsRelocation' });
    expect(value).toEqual({ kind: 'boolean', value: false });
  });

  it('数字 0 是有效值', () => {
    const zeroed = structuredClone(data);
    zeroed.preferences.internshipMonths = 0;
    expect(readFieldValue(zeroed, { section: 'preferences', field: 'internshipMonths' }))
      .toEqual({ kind: 'number', value: 0 });
  });

  it('null 是缺失', () => {
    expect(readFieldValue(data, { section: 'personal', field: 'github' })).toEqual({ kind: 'missing' });
  });

  it('空数组是缺失', () => {
    const empty = structuredClone(data);
    empty.preferences.targetRoles = [];
    expect(readFieldValue(empty, { section: 'preferences', field: 'targetRoles' })).toEqual({ kind: 'missing' });
  });

  it('在读状态与默认实习可提供工作经验和最近公司，不编造新事实', () => {
    const derived = structuredClone(data);
    derived.personal.workExperience = null;
    derived.personal.recentCompany = null;
    derived.workExperiences = [];
    expect(readFieldValue(derived, { section: 'personal', field: 'workExperience' }))
      .toEqual({ kind: 'text', value: '在校生' });
    expect(readFieldValue(derived, { section: 'personal', field: 'recentCompany' }))
      .toEqual({ kind: 'text', value: derived.internships[0]!.company });
  });
});
