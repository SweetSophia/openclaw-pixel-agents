import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Server } from 'socket.io';
import { controlByteSize, controlRecord, CONTROL_LIMITS, parseControlTarget, type ControlConversationEvent, type ControlHistoryPage, type ControlTarget } from '../../shared/control';
import { createControlAccess } from './access';
import type { ControlConfig } from './config';
import type { ControlGateway } from './gatewayClient';
import { projectConversationMessages } from './projection';
import { ControlError, type TaskService } from './taskService';
import { parseTaskRequest } from './validation';

export interface ConversationService {
  history(target: ControlTarget, cursor?: string, signal?: AbortSignal): Promise<ControlHistoryPage>;
  watch(target: ControlTarget, listener: (event: ControlConversationEvent) => void): () => void;
  close(): void;
}
const identity = (target: ControlTarget) => JSON.stringify([target.agentId, target.sessionKey, target.sessionId, target.lifecycleRevision, target.branchId]);
interface Watch { target: ControlTarget; listeners: Set<(event: ControlConversationEvent) => void>; subscriptionId: string; generation: number; stopped: boolean; pending: boolean; again: boolean; subscribed: boolean }
export function createConversationService(gateway: ControlGateway, tasks: TaskService): ConversationService {
  const cursors = new Map<string, { key: string; offset: number; leaf: unknown; expires: number }>();
  const watches = new Map<string, Watch>(); let generation = 0; let closed = false;
  async function history(target: ControlTarget, cursor?: string, signal?: AbortSignal): Promise<ControlHistoryPage> {
    if (closed) throw new ControlError('unavailable');
    const current = generation; const key = identity(target); const earlier = cursor ? cursors.get(cursor) : undefined;
    if (cursor && (!earlier || earlier.key !== key || earlier.expires <= Date.now())) throw new ControlError('invalid-request');
    const row = await tasks.verifyTarget(target, signal);
    const page = controlRecord(await gateway.request('chat.history', { agentId: target.agentId, sessionKey: target.sessionKey, limit: 50, maxBytes: 256 * 1024, offset: earlier?.offset ?? 0 }, signal));
    if (!page || page.sessionKey !== target.sessionKey || page.sessionId !== target.sessionId || !Array.isArray(page.messages)
      || page.messages.length > 50 || page.windowReset === true) throw new ControlError('invalid-source');
    const info = controlRecord(page.sessionInfo); const leaf = info?.activeLeafEntryId !== undefined ? info.activeLeafEntryId : row.activeLeafEntryId;
    for (const field of ['lifecycleRevision', 'branchId'] as const) if (info?.[field] !== undefined && target[field] !== info[field]) throw new ControlError('session-changed');
    if (earlier && leaf !== earlier.leaf) throw new ControlError('invalid-request');
    await tasks.verifyTarget(target, signal);
    if (closed || current !== generation || signal?.aborted) throw new ControlError('unavailable');
    const result: ControlHistoryPage = {
      target: { ...target, activeLeafEntryId: typeof leaf === 'string' ? leaf : undefined }, source: { state: 'current', observedAt: Date.now() },
      messages: projectConversationMessages(page.messages, earlier?.offset),
      sendDisabledReason: row.sendDisabledReason || row.sharingRole === 'viewer' || row.readOnly === true ? 'This conversation is not available for sending.'
        : typeof leaf !== 'string' || !leaf ? 'Start a new conversation to send from an empty or unsupported transcript.' : undefined,
    };
    if (page.hasMore === true) {
      if (!Number.isSafeInteger(page.nextOffset) || (page.nextOffset as number) <= (earlier?.offset ?? 0)) throw new ControlError('invalid-source');
      const token = randomUUID(); cursors.set(token, { key, offset: page.nextOffset as number, leaf, expires: Date.now() + 60000 }); result.nextCursor = token;
      for (const [id, entry] of cursors) if (entry.expires <= Date.now()) cursors.delete(id);
      while (cursors.size > 100) cursors.delete(cursors.keys().next().value!);
    }
    while (controlByteSize(result) > CONTROL_LIMITS.responseBytes) {
      const message = result.messages.find(item => item.text.length > 128);
      if (!message) throw new ControlError('invalid-source'); message.text = message.text.slice(0, Math.floor(message.text.length / 2)).replace(/[\ud800-\udbff]$/, ''); message.truncated = true;
    }
    return result;
  }
  const emit = (watch: Watch, event: ControlConversationEvent) => { if (!watch.stopped) for (const listener of watch.listeners) listener(structuredClone(event)); };
  function failure(watch: Watch, error: unknown): void {
    const invalid = error instanceof ControlError && ['session-changed', 'invalid-target', 'scope-required', 'pairing-required'].includes(error.code);
    emit(watch, { target: watch.target, kind: invalid ? 'invalidated' : 'unavailable', source: { state: 'stale', observedAt: Date.now() } });
  }
  async function refresh(watch: Watch): Promise<void> {
    if (watch.stopped) return;
    if (watch.pending) { watch.again = true; return; }
    watch.pending = true; const current = generation;
    try {
      const page = await history(watch.target);
      if (!watch.stopped && current === generation) emit(watch, { target: page.target, kind: 'messages', source: page.source, messages: page.messages });
    } catch (error) { if (current === generation) failure(watch, error); }
    finally { watch.pending = false; if (watch.again) { watch.again = false; void refresh(watch); } }
  }
  async function subscribe(watch: Watch): Promise<void> {
    const current = generation;
    try {
      await tasks.verifyTarget(watch.target);
      if (watch.stopped || current !== generation) return;
      const response = controlRecord(await gateway.request('sessions.messages.subscribe', { key: watch.target.sessionKey, agentId: watch.target.agentId, subscriptionId: watch.subscriptionId }));
      if (!response || response.subscribed !== true || response.key !== watch.target.sessionKey || response.agentId !== watch.target.agentId) throw new ControlError('unsupported');
      if (watch.stopped || current !== generation) {
        if (current === generation) void gateway.request('sessions.messages.unsubscribe', { key: watch.target.sessionKey, agentId: watch.target.agentId, subscriptionId: watch.subscriptionId }).catch(() => {});
        return;
      }
      watch.subscribed = true;
    } catch (error) { if (current === generation) failure(watch, error); }
  }
  const off = gateway.onEvent(event => {
    if (event.event === 'source.invalidated') {
      generation++; cursors.clear(); for (const watch of watches.values()) { watch.subscribed = false; emit(watch, { target: watch.target, kind: 'unavailable', source: { state: 'stale', observedAt: Date.now() } }); } return;
    }
    if (event.event === 'source.ready') { for (const watch of watches.values()) void subscribe(watch).then(() => refresh(watch)); return; }
    if (!['session.message', 'sessions.changed'].includes(event.event)) return;
    const payload = controlRecord(event.payload); const nested = controlRecord(payload?.session); const key = payload?.sessionKey ?? nested?.key;
    for (const watch of watches.values()) {
      if (key !== watch.target.sessionKey || (payload?.agentId !== undefined && payload.agentId !== watch.target.agentId)
        || (payload?.sessionId !== undefined && payload.sessionId !== watch.target.sessionId)) continue;
      // Events are hints only. Re-read through canonical membership and text projection.
      void refresh(watch);
    }
  });
  return {
    history,
    watch(target, listener) {
      if (closed || !parseControlTarget(target)) throw new ControlError('invalid-target');
      const key = identity(target); let watch = watches.get(key);
      if (!watch) {
        if (watches.size >= 100) throw new ControlError('rate-limited');
        watch = { target: structuredClone(target), listeners: new Set(), subscriptionId: randomUUID(), generation, stopped: false, pending: false, again: false, subscribed: false }; watches.set(key, watch);
        void subscribe(watch);
      }
      watch.listeners.add(listener); const current = watch;
      return () => { current.listeners.delete(listener); if (current.listeners.size) return; current.stopped = true; watches.delete(key);
        if (current.subscribed) void gateway.request('sessions.messages.unsubscribe', { key: target.sessionKey, agentId: target.agentId, subscriptionId: current.subscriptionId }).catch(() => {});
      };
    },
    close() { closed = true; generation++; off(); cursors.clear(); for (const watch of watches.values()) watch.stopped = true; watches.clear(); },
  };
}

