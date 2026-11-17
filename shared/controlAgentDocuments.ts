import { CONTROL_LIMITS, controlByteSize, controlRecord, isControlAgentId, type ControlGatewayState, type ControlSource } from './control';

export const AGENT_DOCUMENT_NAMES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md'] as const;
export const AGENT_DOCUMENT_MIN_GATEWAY_VERSION = '2026.11.2';
export const AGENT_DOCUMENT_LIMITS = { bytes: 32 * 1024, tickets: 32, operations: 128, ttlMs: 10 * 60 * 1000 } as const;
export type AgentDocumentName = typeof AGENT_DOCUMENT_NAMES[number];
export interface AgentDocumentManagement { configured: boolean; state: ControlGatewayState; canEdit: boolean; epoch: string | null; reason: string | null }
export interface AgentDocumentSnapshot { agentId: string; name: AgentDocumentName; revision: string; content: string; bytes: number; source: ControlSource }
export interface AgentDocumentReadRequest { name: AgentDocumentName }
export interface AgentDocumentSaveRequest extends AgentDocumentReadRequest { revision: string; operationId: string; content: string }
export interface AgentDocumentSaveReceipt { agentId: string; name: AgentDocumentName; operationId: string; state: 'saved' | 'conflict' | 'unknown'; snapshot?: AgentDocumentSnapshot }

export function isAgentDocumentText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= AGENT_DOCUMENT_LIMITS.bytes
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && !/[\ud800-\udfff]/u.test(value)
    && new TextEncoder().encode(value).byteLength <= AGENT_DOCUMENT_LIMITS.bytes;
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const input = controlRecord(value);
  return input && Reflect.ownKeys(input).every(key => typeof key === 'string' && keys.includes(key))
    && controlByteSize(input) <= CONTROL_LIMITS.responseBytes ? input : null;
}
function opaque(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
function name(value: unknown): value is AgentDocumentName { return typeof value === 'string' && (AGENT_DOCUMENT_NAMES as readonly string[]).includes(value); }
export function parseAgentDocumentReadRequest(value: unknown): AgentDocumentReadRequest | null {
  const input = closed(value, ['name']); return input && name(input.name) ? { name: input.name } : null;
}
export function parseAgentDocumentSaveRequest(value: unknown): AgentDocumentSaveRequest | null {
  const input = closed(value, ['name', 'revision', 'operationId', 'content']);
  return input && name(input.name) && opaque(input.revision) && opaque(input.operationId) && isAgentDocumentText(input.content)
    ? { name: input.name, revision: input.revision, operationId: input.operationId, content: input.content } : null;
}
export function parseAgentDocumentManagement(value: unknown): AgentDocumentManagement | null {
  const input = closed(value, ['configured', 'state', 'canEdit', 'epoch', 'reason']);
  if (!input || typeof input.configured !== 'boolean' || typeof input.canEdit !== 'boolean'
    || typeof input.state !== 'string' || !['disabled', 'connecting', 'ready', 'pairing-required', 'auth-error', 'unsupported', 'unavailable'].includes(input.state)
    || !(input.epoch === null || opaque(input.epoch)) || !(input.reason === null || (typeof input.reason === 'string' && ['disabled', 'pairing-required', 'permission', 'unsupported', 'storage-unavailable', 'unavailable'].includes(input.reason)))) return null;
  if (input.canEdit ? !input.configured || input.state !== 'ready' || !input.epoch || input.reason !== null : input.epoch !== null || input.reason === null) return null;
  if (!input.configured && (input.state !== 'disabled' || input.reason !== 'disabled')) return null;
  return { configured: input.configured, state: input.state as ControlGatewayState, canEdit: input.canEdit, epoch: input.epoch, reason: input.reason as string | null };
}
export function parseAgentDocumentSnapshot(value: unknown): AgentDocumentSnapshot | null {
  const input = closed(value, ['agentId', 'name', 'revision', 'content', 'bytes', 'source']);
  const source = closed(input?.source, ['state', 'observedAt']);
  if (!input || !isControlAgentId(input.agentId) || !name(input.name) || !opaque(input.revision) || !isAgentDocumentText(input.content)
    || input.bytes !== new TextEncoder().encode(input.content).byteLength || !source || typeof source.state !== 'string' || !['current', 'stale'].includes(source.state)
    || typeof source.observedAt !== 'number' || !Number.isSafeInteger(source.observedAt) || source.observedAt < 0 || source.observedAt > 8640000000000000) return null;
  return { agentId: input.agentId, name: input.name, revision: input.revision, content: input.content, bytes: input.bytes as number,
    source: { state: source.state as ControlSource['state'], observedAt: source.observedAt } };
}
export function parseAgentDocumentSaveReceipt(value: unknown): AgentDocumentSaveReceipt | null {
  const input = closed(value, ['agentId', 'name', 'operationId', 'state', 'snapshot']);
  if (!input || !isControlAgentId(input.agentId) || !name(input.name) || !opaque(input.operationId) || typeof input.state !== 'string' || !['saved', 'conflict', 'unknown'].includes(input.state)) return null;
  const base = { agentId: input.agentId, name: input.name, operationId: input.operationId };
  if (input.state !== 'saved') return Object.prototype.hasOwnProperty.call(input, 'snapshot') ? null : { ...base, state: input.state as 'conflict' | 'unknown' };
  const snapshot = parseAgentDocumentSnapshot(input.snapshot);
  return snapshot && snapshot.agentId === input.agentId && snapshot.name === input.name ? { ...base, state: 'saved', snapshot } : null;
}
