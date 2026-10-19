import type { ControlKind, FieldDescriptor, FieldOption, SectionKind } from './types';
import { normalizeLabel } from './normalize';

/**
 * fingerprint 由稳定的分区、标签、控件类型与选项集合计算，
 * 忽略已填写的值、随机 DOM ID 与重复行数量。
 */

function hashString(input: string): string {
  // FNV-1a 32 位；仅用于本地结构比对，不承担安全用途。
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function optionSignature(options: FieldOption[]): string {
  return options
    .map((option) => normalizeLabel(option.label).toLowerCase())
    .filter((label) => label.length > 0)
    .sort()
    .join('|');
}

export interface FieldFingerprintInput {
  section: SectionKind;
  label: string;
  controlKind: ControlKind;
  options: FieldOption[];
  nameHint: string | null;
}

/** 单个字段的语义指纹。name 提示只在非随机时参与。 */
export function fieldFingerprint(input: FieldFingerprintInput): string {
  const stableName = input.nameHint && !/\d{4,}|[0-9a-f]{8,}/i.test(input.nameHint)
    ? input.nameHint.toLowerCase()
    : '';
  const material = [
    input.section,
    normalizeLabel(input.label).toLowerCase(),
    input.controlKind,
    stableName,
    optionSignature(input.options),
  ].join('§');
  return `f1:${hashString(material)}`;
}

/** 表单整体结构指纹：忽略重复行数量，只取分区与字段模板。 */
export function formFingerprint(descriptors: FieldDescriptor[]): string {
  const templates = new Set<string>();
  for (const descriptor of descriptors) {
    templates.add([
      descriptor.section,
      descriptor.normalizedLabel.toLowerCase(),
      descriptor.controlKind,
      optionSignature(descriptor.options),
    ].join('§'));
  }
  const material = [...templates].sort().join('¶');
  return `s1:${hashString(material)}`;
}
