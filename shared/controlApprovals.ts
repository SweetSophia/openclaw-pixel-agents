import { CONTROL_LIMITS, controlByteSize, controlRecord, parseControlTarget, type ControlSource, type ControlTarget } from './control';

export const APPROVAL_LIMITS = { items: 25, text: 16000, details: 12, observations: 200, lifetime: 60000, replay: 1000, events: 100, concurrent: 4, attempts: 1000, decisionsPerMinute: 10 } as const;
export type ApprovalKind = 'exec' | 'plugin' | 'system-agent';
export type ApprovalDecision = 'allow-once' | 'deny';
export interface ControlApproval {
  id: string; kind: ApprovalKind; title: string; text: string; details: string[];
  status: 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled';
  createdAtMs: number; expiresAtMs: number; resolvedAtMs?: number;
  sourceSessionKey?: string; allowedDecisions: ApprovalDecision[];
}
export interface ControlApprovalPage { target: ControlTarget; source: ControlSource; items: ControlApproval[]; truncated: boolean }
export interface ApprovalReadRequest { target: ControlTarget }
export interface ApprovalInspectRequest extends ApprovalReadRequest { id: string }
export interface ApprovalResolveRequest extends ApprovalInspectRequest { kind: ApprovalKind; decision: ApprovalDecision; observationId: string }
export interface ControlApprovalResult { target: ControlTarget; source: ControlSource; approval: ControlApproval; applied: boolean; observationId?: string }
const keys = (row: Record<string, unknown>, fields: string[]) => Object.keys(row).every(key => fields.includes(key));
const bounded = (value: unknown, max: number, opaque = false): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
  && (!opaque || (!/[\u0000-\u001f\u007f]/.test(value) && value.trim() === value));
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const isApprovalKind = (value: unknown): value is ApprovalKind => typeof value === 'string' && ['exec', 'plugin', 'system-agent'].includes(value);
export const isApprovalId = (value: unknown): value is string => bounded(value, 512, true) && value !== '.' && value !== '..'
  && !/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)
  && !/[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''));
function exactTarget(value: unknown): ControlTarget | null {
  const row = controlRecord(value);
  return row && keys(row, ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'branchId', 'activeLeafEntryId']) ? parseControlTarget(row) : null;
}
export function parseApprovalReadRequest(value: unknown): ApprovalReadRequest | null {
  const row = controlRecord(value); const target = exactTarget(row?.target);
  return row && keys(row, ['target']) && target ? { target } : null;
}
export function parseApprovalInspectRequest(value: unknown): ApprovalInspectRequest | null {
  const row = controlRecord(value); const target = exactTarget(row?.target);
  return row && keys(row, ['target', 'id']) && target && isApprovalId(row.id) ? { target, id: row.id } : null;
}
export function parseApprovalResolveRequest(value: unknown): ApprovalResolveRequest | null {
  const row = controlRecord(value); const target = exactTarget(row?.target);
  return row && keys(row, ['target', 'id', 'kind', 'decision', 'observationId']) && target && isApprovalId(row.id) && isApprovalKind(row.kind)
    && bounded(row.observationId, 128, true) && (row.decision === 'allow-once' || row.decision === 'deny')
    ? { target, id: row.id, kind: row.kind, decision: row.decision, observationId: row.observationId } : null;
}
export function parseControlApproval(value: unknown): ControlApproval | null {
  const row = controlRecord(value);
  if (!row || !keys(row, ['id', 'kind', 'title', 'text', 'details', 'status', 'createdAtMs', 'expiresAtMs', 'resolvedAtMs', 'sourceSessionKey', 'allowedDecisions'])
    || !isApprovalId(row.id) || !isApprovalKind(row.kind) || !bounded(row.title, 80) || !bounded(row.text, APPROVAL_LIMITS.text)
    || !Array.isArray(row.details) || row.details.length > APPROVAL_LIMITS.details || !row.details.every(detail => bounded(detail, APPROVAL_LIMITS.text))
    || typeof row.status !== 'string' || !['pending', 'allowed', 'denied', 'expired', 'cancelled'].includes(row.status)
    || !timestamp(row.createdAtMs) || !timestamp(row.expiresAtMs) || row.expiresAtMs < row.createdAtMs
    || (row.resolvedAtMs !== undefined && !timestamp(row.resolvedAtMs))
    || (row.sourceSessionKey !== undefined && !bounded(row.sourceSessionKey, 512, true))
    || !Array.isArray(row.allowedDecisions) || row.allowedDecisions.length > 2 || !row.allowedDecisions.every(decision => decision === 'allow-once' || decision === 'deny')
    || new Set(row.allowedDecisions).size !== row.allowedDecisions.length
    || (row.status === 'pending' && !row.allowedDecisions.includes('deny'))
    || (row.status !== 'pending' && (row.allowedDecisions.length !== 0 || row.resolvedAtMs === undefined))) return null;
  return row as unknown as ControlApproval;
}
function source(value: unknown): ControlSource | null {
  const row = controlRecord(value);
  return row && keys(row, ['state', 'observedAt']) && (row.state === 'current' || row.state === 'stale') && timestamp(row.observedAt) ? row as unknown as ControlSource : null;
}
export function parseApprovalPage(value: unknown): ControlApprovalPage | null {
  const row = controlRecord(value); const target = exactTarget(row?.target); const observed = source(row?.source);
  if (!row || !keys(row, ['target', 'source', 'items', 'truncated']) || !target || !observed || typeof row.truncated !== 'boolean'
    || controlByteSize(row) > CONTROL_LIMITS.responseBytes || !Array.isArray(row.items) || row.items.length > APPROVAL_LIMITS.items) return null;
  const items = row.items.map(parseControlApproval);
  return items.every((item): item is ControlApproval => item !== null) && new Set(items.map(item => item.id)).size === items.length
    ? { target, source: observed, items, truncated: row.truncated } : null;
}
export function parseApprovalResult(value: unknown): ControlApprovalResult | null {
  const row = controlRecord(value); const target = exactTarget(row?.target); const observed = source(row?.source); const approval = parseControlApproval(row?.approval);
  return row && keys(row, ['target', 'source', 'approval', 'applied', 'observationId']) && controlByteSize(row) <= CONTROL_LIMITS.responseBytes && target && observed && approval && typeof row.applied === 'boolean'
    && (row.observationId === undefined || (bounded(row.observationId, 128, true) && approval.status === 'pending' && !row.applied && observed.state === 'current'))
    && (!row.applied || approval.status !== 'pending') ? { target, source: observed, approval, applied: row.applied, ...(row.observationId === undefined ? {} : { observationId: row.observationId as string }) } : null;
}