export function mountControlNamespace(io: Server, options: {
  config: ControlConfig; tasks: TaskService; conversations: ConversationService;
  originAllowed(origin: string | undefined): boolean;
  trustProxy?: (address: string, hop: number) => boolean;
}): () => void {
  const namespace = io.of('/control'); const access = createControlAccess(options.config);
  namespace.use((socket, next) => {
    if (!options.originAllowed(socket.handshake.headers.origin)) { next(Error('Private conversation origin rejected')); return; }
    const req = socket.request; const peer = req.socket.remoteAddress ?? '';
    const forwarded = req.headers['x-forwarded-proto'];
    const secure = ('encrypted' in req.socket && req.socket.encrypted === true)
      || (options.trustProxy?.(peer, 0) === true && typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https');
    const auth = controlRecord(socket.handshake.auth); const token = auth?.token;
    const adapted = { socket: req.socket, secure, ip: peer, headers: { ...req.headers, authorization: typeof token === 'string' ? `Bearer ${token}` : undefined } };
    const response = { setHeader() {}, status() { return response; }, json() { next(Error('Private conversation access rejected')); } };
    access(adapted as Request, response as unknown as Response, () => next());
  });
  namespace.on('connection', socket => {
    let stop: (() => void) | undefined; let revision = 0; let attempts = 0; let started = Date.now();
    socket.on('watch', (value: unknown, ack?: (value: { ok: boolean }) => void) => {
      const current = ++revision; stop?.(); stop = undefined;
      if (Date.now() - started >= 60000) { started = Date.now(); attempts = 0; }
      const input = controlRecord(value); const target = input && typeof input.agentId === 'string' ? parseTaskRequest(input.agentId, input) : null;
      if (!target || 'cursor' in target || ++attempts > 30) { if (typeof ack === 'function') ack({ ok: false }); return; }
      void options.tasks.verifyTarget(target).then(() => {
        if (current !== revision || !socket.connected) return;
        stop = options.conversations.watch(target, event => socket.emit('conversation', event));
        if (typeof ack === 'function') ack({ ok: true });
      }).catch(() => { if (current === revision && typeof ack === 'function') ack({ ok: false }); });
    });
    socket.on('unwatch', () => { revision++; stop?.(); stop = undefined; });
    socket.on('disconnect', () => { revision++; stop?.(); stop = undefined; });
  });
  return () => { namespace.disconnectSockets(true); namespace.removeAllListeners(); };
}
