import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CONTROL_LIMITS, controlByteSize, controlRecord, parseControlTarget,
  type ControlSession, type ControlSessionPage, type ControlTarget, type ControlTaskRequest, type ControlTaskSnapshot,
} from '../../shared/control';
import type { ControlErrorCode } from '../../shared/control';
import { projectSession, projectTask } from './projection';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';

export class ControlError extends Error {
  constructor(public readonly code: ControlErrorCode) { super(code); }
}
export interface TaskService {
  listSessions(agentId: string, cursor?: string, signal?: AbortSignal): Promise<ControlSessionPage>;
  getTask(input: ControlTaskRequest, signal?: AbortSignal): Promise<ControlTaskSnapshot>;
  verifyTarget(target: ControlTarget, signal?: AbortSignal): Promise<Record<string, unknown>>;
  clear(): void; close(): void;
}
const identity = (target: ControlTarget) => JSON.stringify([target.agentId, target.sessionKey, target.sessionId, target.lifecycleRevision ?? null, target.branchId ?? null]);
interface Cached { snapshot: ControlTaskSnapshot; at: number; valid: boolean; order: number; offset: number; total?: number }
interface Earlier { target: ControlTarget; snapshot: ControlTaskSnapshot; offset: number; loaded: number; expires: number; leaf?: unknown }
interface Flight { promise: Promise<ControlTaskSnapshot>; controller: AbortController; users: number }
export function createTaskService(gateway: ControlGateway, registeredAgentIds: () => ReadonlySet<string>): TaskService {
  const cache = new Map<string, Cached>(); const earlier = new Map<string, Earlier>(); const flights = new Map<string, Flight>();
  const cursorSecret = randomBytes(32); let closed = false; let epoch = 0; let destructiveEpoch = 0; let order = 0;
  const branches = new Map<string, string>(); let globalBranch: string | undefined;
  // Branch selection can change without a lifecycle reset; bind it to the observed source event.
  function branchIdentity(agentId: string, key: string, source: unknown): unknown {
    const observed = branches.get(JSON.stringify([agentId, key]));
    return observed || globalBranch ? `observed-${createHash('sha256').update(JSON.stringify([source ?? null, globalBranch ?? null, observed ?? null])).digest('hex')}` : source;
  }
  const decorate = (row: Record<string, unknown>, agentId: string) => ({ ...row, branchId: branchIdentity(agentId, String(row.key), row.branchId) });
  function trim(): void {
    const now = Date.now();
    for (const [key, entry] of cache) if (now - entry.at >= 60000) cache.delete(key);
    for (const [key, entry] of earlier) if (entry.expires <= now) earlier.delete(key);
    while (cache.size + earlier.size > 100) {
      if (earlier.size) earlier.delete(earlier.keys().next().value!);
      else cache.delete(cache.keys().next().value!);
    }
  }
  function registered(agentId: string): void {
    if (closed || !registeredAgentIds().has(agentId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agentId)) throw new ControlError('invalid-target');
  }
  function deniedAuthority(): 'scope-required' | 'pairing-required' | undefined {
    const state = gateway.status().state;
    return state === 'auth-error' ? 'scope-required' : state === 'pairing-required' ? 'pairing-required' : undefined;
  }
  function owned(value: unknown, agentId: string): Record<string, unknown> {
    const row = controlRecord(value); if (!row || typeof row.key !== 'string') throw new ControlError('invalid-target');
    const qualifiedOwner = /^agent:([^:]+):.+$/.exec(row.key)?.[1];
    if ((qualifiedOwner && qualifiedOwner !== agentId) || (row.agentId !== undefined && row.agentId !== agentId)) throw new ControlError('invalid-target');
    if (!qualifiedOwner && row.agentId !== agentId) throw new ControlError('unsupported');
    return { ...row, agentId };
  }
  function lifecycle(target: ControlTarget, row: Record<string, unknown>): void {
    if (row.key !== target.sessionKey || row.sessionId !== target.sessionId) throw new ControlError('session-changed');
    for (const key of ['lifecycleRevision', 'branchId'] as const) if (target[key] !== row[key]) throw new ControlError('session-changed');
  }
  async function verifyTarget(target: ControlTarget, signal?: AbortSignal): Promise<Record<string, unknown>> {
    registered(target.agentId); if (!parseControlTarget(target)) throw new ControlError('invalid-target');
    const denied = deniedAuthority(); if (denied) throw new ControlError(denied);
    const response = controlRecord(await gateway.request('sessions.describe', { key: target.sessionKey, agentId: target.agentId }, signal));
    const row = decorate(owned(response?.session, target.agentId), target.agentId); lifecycle(target, row); return row;
  }
  function listCursor(agentId: string, offset: number): string {
    const body = Buffer.from(JSON.stringify({ agentId, offset, expires: Date.now() + 60000 })).toString('base64url');
    return `${body}.${createHmac('sha256', cursorSecret).update(body).digest('base64url')}`;
  }
  function listOffset(agentId: string, cursor?: string): number {
    if (!cursor) return 0;
    try {
      if (cursor.length > 2048) throw Error(); const [body, signature, extra] = cursor.split('.');
      const expected = createHmac('sha256', cursorSecret).update(body).digest(); const supplied = Buffer.from(signature, 'base64url');
      if (extra || supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) throw Error();
      const row = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (row.agentId !== agentId || !Number.isSafeInteger(row.offset) || row.offset < 0 || row.offset > 100000 || row.expires <= Date.now()) throw Error();
      return row.offset;
    } catch { throw new ControlError('invalid-request'); }
  }
  async function listSessions(agentId: string, cursor?: string, signal?: AbortSignal): Promise<ControlSessionPage> {
    registered(agentId); const offset = listOffset(agentId, cursor);
    const denied = deniedAuthority(); if (denied) throw new ControlError(denied);
    const response = controlRecord(await gateway.request('sessions.list', { agentId, limit: 25, offset, includeGlobal: true, includeUnknown: false }, signal));
    if (!response || !Array.isArray(response.sessions) || response.sessions.length > 25) throw new ControlError('invalid-source');
    const sessions: ControlSession[] = [];
    for (const value of response.sessions) {
      try { const projected = projectSession(decorate(owned(value, agentId), agentId), agentId); if (projected) sessions.push(projected); } catch { /* Do not expose another owner's row. */ }
    }
    const hasMore = response.hasMore === true || (response.hasMore !== false && response.sessions.length === 25);
    const observedAt = typeof response.ts === 'number' && Number.isFinite(response.ts) && response.ts >= 0 ? response.ts : Date.now();
    return { sessions, source: { state: 'current', observedAt }, ...(hasMore ? { nextCursor: listCursor(agentId, offset + 25) } : {}) };
  }
  function continuation(target: ControlTarget, snapshot: ControlTaskSnapshot, offset: number, leaf?: unknown): string {
    const token = randomUUID(); earlier.set(token, { target, snapshot: structuredClone(snapshot), offset, loaded: snapshot.loadedRecords, expires: Date.now() + 60000, leaf }); trim(); return token;
  }
  async function read(input: ControlTaskRequest, signal: AbortSignal): Promise<ControlTaskSnapshot> {
    trim(); const key = identity(input); const previous = cache.get(key); const myEpoch = epoch; const myDestructiveEpoch = destructiveEpoch; const myOrder = ++order;
    const cursor = input.cursor ? earlier.get(input.cursor) : undefined;
    if (input.cursor && (!cursor || cursor.expires <= Date.now() || identity(cursor.target) !== key)) throw new ControlError('invalid-request');
    try {
      let row = await verifyTarget(input, signal);
      if (!input.cursor && previous?.valid && Date.now() - previous.at < 2000) return structuredClone(previous.snapshot);
      if (cursor && cursor.leaf !== undefined && row.activeLeafEntryId !== undefined && row.activeLeafEntryId !== cursor.leaf) throw new ControlError('invalid-request');
      let offset = cursor?.offset ?? 0; let loaded = cursor?.loaded ?? 0;
      const budget = cursor ? Math.min(50, 2000 - loaded) : 200;
      if (budget <= 0) throw new ControlError('invalid-request');
      let messages: unknown[] = []; let newest: Record<string, unknown> | undefined; let more = false; let total: unknown;
      for (let used = 0; used < budget; used += 50) {
        const page = controlRecord(await gateway.request('chat.history', { sessionKey: input.sessionKey, agentId: input.agentId, limit: 50, maxBytes: 256 * 1024, offset }, signal));
        if (!page || page.sessionKey !== input.sessionKey || page.sessionId !== input.sessionId || !Array.isArray(page.messages)
          || page.messages.length > 200 || page.windowReset === true || (total !== undefined && total !== page.totalMessages)) throw new ControlError('invalid-source');
        total = page.totalMessages;
        const info = controlRecord(page.sessionInfo);
        if (info && Object.keys(info).length) {
          if (cursor && info.activeLeafEntryId !== undefined && info.activeLeafEntryId !== cursor.leaf) throw new ControlError('invalid-request');
          if (newest && info.activeLeafEntryId !== undefined && row.activeLeafEntryId !== undefined && info.activeLeafEntryId !== row.activeLeafEntryId) throw new ControlError('invalid-request');
          const updated = owned({ ...row, ...info, branchId: info.branchId === undefined ? row.branchId : branchIdentity(input.agentId, input.sessionKey, info.branchId) }, input.agentId);
          lifecycle(input, updated); row = updated;
        }
        if (!newest) newest = page;
        messages = [...page.messages, ...messages]; loaded += 50;
        more = page.hasMore === true;
        const next = page.nextOffset;
        if (more && (!Number.isSafeInteger(next) || (next as number) <= offset)) throw new ControlError('invalid-source');
        if (more) offset = next as number;
        const projected = projectTask({ target: { ...input, activeLeafEntryId: typeof row.activeLeafEntryId === 'string' ? row.activeLeafEntryId : undefined }, session: row,
          history: { ...newest, messages, hasMore: more }, children: [], childrenComplete: false, loadedRecords: loaded, observedAt: Date.now() });
        if (!more || projected.requestAssociation === 'run' || (!projected.runId && projected.request)
          || (!cursor && projected.runId && projected.runId === previous?.snapshot.runId && previous.snapshot.requestAssociation === 'run')) break;
      }
      const qualifiedParent = /^agent:[^:]+:.+$/.test(input.sessionKey);
      const childResponse = controlRecord(await gateway.request('sessions.list', { ...(qualifiedParent ? {} : { agentId: input.agentId }), spawnedBy: input.sessionKey, limit: 25, offset: 0 }, signal));
      const validChildPage = Array.isArray(childResponse?.sessions) && childResponse.sessions.length <= 25
        && (childResponse.hasMore === undefined || typeof childResponse.hasMore === 'boolean');
      const childRows: unknown[] = validChildPage ? childResponse!.sessions as unknown[] : [];
      const children = childRows.filter(value => { const child = controlRecord(value); return child && (child.spawnedBy === input.sessionKey || child.parentSessionKey === input.sessionKey); })
        .flatMap(value => {
          const child = controlRecord(value)!;
          const owner = typeof child.agentId === 'string' ? child.agentId : typeof child.key === 'string' ? /^agent:([^:]+):/.exec(child.key)?.[1] : undefined;
          if (!owner || !registeredAgentIds().has(owner)) return [];
          try { return [owned(value, owner)]; } catch { return []; }
        });
      const target = parseControlTarget({ ...input, ...row, sessionKey: row.key, activeLeafEntryId: typeof row.activeLeafEntryId === 'string' ? row.activeLeafEntryId : undefined });
      if (!target) throw new ControlError('invalid-source');
      const sourceAt = typeof row.snapshotAt === 'number' && Number.isFinite(row.snapshotAt) && row.snapshotAt >= 0 ? row.snapshotAt : Date.now();
      let result = projectTask({ target, session: row, history: { ...newest, messages, hasMore: more }, children,
        childrenComplete: qualifiedParent && validChildPage && children.length === childRows.length
          && (childResponse?.hasMore === false || (childResponse?.hasMore !== true && childRows.length < 25)), loadedRecords: loaded, observedAt: sourceAt });
      if (cursor) {
        const old = cursor.snapshot;
        // Earlier discovery supplies request context; recent response/activity stay at the observed tail.
        result = { ...old, target, loadedRecords: loaded, nextCursor: undefined,
          request: result.requestAssociation === 'run' ? result.request : old.request ?? result.request,
          requestAssociation: result.requestAssociation === 'run' ? 'run' : old.requestAssociation === 'run' ? 'run' : result.request ? 'latest-recorded' : old.requestAssociation,
          requestState: result.requestAssociation === 'run' || old.requestAssociation === 'run' || (!result.runId && (result.request || old.request)) ? 'found' : loaded >= 2000 ? 'limit-reached' : more ? 'not-loaded' : 'unavailable' };
      }
      if (!cursor && result.runId && result.runId === previous?.snapshot.runId && typeof total === 'number' && previous.total !== undefined && total >= previous.total) {
        const old = previous.snapshot;
        if (result.requestAssociation !== 'run' && old.requestAssociation === 'run') result = { ...result, request: old.request, requestAssociation: 'run', requestState: 'found' };
        if (old.loadedRecords > result.loadedRecords) { loaded = old.loadedRecords; result.loadedRecords = loaded; offset = previous.offset + total - previous.total; }
      }
      if (more && loaded < 2000) result.nextCursor = continuation(target, result, offset, row.activeLeafEntryId);
      if (controlByteSize(result) > CONTROL_LIMITS.responseBytes) throw new ControlError('invalid-source');
      if (closed || signal.aborted || myEpoch !== epoch) throw new ControlError('unavailable');
      const latest = cache.get(key);
      if (!latest || (result.source.observedAt >= latest.snapshot.source.observedAt && myOrder >= latest.order)) {
        cache.delete(key); cache.set(key, { snapshot: structuredClone(result), at: Date.now(), valid: true, order: myOrder, offset, total: typeof total === 'number' ? total : undefined }); trim();
      }
      return result;
    } catch (error) {
      const denied = deniedAuthority();
      if (denied) { cache.delete(key); for (const [token, item] of earlier) if (identity(item.target) === key) earlier.delete(token); throw new ControlError(denied); }
      if (myDestructiveEpoch !== destructiveEpoch) throw new ControlError('session-changed');
      if (error instanceof GatewayRequestError && error.code !== 'unavailable') {
        cache.delete(key); for (const [token, item] of earlier) if (identity(item.target) === key) earlier.delete(token);
        throw new ControlError(error.code);
      }
      if (error instanceof ControlError && error.code !== 'unavailable') { if (error.code === 'session-changed' || error.code === 'invalid-target') cache.delete(key); throw error; }
      if (!signal.aborted && previous && cache.get(key) === previous && Date.now() - previous.at < 60000) return { ...structuredClone(previous.snapshot), source: { ...previous.snapshot.source, state: 'stale' } };
      throw new ControlError('unavailable');
    }
  }
  function clear(): void { epoch++; cache.clear(); earlier.clear(); for (const flight of flights.values()) flight.controller.abort(); flights.clear(); }
  const unsubscribe = gateway.onEvent(event => {
    if (event.event === 'source.ready') { void gateway.request('sessions.subscribe', {}).catch(() => {}); }
    if (event.event === 'source.invalidated' || event.event === 'sessions.changed') {
      if (deniedAuthority()) { clear(); return; }
      epoch++;
      const payload = controlRecord(event.payload);
      if (payload && ['reset', 'delete', 'branch', 'branch-switch', 'rewind'].includes(String(payload.reason))) {
        destructiveEpoch++; cache.clear(); earlier.clear();
        if (payload.reason === 'branch-switch' || payload.reason === 'branch' || payload.reason === 'rewind') {
          const nested = controlRecord(payload.session); const sessionKey = payload.sessionKey ?? nested?.key;
          const agentId = payload.agentId ?? nested?.agentId ?? (typeof sessionKey === 'string' ? /^agent:([^:]+):/.exec(sessionKey)?.[1] : undefined);
          if (typeof sessionKey === 'string' && sessionKey.length <= 512 && typeof agentId === 'string' && registeredAgentIds().has(agentId)) {
            branches.set(JSON.stringify([agentId, sessionKey]), randomUUID());
            while (branches.size > 1000) branches.delete(branches.keys().next().value!);
          } else { globalBranch = randomUUID(); branches.clear(); }
        }
        for (const flight of flights.values()) flight.controller.abort();
      }
      else for (const entry of cache.values()) entry.valid = false;
    }
  });
  if (gateway.status().canRead) void gateway.request('sessions.subscribe', {}).catch(() => {});
  return {
    listSessions, verifyTarget,
    getTask(input, signal) {
      registered(input.agentId); if (signal?.aborted) return Promise.reject(new ControlError('unavailable'));
      const key = JSON.stringify([identity(input), input.cursor ?? null]); let flight = flights.get(key);
      if (!flight) {
        const controller = new AbortController(); flight = { controller, users: 0, promise: read(input, controller.signal) };
        flights.set(key, flight); const current = flight;
        void current.promise.finally(() => { if (flights.get(key) === current) flights.delete(key); }).catch(() => {});
      }
      const current = flight; current.users++;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => { if (settled) return false; settled = true; signal?.removeEventListener('abort', abort); current.users--; if (!current.users) current.controller.abort(); return true; };
        const abort = () => { if (finish()) reject(new ControlError('unavailable')); };
        signal?.addEventListener('abort', abort, { once: true });
        current.promise.then(value => { if (finish()) resolve(structuredClone(value)); }, error => { if (finish()) reject(error); });
      });
    },
    clear,
    close() { closed = true; unsubscribe(); clear(); },
  };
}
