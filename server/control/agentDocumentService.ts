import { createHash, randomUUID } from 'node:crypto';
import { controlByteSize, controlRecord, CONTROL_LIMITS, isControlAgentId } from '../../shared/control';
import { AGENT_DOCUMENT_LIMITS, isAgentDocumentText, parseAgentDocumentReadRequest, parseAgentDocumentSaveRequest,
  type AgentDocumentManagement, type AgentDocumentName, type AgentDocumentReadRequest, type AgentDocumentSaveReceipt,
  type AgentDocumentSaveRequest, type AgentDocumentSnapshot } from '../../shared/controlAgentDocuments';
import { ControlError } from './errors';
import { GatewayRequestError, type AgentDocumentGateway } from './gatewayClient';

export interface AgentDocumentService {
  status(agentId: string): AgentDocumentManagement;
  read(agentId: string, input: AgentDocumentReadRequest, signal?: AbortSignal): Promise<AgentDocumentSnapshot>;
  save(agentId: string, input: AgentDocumentSaveRequest, signal?: AbortSignal): Promise<AgentDocumentSaveReceipt>;
  close(): void;
}
type Connection = NonNullable<ReturnType<AgentDocumentGateway['connection']>>;
interface Ticket { agentId: string; name: AgentDocumentName; workspace: string; hash: string; connection: string; source: number; expiresAt: number }
interface Operation { fingerprint: string; expiresAt: number; result: Promise<AgentDocumentSaveReceipt> }
interface NativeDocument { workspace: string; hash: string; content: string; bytes: number }
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const input = controlRecord(value);
  return input && Reflect.ownKeys(input).every(key => typeof key === 'string' && keys.includes(key))
    && controlByteSize(input) <= CONTROL_LIMITS.responseBytes ? input : null;
}
function nativeDocument(value: unknown, agentId: string, name: AgentDocumentName, saved = false): NativeDocument {
  const input = closed(value, saved ? ['ok', 'agentId', 'workspace', 'file'] : ['agentId', 'workspace', 'file']);
  const file = closed(input?.file, ['name', 'path', 'missing', 'size', 'updatedAtMs', 'hash', 'content', 'expectedAbsent']);
  if (!input || (saved && input.ok !== true) || input.agentId !== agentId || !file || file.name !== name
    || typeof input.workspace !== 'string' || input.workspace.length === 0 || input.workspace.length > 4096
    || !input.workspace.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(input.workspace)
    || file.path !== `${input.workspace.replace(/\/$/, '')}/${name}`) throw new ControlError('invalid-source');
  if (file.missing === true) throw new ControlError('file-unavailable');
  if (typeof file.size === 'number' && file.size > AGENT_DOCUMENT_LIMITS.bytes) throw new ControlError('file-too-large');
  if (typeof file.content === 'string' && Buffer.byteLength(file.content, 'utf8') > AGENT_DOCUMENT_LIMITS.bytes) throw new ControlError('file-too-large');
  if (!isAgentDocumentText(file.content)) throw new ControlError('preview-unsupported');
  if (file.missing !== false || !Number.isSafeInteger(file.size) || file.size !== Buffer.byteLength(file.content, 'utf8')
    || typeof file.hash !== 'string' || !/^[0-9a-f]{64}$/.test(file.hash) || file.hash !== hash(file.content)
    || (file.updatedAtMs !== undefined && (typeof file.updatedAtMs !== 'number' || !Number.isSafeInteger(file.updatedAtMs) || file.updatedAtMs < 0))) throw new ControlError('invalid-source');
  return { workspace: input.workspace, hash: file.hash, content: file.content, bytes: file.size as number };
}
export function createAgentDocumentService(gateway: AgentDocumentGateway, registeredAgentIds: () => ReadonlySet<string>): AgentDocumentService {
  let closed = false; let source = 0; let pendingReads = 0; let pendingWrites = 0;
  const tickets = new Map<string, Ticket>(); const operations = new Map<string, Operation>();
  const invalidate = () => { source++; tickets.clear(); };
  const unsubscribe = gateway.onEvent(event => { if (['source.invalidated', 'source.ready', 'config.changed'].includes(event.event)) invalidate(); });
  function agent(agentId: string): void { if (!isControlAgentId(agentId) || !registeredAgentIds().has(agentId)) throw new ControlError('invalid-target'); }
  function prune(): void {
    const now = Date.now();
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id);
    for (const [id, operation] of operations) if (operation.expiresAt <= now) operations.delete(id);
  }
  function connection(agentId: string, signal?: AbortSignal): Connection {
    agent(agentId); if (closed || signal?.aborted) throw new ControlError('unavailable');
    const status = gateway.status();
    if (!status.configured) throw new ControlError('disabled');
    if (status.state === 'pairing-required') throw new ControlError('pairing-required');
    if (status.state === 'unsupported') throw new ControlError('unsupported');
    if (status.state === 'auth-error' || status.reason === 'permission') throw new ControlError('document-denied');
    const current = gateway.connection(); if (!status.canEdit || !current || current.epoch !== status.epoch) throw new ControlError('unavailable');
    return { ...current };
  }
  function key(current: Connection): string { return JSON.stringify([current.epoch, current.gatewayUrl, current.deviceId]); }
  function fence(agentId: string, expected: string, expectedSource: number, signal?: AbortSignal): void {
    const current = connection(agentId, signal);
    if (source !== expectedSource || key(current) !== expected) throw new ControlError('document-changed');
  }
  function snapshot(agentId: string, name: AgentDocumentName, file: NativeDocument, current: Connection, expectedSource: number): AgentDocumentSnapshot {
    const revision = randomUUID();
    tickets.set(revision, { agentId, name, workspace: file.workspace, hash: file.hash, connection: key(current), source: expectedSource, expiresAt: Date.now() + AGENT_DOCUMENT_LIMITS.ttlMs });
    return { agentId, name, revision, content: file.content, bytes: file.bytes, source: { state: 'current', observedAt: Date.now() } };
  }
  async function read(agentId: string, input: AgentDocumentReadRequest, signal?: AbortSignal): Promise<AgentDocumentSnapshot> {
    const selection = parseAgentDocumentReadRequest(input); if (!selection) throw new ControlError('invalid-request');
    const current = connection(agentId, signal); const expectedSource = source; prune();
    if (tickets.size + pendingReads + pendingWrites >= AGENT_DOCUMENT_LIMITS.tickets) throw new ControlError('rate-limited');
    pendingReads++;
    try {
      const raw = await gateway.request('agents.files.get', { agentId, name: selection.name }, signal);
      fence(agentId, key(current), expectedSource, signal);
      return snapshot(agentId, selection.name, nativeDocument(raw, agentId, selection.name), current, expectedSource);
    } finally { pendingReads--; }
  }
  async function save(agentId: string, input: AgentDocumentSaveRequest, signal?: AbortSignal): Promise<AgentDocumentSaveReceipt> {
    const selected = parseAgentDocumentSaveRequest(input); if (!selected) throw new ControlError('invalid-request');
    agent(agentId); if (closed) throw new ControlError('unavailable'); prune();
    const fingerprint = hash(JSON.stringify([agentId, selected.name, selected.revision, selected.content]));
    const existing = operations.get(selected.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ControlError('invalid-request');
      return structuredClone(await existing.result);
    }
    const current = connection(agentId, signal); const expectedSource = source;
    const ticket = tickets.get(selected.revision);
    if (!ticket || ticket.agentId !== agentId || ticket.name !== selected.name || ticket.connection !== key(current) || ticket.source !== expectedSource) throw new ControlError('document-changed');
    if (operations.size >= AGENT_DOCUMENT_LIMITS.operations) throw new ControlError('rate-limited');
    tickets.delete(selected.revision); pendingWrites++;
    // Reserve operation identity before dispatch or any awaited work; duplicates join this one promise.
    let finish!: (receipt: AgentDocumentSaveReceipt) => void;
    const operation: Operation = { fingerprint, expiresAt: Date.now() + AGENT_DOCUMENT_LIMITS.ttlMs, result: new Promise(resolve => { finish = resolve; }) };
    operations.set(selected.operationId, operation);
    const receipt: AgentDocumentSaveReceipt = { agentId, name: selected.name, operationId: selected.operationId, state: 'unknown' };
    try {
      const raw = await gateway.request('agents.files.set', { agentId, name: selected.name, content: selected.content, expectedHash: ticket.hash, expectedWorkspace: ticket.workspace }, signal);
      fence(agentId, key(current), expectedSource, signal);
      if (operations.get(selected.operationId) !== operation || operation.expiresAt <= Date.now()) throw new ControlError('document-outcome-unknown');
      const file = nativeDocument(raw, agentId, selected.name, true);
      if (file.workspace !== ticket.workspace || file.content !== selected.content || file.hash !== hash(selected.content)) throw new ControlError('invalid-source');
      receipt.state = 'saved'; receipt.snapshot = snapshot(agentId, selected.name, file, current, expectedSource);
    } catch (error) {
      // Only an explicit native precondition rejection establishes a conflict. Everything
      // else after admission may have written and cannot authorize automatic replay.
      if (error instanceof GatewayRequestError && error.code === 'document-changed') {
        try { fence(agentId, key(current), expectedSource, signal); receipt.state = 'conflict'; } catch { /* source changed: unknown */ }
      }
    } finally { pendingWrites--; finish(receipt); }
    return structuredClone(receipt);
  }
  return {
    status(agentId) { agent(agentId); if (closed) throw new ControlError('unavailable'); gateway.start(); return { ...gateway.status() }; },
    read, save,
    close() { if (closed) return; closed = true; invalidate(); operations.clear(); unsubscribe(); gateway.close(); },
  };
}
