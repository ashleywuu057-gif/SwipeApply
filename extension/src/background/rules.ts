import type { AppState, ControlKind, FieldDescriptor, SavedMapping, SectionKind } from '../shared/types';
import { getCatalogField } from '../shared/field-catalog';

/** 用户修正规则：只保存映射关系，不保存当时的值。 */

export interface RuleScope {
  origin: string;
  routeKey: string;
  formFingerprint: string;
}

/** 命中前仍需检查页面归属、字段唯一性、控件类型、分区与选项。 */
export function applicableRules(state: AppState, scope: RuleScope, descriptors: FieldDescriptor[]): SavedMapping[] {
  const fingerprintCount = new Map<string, number>();
  for (const descriptor of descriptors) {
    fingerprintCount.set(descriptor.semanticFingerprint, (fingerprintCount.get(descriptor.semanticFingerprint) ?? 0) + 1);
  }
  return state.mappings.filter((rule) => {
    if (rule.origin !== scope.origin) return false;
    if (rule.routeKey !== scope.routeKey) return false;
    if (rule.formFingerprint !== scope.formFingerprint) return false;
    if (!getCatalogField(rule.section, rule.sourceField)) return false;
    // 结构变化导致指纹不存在或不唯一时失效，不能只凭域名复用。
    return fingerprintCount.get(rule.fieldFingerprint) === 1;
  });
}

export interface SaveMappingInput {
  scope: RuleScope;
  section: SectionKind;
  fieldLabel: string;
  controlKind: ControlKind;
  fieldFingerprint: string;
  sourceField: string;
  recordSelector: SavedMapping['recordSelector'];
}

/** 先实际填写并通过回读验证，再写入规则；失败的映射不保存。 */
export function upsertMapping(state: AppState, input: SaveMappingInput, now: string): { state: AppState; mapping: SavedMapping } {
  const existing = state.mappings.find(
    (rule) =>
      rule.origin === input.scope.origin &&
      rule.routeKey === input.scope.routeKey &&
      rule.formFingerprint === input.scope.formFingerprint &&
      rule.fieldFingerprint === input.fieldFingerprint,
  );

  const mapping: SavedMapping = {
    id: existing?.id ?? `mapping-${crypto.randomUUID()}`,
    origin: input.scope.origin,
    routeKey: input.scope.routeKey,
    formFingerprint: input.scope.formFingerprint,
    section: input.section,
    fieldLabel: input.fieldLabel,
    controlKind: input.controlKind,
    fieldFingerprint: input.fieldFingerprint,
    sourceField: input.sourceField,
    recordSelector: input.recordSelector,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastVerifiedAt: now,
  };

  const mappings = existing
    ? state.mappings.map((rule) => (rule.id === existing.id ? mapping : rule))
    : [...state.mappings, mapping];
  return { state: { ...state, mappings }, mapping };
}

export function deleteMapping(state: AppState, mappingId: string): AppState {
  return { ...state, mappings: state.mappings.filter((rule) => rule.id !== mappingId) };
}
