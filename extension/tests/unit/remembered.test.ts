import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ScanResult } from '../../src/shared/protocol';
import { planRun, REMEMBERED_FIELD } from '../../src/background/planner';
import { findRemembered, recordKeyOf } from '../../src/background/remembered';
import { fieldFingerprint, formFingerprint } from '../../src/shared/fingerprints';
import { normalizeLabel } from '../../src/shared/normalize';
import type { ControlKind, FieldDescriptor, ProfileFile, RememberedAnswer } from '../../src/shared/types';

/** jobprep：记住你手动补填的内容，下次同名字段自动填 */

const root = path.resolve(__dirname, '../..');
const demoProfile = JSON.parse(readFileSync(path.join(root, 'fixtures/profile.demo.json'), 'utf8')) as ProfileFile;

function descriptor(o: {
  fieldId: string;
  label: string;
  section: FieldDescriptor['section'];
  controlKind?: ControlKind;
  recordInstanceId?: string | null;
  datePart?: FieldDescriptor['datePart'];
  sensitive?: boolean;
}): FieldDescriptor {
  const controlKind = o.controlKind ?? 'text';
  return {
    fieldId: o.fieldId, section: o.section, sectionInstanceId: 'sec-0', recordInstanceId: o.recordInstanceId ?? null,
    label: o.label, normalizedLabel: normalizeLabel(o.label), nameHint: null, placeholderHint: null, controlKind,
    required: false, disabled: false, readOnly: false, visible: true, empty: true, maxLength: null, options: [],
    semanticFingerprint: fieldFingerprint({ section: o.section, label: normalizeLabel(o.label), controlKind, options: [], nameHint: null }),
    datePart: o.datePart ?? null, datePrecision: null, datePresentValue: null, degreeHint: null, recordIdentityHint: null,
    unsupportedReason: null, sensitive: o.sensitive ?? false,
  };
}

function scanOf(descriptors: FieldDescriptor[], over: Partial<ScanResult> = {}): ScanResult {
  return {
    routeKey: '/apply', origin: 'https://example.jobs.feishu.cn', pageTitle: '申请', descriptors, recordInstances: [],
    addActions: [], adapterBindings: [], orderFallbackSections: [], jobCandidate: null, adapterId: 'generic',
    truncated: false, truncationReason: null, formFingerprint: formFingerprint(descriptors), ...over,
  };
}

function remembered(label: string, value: string, section: RememberedAnswer['section'], recordKey: string | null = null): RememberedAnswer {
  return { id: `r-${label}-${recordKey}`, section, label: normalizeLabel(label), displayLabel: label, recordKey: recordKeyOf(recordKey), value, savedAt: '2026-09-28T00:00:00Z', origin: 'x' };
}

const EDU = {
  recordInstances: [
    { section: 'education' as const, sectionInstanceId: 'sec-0', recordInstanceId: 'edu-0', degreeHint: 'master' as const, identityHint: null, order: 0 },
    { section: 'education' as const, sectionInstanceId: 'sec-0', recordInstanceId: 'edu-1', degreeHint: 'bachelor' as const, identityHint: null, order: 1 },
  ],
};

describe('记住的补填内容', () => {
  it('履历里没有的个人字段：用记住的值，来源标成「你上次手动补填的」', () => {
    const scan = scanOf([descriptor({ fieldId: 'marry', label: '婚姻状况', section: 'personal', controlKind: 'combobox' })]);
    const plan = planRun({ scan, profile: demoProfile, rules: [], remembered: [remembered('婚姻状况', '未婚', 'personal')] });
    const action = plan.actions.find((a) => a.fieldId === 'marry');
    expect(action?.value).toEqual(['未婚']);
    expect(action?.source.field).toBe(REMEMBERED_FIELD);
  });

  it('没记住过就照旧待处理，不会乱填', () => {
    const scan = scanOf([descriptor({ fieldId: 'marry', label: '婚姻状况', section: 'personal', controlKind: 'combobox' })]);
    const plan = planRun({ scan, profile: demoProfile, rules: [], remembered: [] });
    expect(plan.actions.find((a) => a.fieldId === 'marry')).toBeUndefined();
    expect(plan.results.find((r) => r.fieldId === 'marry')?.outcome).toBe('pending');
  });

  it('经历类字段只填到同一段经历：「毕业论文题目」记在示例理工大学下，示例工程学院那张卡片不填', () => {
    const scan = scanOf([
      descriptor({ fieldId: 'm-school', label: '学校', section: 'education', recordInstanceId: 'edu-0' }),
      descriptor({ fieldId: 'm-type', label: '毕业论文题目', section: 'education', recordInstanceId: 'edu-0' }),
      descriptor({ fieldId: 'b-school', label: '学校', section: 'education', recordInstanceId: 'edu-1' }),
      descriptor({ fieldId: 'b-type', label: '毕业论文题目', section: 'education', recordInstanceId: 'edu-1' }),
    ], EDU);
    const plan = planRun({ scan, profile: demoProfile, rules: [], remembered: [remembered('毕业论文题目', '示例检索系统研究', 'education', '示例理工大学')] });
    const byId = new Map(plan.actions.map((a) => [a.fieldId, a]));
    expect(byId.get('m-type')?.value).toBe('示例检索系统研究');
    expect(byId.get('m-type')?.source.field).toBe(REMEMBERED_FIELD);
    expect(byId.get('m-type')?.source.recordId).toBeTruthy();
    expect(byId.get('b-type')).toBeUndefined();
  });

  it('履历里有的值优先，记住的内容不覆盖履历', () => {
    const scan = scanOf([descriptor({ fieldId: 'name', label: '姓名', section: 'personal' })]);
    const plan = planRun({ scan, profile: demoProfile, rules: [], remembered: [remembered('姓名', '别的名字', 'personal')] });
    const action = plan.actions.find((a) => a.fieldId === 'name');
    expect(action?.value).toBe('林示例');
    expect(action?.source.field).not.toBe(REMEMBERED_FIELD);
  });

  it('证件号、日期永远不用记住的值；你勾选记住的敏感字段（婚姻状况）可以用', () => {
    const scan = scanOf([
      descriptor({ fieldId: 'id', label: '身份证号', section: 'personal', sensitive: true }),
      descriptor({ fieldId: 'marry', label: '婚姻状况', section: 'personal', controlKind: 'combobox', sensitive: true }),
      descriptor({ fieldId: 'd', label: '毕业时间', section: 'personal', datePart: { edge: 'end', unit: 'month' } }),
    ]);
    const plan = planRun({
      scan, profile: demoProfile, rules: [],
      remembered: [remembered('身份证号', '110101200001010000', 'personal'), remembered('毕业时间', '2027-06', 'personal'), remembered('婚姻状况', '未婚', 'personal')],
    });
    expect(plan.actions.filter((a) => a.source.field === REMEMBERED_FIELD).map((a) => a.fieldId)).toEqual(['marry']);
  });

  it('查找按字段名 + 所属经历，名字写法不同也能对上（规范化）', () => {
    const list = [remembered('婚姻状况：', '未婚', 'personal')];
    expect(findRemembered(list, 'personal', '婚姻状况', null)?.value).toBe('未婚');
    expect(findRemembered(list, 'education', '婚姻状况', null)).toBeNull();
  });
});
