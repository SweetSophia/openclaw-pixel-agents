export const CONTROL_LIMITS = {
  responseBytes: 256 * 1024, text: 16000, sessions: 25, activity: 50,
  historyPage: 50, automaticHistory: 200, maximumHistory: 2000, prompt: 8000,
} as const;

// OpenClaw 2026.10.3 treats these ordinary-text aliases as immediate aborts.
// Suppression is admin-only, so the read/write office excludes command inputs.
const ABORT_TEXT = new Set(['stop', 'esc', 'abort', 'exit', 'interrupt', 'detente', 'deten', 'detén', 'arrete', 'arrête',
  '停止', '停下来', '暂停', 'やめて', '止めて', 'रुको', 'توقف', 'стоп', 'остановись', 'останови', 'остановить', 'прекрати',
  'halt', 'anhalten', 'aufhören', 'hoer auf', 'stopp', 'pare', 'stop openclaw', 'openclaw stop', 'stop action',
  'stop current action', 'stop run', 'stop current run', 'stop agent', 'stop the agent', "stop don't do anything",
  'stop dont do anything', 'stop do not do anything', 'stop doing anything', 'do not do that', 'please stop', 'stop please']);
const ABORT_PUNCTUATION = new Set('.!?！？…,，。;；:：\'"’”)]}');
export function isControlCommand(text: string): boolean {
  // Match Gateway sanitization: formatting and compatibility characters remain ordinary text.
  const normalized = text.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (/^[\/!]/.test(normalized)) return true;
  const abortText = normalized.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ');
  let end = abortText.length;
  while (end > 0 && ABORT_PUNCTUATION.has(abortText[end - 1])) end--;
  return ABORT_TEXT.has(abortText.slice(0, end).trim());
}

export type ControlRunState = 'running' | 'completed' | 'failed' | 'aborted' | 'not-running' | 'unknown';
export type ControlGatewayState = 'disabled' | 'connecting' | 'ready' | 'pairing-required' | 'auth-error' | 'unsupported' | 'unavailable';
export interface ControlTarget {
  agentId: string; sessionKey: string; sessionId: string;
  lifecycleRevision?: string; branchId?: string; activeLeafEntryId?: string;
}
export interface ControlStatus { configured: boolean; state: ControlGatewayState; canRead: boolean; canSend: boolean }
export interface ControlSource { state: 'current' | 'stale'; observedAt: number }
export interface ControlSession extends ControlTarget {
  name: string; channel?: string; isChild: boolean; hasActiveRun: boolean | null;
  updatedAt?: number; snapshotAt?: number; model?: string; sendDisabledReason?: string;
}
export interface ControlSessionPage { sessions: ControlSession[]; nextCursor?: string; source: ControlSource }
export interface ControlActivity {
  id: string; runId?: string; toolCallId?: string; toolName: string; at?: number;
  outcome: 'pending' | 'success' | 'error' | 'unknown';
}
export interface ControlMessage {
  id: string; role: 'user' | 'assistant'; text: string; truncated: boolean;
  at?: number; runId?: string; messageSeq?: number; submissionId?: string;
}
export interface ControlTaskRequest extends ControlTarget { cursor?: string }
export interface ControlTaskSnapshot {
  target: ControlTarget; source: ControlSource; hasActiveRun: boolean | null; activeRunIds?: string[];
  runId?: string; runState: ControlRunState; request?: ControlMessage;
  requestAssociation: 'run' | 'latest-recorded' | 'unknown';
  requestState: 'found' | 'not-loaded' | 'limit-reached' | 'unavailable';
  startedAt?: number; endedAt?: number; latestResponse?: ControlMessage; result?: ControlMessage;
  activity: ControlActivity[]; children: ControlSession[]; childrenComplete: boolean;
  loadedRecords: number; nextCursor?: string; model?: string;
}
export interface ControlHistoryPage {
  target: ControlTarget; source: ControlSource; messages: ControlMessage[];
  nextCursor?: string; sendDisabledReason?: string;
}
export interface ControlSendRequest {
  agentId: string; target?: ControlTarget; newConversation: boolean; message: string; idempotencyKey: string;
}
export interface ControlSendReceipt {
  target: ControlTarget; idempotencyKey: string; phase: 'accepted' | 'persisted' | 'unknown';
  runId?: string; messageId?: string; messageSeq?: number;
}
export type ControlErrorCode = 'disabled' | 'locked' | 'transport-required' | 'pairing-required' | 'scope-required'
  | 'unsupported' | 'unavailable' | 'invalid-source' | 'invalid-target' | 'session-changed'
  | 'invalid-request' | 'rate-limited' | 'outcome-unknown' | 'command-not-supported';
export interface ControlErrorBody { error: string; code: ControlErrorCode }
export interface ControlConversationEvent {
  target: ControlTarget; kind: 'messages' | 'invalidated' | 'unavailable'; source: ControlSource; messages?: ControlMessage[];
}

const INVALID = Symbol('invalid-control-field');
type Field = (value: unknown) => unknown;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

export function controlRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.keys(value).some(key => RESERVED.has(key))) return null;
  return value as Record<string, unknown>;
}

export function controlByteSize(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' ? new TextEncoder().encode(encoded).byteLength : Infinity;
  } catch { return Infinity; }
}

function object<T>(value: unknown, shape: Record<string, Field>): T | null {
  const input = controlRecord(value);
  if (!input || controlByteSize(input) > CONTROL_LIMITS.responseBytes) return null;
  const output: Record<string, unknown> = {};
  for (const [key, parse] of Object.entries(shape)) {
    const field = parse(input[key]);
    if (field === INVALID) return null;
    if (field !== undefined) output[key] = field;
  }
  return output as T;
}

