import { CONTROL_LIMITS, controlByteSize, controlRecord, isControlAgentId, type ControlGatewayState, type ControlSource } from './control';

export type ScheduleTiming = { kind: 'every'; everyMs: number } | { kind: 'cron'; expr: string; tz: string };
export interface ScheduleDraft { name: string; message: string; schedule: ScheduleTiming }
export type ScheduleIntent = { kind: 'create'; draft: ScheduleDraft }
  | { kind: 'edit'; jobId: string; revision: string; draft: ScheduleDraft }
  | { kind: 'enabled'; jobId: string; revision: string; enabled: boolean };
export interface ScheduleConfirmation { operationId: string; agentId: string; intent: ScheduleIntent; expiresAt: number; epoch: string; currentEnabled: boolean | null }
export interface ScheduleSubmit { operationId: string; intent: ScheduleIntent }
export interface ScheduleRow {
  id: string; agentId: string; name: string; enabled: boolean; revision: string | null;
  scheduleKind: string; draft: ScheduleDraft | null; readOnlyReason: string | null;
  timingMetadata?: { anchorMs?: number; staggerMs?: number };
  nextRunAt?: number; lastRunAt?: number; lastRunStatus?: string;
}
export interface ScheduleOperation {
  operationId: string; agentId: string; action: ScheduleIntent['kind'];
  state: 'confirmed' | 'observed' | 'changed' | 'unknown' | 'not-sent'; jobId?: string;
  recovery?: { scanned: number; truncated: boolean; nextCursor?: string };
}
export interface ScheduleOperationsPage { agentId: string; operations: ScheduleOperation[]; nextCursor?: string }
export interface ScheduleManagement { configured: boolean; state: ControlGatewayState; canManage: boolean; epoch: string | null; reason: string | null }
export interface ScheduleSnapshot {
  agentId: string; source: ControlSource; management: ScheduleManagement; jobs: ScheduleRow[];
  operations: ScheduleOperation[]; operationsCursor?: string; operationsError?: 'storage-unavailable'; scanned: number; truncated: boolean; nextCursor?: string;
}

const INVALID = Symbol('invalid-schedule-field');
type Field = (value: unknown) => unknown;
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const malformedUnicode = /[\ud800-\udfff]/u;
function object<T>(value: unknown, shape: Record<string, Field>): T | null {
  const input = controlRecord(value);
  if (!input || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(shape, key))
    || controlByteSize(input) > CONTROL_LIMITS.responseBytes) return null;
  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    const parsed = field(input[key]);
    if (parsed === INVALID) return null;
    if (parsed !== undefined) output[key] = parsed;
  }
  return output as T;
}
const optional = (field: Field): Field => value => value === undefined ? undefined : field(value);
const nullable = (field: Field): Field => value => value === null ? null : field(value);
const child = <T>(parse: (value: unknown) => T | null): Field => value => parse(value) ?? INVALID;
const oneOf = (values: readonly string[]): Field => value => typeof value === 'string' && values.includes(value) ? value : INVALID;
const bool: Field = value => typeof value === 'boolean' ? value : INVALID;
const integer: Field = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : INVALID;
const timestamp: Field = value => integer(value) !== INVALID && (value as number) <= 8640000000000000 ? value : INVALID;
const agentId: Field = value => isControlAgentId(value) ? value : INVALID;
const text = (max: number): Field => value => typeof value === 'string' && value.length <= max && value.trim().length > 0
  && !controls.test(value) && !malformedUnicode.test(value) ? value : INVALID;
const name: Field = value => text(128)(value) === INVALID ? INVALID : (value as string).trim();
const uuid: Field = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : INVALID;
const message: Field = value => typeof value === 'string' && value.trim().length > 0 && !malformedUnicode.test(value)
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)
  && new TextEncoder().encode(value).byteLength <= 16384 ? value : INVALID;
