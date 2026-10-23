// @vitest-environment node
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationService, mountControlNamespace } from './conversation';
import { createTaskService } from './taskService';
import type { ControlGateway, GatewayEvent } from './gatewayClient';
import { loadControlConfig } from './config';
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 's1', lifecycleRevision: 'r1' };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for(const close of cleanups.splice(0).reverse()) await close(); });
function fixture() {
  const listeners = new Set<(event: GatewayEvent) => void>(); let sessionId = 's1'; let leaf = 'leaf1';
  const request = vi.fn<ControlGateway['request']>(async (method, p) => {
    if (method === 'sessions.describe') return { session: { ...target, key: target.sessionKey, sessionId } };
    if (method === 'chat.history') return { sessionKey: p.sessionKey, sessionId, sessionInfo: { activeLeafEntryId: leaf }, hasMore: p.offset !== 50, nextOffset: 50,
      messages: [{ role: 'system', content: 'system secret' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning secret' }, { type: 'toolCall', name: 'secret-tool', arguments: { password: 'secret' } }, { type: 'text', text: '<script>literal</script>' }], __openclaw: { id: 'a1', seq: 2 } }, { role: 'user', content: 'hello', __openclaw: { id: 'u1', seq: 1 } }] };
    return { subscribed: true, key: p.key, agentId: p.agentId };
  });
  const gateway: ControlGateway = { start() {}, close() {}, status: () => ({ configured: true, state: 'ready', canRead: true, canSend: true }), request, onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const tasks = createTaskService(gateway, () => new Set(['cylena'])); const conversations = createConversationService(gateway, tasks);
  cleanups.push(() => { conversations.close(); tasks.close(); });
  return { tasks, conversations, request, emit: (event: GatewayEvent) => listeners.forEach(listener => listener(event)), replace: () => { sessionId = 's2'; }, changeLeaf: () => { leaf = 'leaf2'; } };
}
describe('private conversation history and subscriptions', () => {
  it('projects only bounded text with leaf-bound explicit pagination', async () => {
    const f = fixture(); const page = await f.conversations.history(target);
    expect(page.messages.map(m => m.text)).toEqual(['<script>literal</script>', 'hello']);
    expect(JSON.stringify(page)).not.toMatch(/system secret|reasoning secret|secret-tool|password/);
    expect(page.target.activeLeafEntryId).toBe('leaf1'); expect(page.nextCursor).toBeTruthy();
    expect((await f.conversations.history(target, page.nextCursor)).nextCursor).toBeUndefined();
    f.changeLeaf(); await expect(f.conversations.history(target, page.nextCursor)).rejects.toMatchObject({ code: 'invalid-request' });
  });
  it('reference-counts subscriptions, refetches canonical text and rejects replaced targets', async () => {
    const f = fixture(); const a = vi.fn(); const b = vi.fn();
    const stopA = f.conversations.watch(target, a); const stopB = f.conversations.watch(target, b);
    await vi.waitFor(() => expect(f.request.mock.calls.filter(([m]) => m === 'sessions.messages.subscribe')).toHaveLength(1));
    f.emit({ event: 'session.message', payload: { sessionKey: 'agent:other:fixture', message: 'private secret' } }); await Promise.resolve(); expect(a).not.toHaveBeenCalled();
    f.emit({ event: 'session.message', payload: { sessionKey: target.sessionKey, agentId: target.agentId, sessionId: 's1' } });
    await vi.waitFor(() => expect(a).toHaveBeenCalledWith(expect.objectContaining({ kind: 'messages', messages: expect.any(Array) })));
    stopA(); expect(f.request.mock.calls.filter(([m]) => m === 'sessions.messages.unsubscribe')).toHaveLength(0);
    f.replace(); f.emit({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey, reason: 'reset' } });
    await vi.waitFor(() => expect(b).toHaveBeenCalledWith(expect.objectContaining({ kind: 'invalidated' })));
    stopB(); await vi.waitFor(() => expect(f.request.mock.calls.filter(([m]) => m === 'sessions.messages.unsubscribe')).toHaveLength(1));
  });
  it('fences pending reads on source generation changes and reconnects only verified targets', async () => {
    const f = fixture(); const events = vi.fn(); const stop = f.conversations.watch(target, events);
    await vi.waitFor(() => expect(f.request.mock.calls.some(([m]) => m === 'sessions.messages.subscribe')).toBe(true));
    f.emit({ event: 'source.invalidated', payload: null }); expect(events).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unavailable' }));
    f.replace(); f.emit({ event: 'source.ready', payload: null });
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ kind: 'invalidated' }))); stop();
  });
  it('authenticates a real private socket, validates membership and keeps public sockets empty', async () => {
    const f = fixture(); const server = createServer(); const io = new Server(server);
    const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'ws://localhost:18789', PIXEL_CONTROL_TOKEN: 'fixture-office-key' }, '/tmp/fixture');
    const dispose = mountControlNamespace(io, { config, tasks: f.tasks, conversations: f.conversations, originAllowed: origin => origin === 'http://fixture.test' });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error();
    cleanups.push(async () => { dispose(); await io.close(); });
    const sockets: Socket[] = []; cleanups.push(() => sockets.forEach(socket => socket.disconnect()));
    const socket = (token?: string, origin = 'http://fixture.test') => { const s = connect(`http://127.0.0.1:${address.port}/control`, { forceNew: true, reconnection: false, transports: ['websocket'], extraHeaders: { Origin: origin }, auth: { token } }); sockets.push(s); return s; };
    for(const [token, origin] of [[undefined, 'http://fixture.test'], ['wrong', 'http://fixture.test'], ['fixture-office-key', 'http://other.test']]) {
      const s = socket(token, origin); await new Promise<void>(resolve => s.once('connect_error', () => resolve())); expect(s.connected).toBe(false);
    }
    const s = socket('fixture-office-key'); await new Promise<void>(resolve => s.once('connect', resolve));
    const publicSocket = connect(`http://127.0.0.1:${address.port}`, { forceNew: true, reconnection: false, transports: ['websocket'] }); sockets.push(publicSocket);
    const publicEvents = vi.fn(); publicSocket.onAny(publicEvents); await new Promise<void>(resolve => publicSocket.once('connect', resolve));
    const bad = await s.timeout(1000).emitWithAck('watch', { ...target, agentId: 'other' }); expect(bad.ok).toBe(false);
    const ack = await s.timeout(1000).emitWithAck('watch', target); expect(ack.ok).toBe(true);
    const update = new Promise<unknown>(resolve => s.once('conversation', resolve));
    f.emit({ event: 'session.message', payload: { sessionKey: target.sessionKey } }); await update;
    expect(publicEvents).not.toHaveBeenCalled();
    s.disconnect(); await vi.waitFor(() => expect(f.request.mock.calls.some(([m]) => m === 'sessions.messages.unsubscribe')).toBe(true));
  });
});