function text(max: number, opaque = false): Field {
  return value => typeof value === 'string' && value.length <= max
    && (!opaque || (value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value))) ? value : INVALID;
}
const bool: Field = value => typeof value === 'boolean' ? value : INVALID;
const activityFlag: Field = value => value === null || typeof value === 'boolean' ? value : INVALID;
const time: Field = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : INVALID;
const integer: Field = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : INVALID;
const optional = (field: Field): Field => value => value === undefined ? undefined : field(value);
const oneOf = <T extends string>(values: readonly T[]): Field => value => typeof value === 'string' && values.includes(value as T) ? value : INVALID;
const child = <T>(parse: (value: unknown) => T | null): Field => value => parse(value) ?? INVALID;
function list(field: Field, maximum: number): Field {
  return value => {
    if (!Array.isArray(value) || value.length > maximum) return INVALID;
    const result = value.map(field);
    return result.includes(INVALID) ? INVALID : result;
  };
}
const agentId: Field = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) ? value : INVALID;
const sessionId: Field = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : INVALID;
const targetShape = {
  agentId, sessionId, sessionKey: text(512, true), lifecycleRevision: optional(text(256, true)),
  branchId: optional(text(256, true)), activeLeafEntryId: optional(text(256, true)),
};

export function parseControlTarget(value: unknown): ControlTarget | null { return object(value, targetShape); }
function parseSource(value: unknown): ControlSource | null {
  return object(value, { state: oneOf(['current', 'stale']), observedAt: time });
}

export function parseControlStatus(value: unknown): ControlStatus | null {
  const status = object<ControlStatus>(value, {
    configured: bool, canRead: bool, canSend: bool,
    state: oneOf(['disabled', 'connecting', 'ready', 'pairing-required', 'auth-error', 'unsupported', 'unavailable']),
  });
  if (!status || (status.canRead && status.state !== 'ready') || (status.canSend && !status.canRead)
    || (!status.configured && (status.state !== 'disabled' || status.canRead || status.canSend))) return null;
  return status;
}

export function parseControlSession(value: unknown): ControlSession | null {
  return object(value, {
    ...targetShape, name: text(256), channel: optional(text(128)), isChild: bool, hasActiveRun: activityFlag,
    updatedAt: optional(time), snapshotAt: optional(time), model: optional(text(256)), sendDisabledReason: optional(text(256)),
  });
}
export function parseControlSessionPage(value: unknown): ControlSessionPage | null {
  return object(value, {
    sessions: list(child(parseControlSession), CONTROL_LIMITS.sessions), source: child(parseSource),
    nextCursor: optional(text(2048, true)),
  });
}
export function parseControlMessage(value: unknown): ControlMessage | null {
  return object(value, {
    id: text(256, true), role: oneOf(['user', 'assistant']), text: text(CONTROL_LIMITS.text), truncated: bool,
    at: optional(time), runId: optional(text(256, true)), messageSeq: optional(integer), submissionId: optional(text(256, true)),
  });
}
function parseActivity(value: unknown): ControlActivity | null {
  return object(value, {
    id: text(256, true), toolName: text(128), outcome: oneOf(['pending', 'success', 'error', 'unknown']),
    at: optional(time), runId: optional(text(256, true)), toolCallId: optional(text(256, true)),
  });
}
export function parseControlTaskSnapshot(value: unknown): ControlTaskSnapshot | null {
  return object(value, {
    target: child(parseControlTarget), source: child(parseSource), hasActiveRun: activityFlag,
    activeRunIds: optional(list(text(256, true), 64)), runId: optional(text(256, true)),
    runState: oneOf(['running', 'completed', 'failed', 'aborted', 'not-running', 'unknown']),
    request: optional(child(parseControlMessage)), requestAssociation: oneOf(['run', 'latest-recorded', 'unknown']),
    requestState: oneOf(['found', 'not-loaded', 'limit-reached', 'unavailable']),
    startedAt: optional(time), endedAt: optional(time), latestResponse: optional(child(parseControlMessage)),
    result: optional(child(parseControlMessage)), activity: list(child(parseActivity), CONTROL_LIMITS.activity),
    children: list(child(parseControlSession), CONTROL_LIMITS.sessions), childrenComplete: bool,
    loadedRecords: value => integer(value) !== INVALID && (value as number) <= CONTROL_LIMITS.maximumHistory ? value : INVALID,
    nextCursor: optional(text(2048, true)), model: optional(text(256)),
  });
}
export function parseControlHistoryPage(value: unknown): ControlHistoryPage | null {
  return object(value, {
    target: child(parseControlTarget), source: child(parseSource), messages: list(child(parseControlMessage), CONTROL_LIMITS.historyPage),
    nextCursor: optional(text(2048, true)), sendDisabledReason: optional(text(256)),
  });
}
export function parseControlConversationEvent(value: unknown): ControlConversationEvent | null {
  const event = object<ControlConversationEvent>(value, {
    target: child(parseControlTarget), kind: oneOf(['messages', 'invalidated', 'unavailable']), source: child(parseSource),
    messages: optional(list(child(parseControlMessage), CONTROL_LIMITS.historyPage)),
  });
  return event && (event.kind !== 'messages' || event.messages !== undefined) ? event : null;
}
export function parseControlSendReceipt(value: unknown): ControlSendReceipt | null {
  const receipt = object<ControlSendReceipt>(value, {
    target: child(parseControlTarget), idempotencyKey: text(128, true), phase: oneOf(['accepted', 'persisted', 'unknown']),
    runId: optional(text(256, true)), messageId: optional(text(256, true)), messageSeq: optional(integer),
  });
  return receipt && (receipt.phase !== 'persisted' || (receipt.messageId && receipt.messageSeq && receipt.messageSeq > 0)) ? receipt : null;
}