function list<T>(parse: (value: unknown) => T | null, max: number): Field {
  return value => {
    if (!Array.isArray(value) || value.length > max) return INVALID;
    const result: T[] = [];
    for (const item of value) { const parsed = parse(item); if (!parsed) return INVALID; result.push(parsed); }
    return result;
  };
}
function parseTiming(value: unknown): ScheduleTiming | null {
  const input = controlRecord(value);
  if (input?.kind === 'every') return object(value, {
    kind: oneOf(['every']), everyMs: value => integer(value) !== INVALID && (value as number) >= 60000 && (value as number) <= 31536000000 ? value : INVALID,
  });
  if (input?.kind !== 'cron') return null;
  return object(value, {
    kind: oneOf(['cron']), expr: value => text(128)(value) !== INVALID && (value as string).trim().split(/\s+/).length === 5 ? value : INVALID,
    tz: value => {
      if (text(128)(value) === INVALID || !/^[A-Za-z][A-Za-z0-9_+\/-]*$/.test(value as string)) return INVALID;
      try { new Intl.DateTimeFormat('en', { timeZone: value as string }); return value; } catch { return INVALID; }
    },
  });
}
export function parseScheduleDraft(value: unknown): ScheduleDraft | null {
  return object(value, { name, message, schedule: child(parseTiming) });
}
export function parseScheduleIntent(value: unknown): ScheduleIntent | null {
  const input = controlRecord(value);
  if (input?.kind === 'create') return object(value, { kind: oneOf(['create']), draft: child(parseScheduleDraft) });
  const identity = { jobId: text(200), revision: text(128) };
  if (input?.kind === 'edit') return object(value, { kind: oneOf(['edit']), ...identity, draft: child(parseScheduleDraft) });
  if (input?.kind === 'enabled') return object(value, { kind: oneOf(['enabled']), ...identity, enabled: bool });
  return null;
}
export function parseScheduleConfirmation(value: unknown): ScheduleConfirmation | null {
  const confirmation = object<ScheduleConfirmation>(value, {
    operationId: uuid, agentId, intent: child(parseScheduleIntent), expiresAt: timestamp, epoch: text(128), currentEnabled: nullable(bool),
  });
  return confirmation && (confirmation.intent.kind === 'create' ? confirmation.currentEnabled === null : typeof confirmation.currentEnabled === 'boolean') ? confirmation : null;
}
export function parseScheduleSubmit(value: unknown): ScheduleSubmit | null {
  return object(value, { operationId: uuid, intent: child(parseScheduleIntent) });
}
export function parseScheduleOperation(value: unknown): ScheduleOperation | null {
  return object(value, {
    operationId: uuid, agentId, action: oneOf(['create', 'edit', 'enabled']),
    state: oneOf(['confirmed', 'observed', 'changed', 'unknown', 'not-sent']), jobId: optional(text(200)),
    recovery: optional(child(value => {
      const recovery = object<NonNullable<ScheduleOperation['recovery']>>(value, {
        scanned: value => integer(value) !== INVALID && (value as number) <= 2000 ? value : INVALID,
        truncated: bool, nextCursor: optional(text(2048)),
      });
      return recovery && (!recovery.nextCursor || (recovery.truncated && recovery.scanned > 0 && recovery.scanned < 2000)) ? recovery : null;
    })),
  });
}
export function parseScheduleOperationsPage(value: unknown): ScheduleOperationsPage | null {
  const page = object<ScheduleOperationsPage>(value, { agentId, operations: list(parseScheduleOperation, 50), nextCursor: optional(text(2048)) });
  return page && page.operations.every(operation => operation.agentId === page.agentId)
    && (!page.nextCursor || page.operations.length > 0) ? page : null;
}
function parseRow(value: unknown): ScheduleRow | null {
  const row = object<ScheduleRow>(value, {
    id: text(200), agentId, name, enabled: bool, revision: nullable(text(128)), scheduleKind: text(128), draft: nullable(child(parseScheduleDraft)),
    readOnlyReason: nullable(oneOf(['unsupported-definition', 'system-owned', 'revision-unavailable', 'bounds'])),
    timingMetadata: optional(child(value => object(value, { anchorMs: optional(integer), staggerMs: optional(integer) }))),
    nextRunAt: optional(timestamp), lastRunAt: optional(timestamp), lastRunStatus: optional(oneOf(['ok', 'error', 'skipped'])),
  });
  if (!row || (row.readOnlyReason === null ? !row.draft || !row.revision || row.scheduleKind !== row.draft.schedule.kind : row.draft !== null)) return null;
  return row;
}
function parseManagement(value: unknown): ScheduleManagement | null {
  const management = object<ScheduleManagement>(value, {
    configured: bool, state: oneOf(['disabled', 'connecting', 'ready', 'pairing-required', 'auth-error', 'unsupported', 'unavailable']),
    canManage: bool, epoch: nullable(text(128)),
    reason: nullable(oneOf(['disabled', 'reader-unavailable', 'pairing-required', 'permission', 'unsupported', 'storage-unavailable', 'unavailable'])),
  });
  if (!management || (management.canManage && (!management.configured || management.state !== 'ready' || !management.epoch || management.reason !== null))
    || (!management.configured && (management.state !== 'disabled' || management.epoch !== null))) return null;
  return management;
}
export function parseScheduleSnapshot(value: unknown): ScheduleSnapshot | null {
  const snapshot = object<ScheduleSnapshot>(value, {
    agentId, source: child(value => object(value, { state: oneOf(['current', 'stale']), observedAt: timestamp })),
    management: child(parseManagement), jobs: list(parseRow, 2000), operations: list(parseScheduleOperation, 50), operationsCursor: optional(text(2048)),
    operationsError: optional(oneOf(['storage-unavailable'])),
    scanned: value => integer(value) !== INVALID && (value as number) <= 2000 ? value : INVALID,
    truncated: bool, nextCursor: optional(text(2048)),
  });
  return snapshot && snapshot.jobs.every(job => job.agentId === snapshot.agentId)
    && snapshot.operations.every(operation => operation.agentId === snapshot.agentId)
    && (!snapshot.operationsCursor || snapshot.operations.length > 0)
    && (!snapshot.operationsError || (snapshot.operations.length === 0 && !snapshot.operationsCursor)) ? snapshot : null;
}
