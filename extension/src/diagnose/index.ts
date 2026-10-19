import demoProfile from '../../fixtures/profile.demo.json';
import { planRun } from '../background/planner';
import { selectAdapter } from '../content/adapters/registry';
import { scanPage } from '../content/scanner';
import { buildRouteKey } from '../shared/urls';
import type { ProfileFile } from '../shared/types';

/**
 * 兼容性诊断包：在任意招聘页面的控制台里运行真实的扫描与匹配代码，
 * 输出一份**不含任何已填内容**的结构报告，用来判断哪里识别不了、为什么。
 *
 * 它只读取 DOM，不写入任何字段，也不与扩展或网络通信。
 */

interface DiagnoseField {
  fieldId: string;
  label: string;
  section: string;
  recordInstanceId: string | null;
  controlKind: string;
  componentId: string | null;
  required: boolean;
  /** 页面上这个字段当前是否为空（只报布尔，不报内容）。 */
  empty: boolean;
  datePart: string | null;
  options: string[];
  optionCount: number;
  unsupportedReason: string | null;
  outcome: 'would-fill' | 'pending';
  reasonCode: string | null;
  source: string | null;
}

export interface DiagnoseReport {
  routeKey: string;
  origin: string;
  adapterId: string | null;
  truncated: boolean;
  truncationReason: string | null;
  diagnostics: string[];
  formFingerprint: string;
  jobCandidate: { company: string | null; role: string | null; externalJobId: string | null } | null;
  sections: Array<{ section: string; sectionInstanceId: string }>;
  records: Array<{
    section: string;
    recordInstanceId: string;
    degreeHint: string | null;
    /** 只报「页面上这条经历是否已有名称」，不报名称本身。 */
    hasIdentity: boolean;
    order: number;
  }>;
  addActions: Array<{ section: string; label: string }>;
  summary: { total: number; wouldFill: number; pending: number };
  pendingByReason: Record<string, number>;
  fields: DiagnoseField[];
}

/** 生成诊断报告。可传入自己的履历文件；不传则使用附带的虚构样例。 */
export function diagnose(profileInput?: unknown): DiagnoseReport {
  const profile = (profileInput ?? demoProfile) as ProfileFile;
  const selection = selectAdapter({
    origin: location.origin,
    pathname: location.pathname,
    document,
  });
  const output = scanPage({
    adapter: selection.adapter,
    adapterFallbackReason: selection.reason,
    document,
  });
  const scan = output.result;
  const plan = planRun({ scan, profile, rules: [] });

  const actionById = new Map(plan.actions.map((action) => [action.fieldId, action]));
  const resultById = new Map(plan.results.map((result) => [result.fieldId, result]));

  const fields: DiagnoseField[] = scan.descriptors.map((descriptor) => {
    const action = actionById.get(descriptor.fieldId);
    const result = resultById.get(descriptor.fieldId);
    return {
      fieldId: descriptor.fieldId,
      label: descriptor.label,
      section: descriptor.section,
      recordInstanceId: descriptor.recordInstanceId,
      controlKind: descriptor.controlKind,
      componentId: output.entries.get(descriptor.fieldId)?.component?.id ?? null,
      required: descriptor.required,
      empty: descriptor.empty,
      datePart: descriptor.datePart ? `${descriptor.datePart.edge}/${descriptor.datePart.unit}` : null,
      options: descriptor.options.slice(0, 12).map((option) => option.label),
      optionCount: descriptor.options.length,
      unsupportedReason: descriptor.unsupportedReason,
      outcome: action ? 'would-fill' : 'pending',
      reasonCode: result?.reasonCode ?? null,
      source: action ? `${action.source.section}.${action.source.field}` : null,
    };
  });

  const pendingByReason: Record<string, number> = {};
  for (const field of fields) {
    if (field.outcome === 'would-fill' || !field.reasonCode) continue;
    pendingByReason[field.reasonCode] = (pendingByReason[field.reasonCode] ?? 0) + 1;
  }

  return {
    routeKey: buildRouteKey(location.href),
    origin: location.origin,
    adapterId: scan.adapterId,
    truncated: scan.truncated,
    truncationReason: scan.truncationReason,
    diagnostics: scan.diagnostics ?? [],
    formFingerprint: scan.formFingerprint,
    jobCandidate: scan.jobCandidate
      ? {
          company: scan.jobCandidate.company,
          role: scan.jobCandidate.role,
          externalJobId: scan.jobCandidate.externalJobId,
        }
      : null,
    sections: [
      ...new Map(
        scan.descriptors.map((descriptor) => [
          descriptor.sectionInstanceId,
          { section: descriptor.section, sectionInstanceId: descriptor.sectionInstanceId },
        ]),
      ).values(),
    ],
    records: scan.recordInstances.map((instance) => ({
      section: instance.section,
      recordInstanceId: instance.recordInstanceId,
      degreeHint: instance.degreeHint,
      hasIdentity: instance.identityHint !== null,
      order: instance.order,
    })),
    addActions: scan.addActions.map((action) => ({ section: action.section, label: action.label })),
    summary: {
      total: fields.length,
      wouldFill: fields.filter((field) => field.outcome === 'would-fill').length,
      pending: fields.filter((field) => field.outcome === 'pending').length,
    },
    pendingByReason,
    fields,
  };
}

declare global {
  interface Window {
    __applykitDiagnose?: (profileInput?: unknown) => DiagnoseReport;
  }
}

window.__applykitDiagnose = diagnose;
