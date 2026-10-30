import { CONTROL_LIMITS, controlByteSize, controlRecord, parseControlTarget, type ControlTarget } from './control';

export const CONTROL_MODEL_LIMITS = {
  choices: 500, modelId: 512, label: 128, selectionId: 128, observations: 100,
  lifetime: 60000, concurrentReads: 4, appliesPerMinute: 10, attempts: 1000,
} as const;
export interface ControlModelChoice { id: string; label: string; selectable: boolean; available: boolean | null }
export type ControlModelDisabledReason = 'busy' | 'activity-unknown' | 'read-only' | 'permission' | 'selection-unknown' | 'unsupported' | null;
export interface ControlModelSnapshot {
  target: ControlTarget; selectionId: string; observedAt: number; currentModel: string | null;
  choices: ControlModelChoice[]; canChange: boolean; disabledReason: ControlModelDisabledReason;
}
export interface ControlModelReadRequest { target: ControlTarget }
export interface ControlModelSelection extends ControlModelReadRequest { selectionId: string; model: string | null }
export interface ControlModelOutcome { target: ControlTarget; outcome: 'confirmed' | 'unknown'; snapshot?: ControlModelSnapshot }

const keys = (row: Record<string, unknown>, fields: readonly string[]) => Object.keys(row).every(key => fields.includes(key));
const safeText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)
  && !/[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''));
function hasNativeProfileSelector(model: string): boolean {
  // OpenClaw 2026.10.3 model-ref-profile: date then quantization suffixes
  // are model identity; any following nonempty suffix selects credentials.
  let delimiter = model.indexOf('@', model.lastIndexOf('/') + 1);
  if (delimiter <= 0) return false;
  for (const suffix of [/^\d{8}(?:@|$)/, /^(?:i?q\d+(?:_[a-z0-9]+)*|\d+bit)(?:@|$)/i]) {
    if (!suffix.test(model.slice(delimiter + 1))) continue;
    const next = model.indexOf('@', delimiter + 1);
    if (next < 0) return false;
    delimiter = next;
  }
  return model.slice(0, delimiter).trim().length > 0 && model.slice(delimiter + 1).trim().length > 0;
}
export const isControlModelId = (value: unknown): value is string => safeText(value, CONTROL_MODEL_LIMITS.modelId) && !hasNativeProfileSelector(value);
export function parseModelTarget(value: unknown): ControlTarget | null {
  const row = controlRecord(value);
  if (!row || !keys(row, ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'branchId', 'activeLeafEntryId'])
    || !Object.values(row).every(field => field === undefined || safeText(field, 512))) return null;
  return parseControlTarget(row);
}
// Appending a transcript leaf changes pagination, not conversation ownership.
export const modelTargetIdentity = (target: ControlTarget): string => JSON.stringify([
  target.agentId, target.sessionKey, target.sessionId, target.lifecycleRevision ?? null, target.branchId ?? null,
]);
export function parseControlModelReadRequest(value: unknown): ControlModelReadRequest | null {
  const row = controlRecord(value); const target = parseModelTarget(row?.target);
  return row && keys(row, ['target']) && target ? { target } : null;
}
export function parseControlModelSelection(value: unknown): ControlModelSelection | null {
  const row = controlRecord(value); const target = parseModelTarget(row?.target);
  return row && keys(row, ['target', 'selectionId', 'model']) && target && safeText(row.selectionId, CONTROL_MODEL_LIMITS.selectionId)
    && (row.model === null || isControlModelId(row.model)) ? { target, selectionId: row.selectionId, model: row.model } : null;
}
export function parseControlModelChoice(value: unknown): ControlModelChoice | null {
  const row = controlRecord(value);
  return row && keys(row, ['id', 'label', 'selectable', 'available']) && isControlModelId(row.id) && safeText(row.label, CONTROL_MODEL_LIMITS.label)
    && typeof row.selectable === 'boolean' && (typeof row.available === 'boolean' || row.available === null)
    ? { id: row.id, label: row.label, selectable: row.selectable, available: row.available } : null;
}
export function parseControlModelSnapshot(value: unknown): ControlModelSnapshot | null {
  const row = controlRecord(value); const target = parseModelTarget(row?.target);
  if (!row || !target || !keys(row, ['target', 'selectionId', 'observedAt', 'currentModel', 'choices', 'canChange', 'disabledReason'])
    || controlByteSize(row) > CONTROL_LIMITS.responseBytes || !safeText(row.selectionId, CONTROL_MODEL_LIMITS.selectionId)
    || !Number.isSafeInteger(row.observedAt) || (row.observedAt as number) < 0 || !(row.currentModel === null || isControlModelId(row.currentModel))
    || typeof row.canChange !== 'boolean' || ![null, 'busy', 'activity-unknown', 'read-only', 'permission', 'selection-unknown', 'unsupported'].includes(row.disabledReason as string | null)
    || row.canChange !== (row.disabledReason === null) || (row.canChange && row.currentModel === null)
    || !Array.isArray(row.choices) || row.choices.length > CONTROL_MODEL_LIMITS.choices) return null;
  const choices = row.choices.map(parseControlModelChoice);
  if (!choices.every((choice): choice is ControlModelChoice => choice !== null) || new Set(choices.map(choice => choice.id)).size !== choices.length) return null;
  return { target, selectionId: row.selectionId, observedAt: row.observedAt as number, currentModel: row.currentModel,
    choices, canChange: row.canChange, disabledReason: row.disabledReason as ControlModelDisabledReason };
}
export function parseControlModelOutcome(value: unknown): ControlModelOutcome | null {
  const row = controlRecord(value); const target = parseModelTarget(row?.target);
  if (!row || !target || !keys(row, ['target', 'outcome', 'snapshot']) || controlByteSize(row) > CONTROL_LIMITS.responseBytes
    || (row.outcome !== 'confirmed' && row.outcome !== 'unknown')) return null;
  const snapshot = row.snapshot === undefined ? undefined : parseControlModelSnapshot(row.snapshot);
  if (snapshot === null || (row.outcome === 'confirmed' && !snapshot)
    || (snapshot && modelTargetIdentity(snapshot.target) !== modelTargetIdentity(target))) return null;
  return { target, outcome: row.outcome, ...(snapshot ? { snapshot } : {}) };
}
