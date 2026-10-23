// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayRequestError, type ControlGateway, type GatewayEvent } from './gatewayClient';
import { createTaskService } from './taskService';

const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 'session-1', lifecycleRevision: 'lifecycle-1' };
function fixture() {
  let gatewayState: 'ready' | 'auth-error' | 'pairing-required' = 'ready';
  let row = { ...target, key: target.sessionKey, hasActiveRun: true, activeLeafEntryId: 'leaf-1', snapshotAt: 100 } as Record<string, unknown>;
  let listener: (event: GatewayEvent) => void = () => {};
  const history = vi.fn(async (offset: number) => ({
    sessionKey: target.sessionKey, sessionId: target.sessionId, sessionInfo: row,
    messages: offset < 150 ? Array.from({ length: 50 }, (_, i) => ({ role: 'assistant', content: [{ type: 'toolCall', id: `call-${offset + i}`, name: 'read' }], __openclaw: { runId: 'run-1' } }))
      : [{ role: 'user', content: 'Please check the fixture', __openclaw: { id: 'request-1', runId: 'run-1' } }],
    inFlightRun: { runId: 'run-1' }, offset, nextOffset: offset + 50, hasMore: true, totalMessages: 3000,
  }));
  const rpc = vi.fn<ControlGateway['request']>(async (method, params) => {
    if (method === 'sessions.list') return { ts: 100, sessions: [row], count: 1 };
    if (method === 'sessions.describe') return { session: row };
    if (method === 'chat.history') return history(Number(params.offset ?? 0));
    return {};
  });
  const gateway: ControlGateway = { start() {}, close() {}, status: () => ({ configured: true, state: gatewayState, canRead: gatewayState === 'ready', canSend: false }), request: rpc,
    onEvent(callback) { listener = callback; return () => { listener = () => {}; }; } };
  const tasks = createTaskService(gateway, () => new Set(['cylena']));
  return { tasks, rpc, history, setStatus: (state: typeof gatewayState) => { gatewayState = state; }, setRow: (next: Record<string, unknown>) => { row = { ...row, ...next }; }, event: (event: GatewayEvent) => listener(event) };
}
afterEach(() => vi.useRealTimers());
describe('verified task reads', () => {
  it('lists only canonically owned registered sessions and keeps list cursors agent-bound', async () => {
    const f = fixture(); expect((await f.tasks.listSessions('cylena')).sessions[0]).toMatchObject(target);
    await expect(f.tasks.listSessions('other')).rejects.toMatchObject({ code: 'invalid-target' });
    f.setRow({ key: 'agent:other:fixture' }); expect((await f.tasks.listSessions('cylena')).sessions).toEqual([]);
    f.tasks.close();
  });
  it('rechecks canonical identity before history and fences resets but accepts appends', async () => {
    const f = fixture();
    for (const patch of [{ sessionId: 'replacement' }, { lifecycleRevision: 'lifecycle-2' }, { branchId: 'changed' }]) {
      f.setRow({ ...target, ...patch });
      await expect(f.tasks.getTask({ ...target, branchId: 'original' })).rejects.toMatchObject({ code: 'session-changed' });
      expect(f.history).not.toHaveBeenCalled();
    }
    f.setRow({ ...target, branchId: undefined, activeLeafEntryId: 'leaf-2' });
    expect((await f.tasks.getTask({ ...target, activeLeafEntryId: 'leaf-1' })).target.activeLeafEntryId).toBe('leaf-2'); f.tasks.close();
  });
  it('requires canonical owner proof for ambiguous keys and rejects conflicts', async () => {
    const f = fixture();
    f.setRow({ agentId: 'other' }); await expect(f.tasks.getTask(target)).rejects.toMatchObject({ code: 'invalid-target' });
    f.setRow({ agentId: undefined, key: 'global' }); await expect(f.tasks.getTask({ ...target, sessionKey: 'global' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(f.history).not.toHaveBeenCalled(); f.tasks.close();
  });
  it('seeks fifty records at a time up to 200, keeping actual recent activity', async () => {
    const f = fixture(); const task = await f.tasks.getTask(target);
    expect(f.history.mock.calls.map(args => args[0])).toEqual([0, 50, 100, 150]);
    expect(task).toMatchObject({ loadedRecords: 200, requestAssociation: 'run', runId: 'run-1' });
    expect(task.request?.text).toBe('Please check the fixture'); expect(task.activity).toHaveLength(50); f.tasks.close();
  });
  it('continues through bounded opaque cursors, refusing a cross-target or expired cursor', async () => {
    const f = fixture(); f.history.mockImplementation(async offset => ({ sessionKey: target.sessionKey, sessionId: target.sessionId, sessionInfo: {}, messages: [], inFlightRun: { runId: 'run-1' }, offset, nextOffset: offset + 50, hasMore: true, totalMessages: 3000 }));
    let task = await f.tasks.getTask(target); expect(task).toMatchObject({ loadedRecords: 200, requestState: 'not-loaded' });
    expect(task.nextCursor).toBeTruthy();
    const calls = f.history.mock.calls.length; task = await f.tasks.getTask({ ...target, cursor: task.nextCursor });
    expect(task.loadedRecords).toBe(250); expect(f.history.mock.calls.length - calls).toBe(1);
    await expect(f.tasks.getTask({ ...target, sessionKey: 'agent:cylena:another', cursor: task.nextCursor })).rejects.toThrow();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 61000);
    await expect(f.tasks.getTask({ ...target, cursor: task.nextCursor })).rejects.toMatchObject({ code: 'invalid-request' }); f.tasks.close();
  });
  it('coalesces reads, reuses for two seconds and retains same-target stale facts on source loss', async () => {
    const f = fixture(); const [a, b] = await Promise.all([f.tasks.getTask(target), f.tasks.getTask(target)]);
    expect(a).toEqual(b); expect(f.history).toHaveBeenCalledTimes(4);
    await f.tasks.getTask(target); expect(f.history).toHaveBeenCalledTimes(4);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 2100); f.rpc.mockRejectedValue(Error('fixture-private-diagnostic'));
    const stale = await f.tasks.getTask(target); expect(stale.source).toEqual({ ...a.source, state: 'stale' }); expect(stale.runState).toBe('running');
    expect(JSON.stringify(stale)).not.toContain('fixture-private');
    vi.setSystemTime(Date.now() + 61000); await expect(f.tasks.getTask(target)).rejects.toMatchObject({ code: 'unavailable' }); f.tasks.close();
  });
  it('invalidates caches on source changes and never serves cached data for a known reset', async () => {
    const f = fixture(); await f.tasks.getTask(target); f.event({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey } });
    await f.tasks.getTask(target); expect(f.history.mock.calls.length).toBeGreaterThan(4);
    f.setRow({ sessionId: 'replacement' }); f.event({ event: 'sessions.changed', payload: { reason: 'reset', sessionKey: target.sessionKey } });
    await expect(f.tasks.getTask(target)).rejects.toMatchObject({ code: 'session-changed' }); f.tasks.close();
  });
  it('caps explicit discovery at 2000 records without manufacturing a request', async () => {
    const f = fixture(); f.history.mockImplementation(async offset => ({ sessionKey: target.sessionKey, sessionId: target.sessionId, sessionInfo: {}, messages: [], inFlightRun: { runId: 'run-1' }, offset, nextOffset: offset + 50, hasMore: true, totalMessages: 3000 }));
    let task = await f.tasks.getTask(target);
    while (task.nextCursor) task = await f.tasks.getTask({ ...target, cursor: task.nextCursor });
    expect(task.loadedRecords).toBe(2000); expect(task.requestState).toBe('limit-reached'); expect(task.request).toBeUndefined(); f.tasks.close();
  });
  it('invalidates an offset cursor on append without replacing the selected conversation', async () => {
    const f = fixture(); const task = await f.tasks.getTask(target);
    f.setRow({ activeLeafEntryId: 'leaf-2' });
    await expect(f.tasks.getTask({ ...target, cursor: task.nextCursor })).rejects.toMatchObject({ code: 'invalid-request' });
    expect((await f.tasks.getTask(target)).target.sessionId).toBe(target.sessionId); f.tasks.close();
  });
  it('shares a source read until the final attached requester aborts', async () => {
    const f = fixture(); let upstream: AbortSignal | undefined;
    f.rpc.mockImplementation((_method, _params, signal) => { upstream = signal; return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Error('cancelled')))); });
    const a = new AbortController(); const b = new AbortController();
    const first = f.tasks.getTask(target, a.signal).catch(error => error);
    const second = f.tasks.getTask(target, b.signal).catch(error => error);
    a.abort(); await first; expect(upstream?.aborted).toBe(false);
    b.abort(); await second; expect(upstream?.aborted).toBe(true); f.tasks.close();
  });
  it('excludes unproven child lineage and labels a paginated subset', async () => {
    const f = fixture(); const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (method, params, signal) => method === 'sessions.list' && params.spawnedBy ? {
      sessions: [{ ...target, key: 'agent:cylena:child', sessionId: 'child-1', spawnedBy: target.sessionKey },
        { ...target, key: 'agent:cylena:unrelated', sessionId: 'child-2', spawnedBy: 'another-parent' }], hasMore: true,
    } : original(method, params, signal));
    const task = await f.tasks.getTask(target); expect(task.children).toHaveLength(1); expect(task.childrenComplete).toBe(false); f.tasks.close();
  });
  it('drops cached private data if the source revokes read permission', async () => {
    const f = fixture(); await f.tasks.getTask(target);
    f.event({ event: 'sessions.changed', payload: {} }); f.rpc.mockRejectedValue(new GatewayRequestError('scope-required'));
    await expect(f.tasks.getTask(target)).rejects.toMatchObject({ code: 'scope-required' }); f.tasks.close();
  });
  it('does not use outage fallback after a reconnect confirms revoked Gateway authority', async () => {
    const f = fixture(); await f.tasks.getTask(target);
    f.setStatus('auth-error'); f.event({ event: 'source.invalidated', payload: null }); f.rpc.mockRejectedValue(Error('Disconnected'));
    await expect(f.tasks.getTask(target)).rejects.toMatchObject({ code: 'scope-required' }); f.tasks.close();
  });
  it('bounds session pagination and evicts old cached snapshots beyond 100', async () => {
    const f = fixture();
    f.rpc.mockImplementation(async (method, params) => {
      const key = String(params.key ?? params.sessionKey ?? target.sessionKey);
      if (method === 'sessions.describe') return { session: { ...target, key, hasActiveRun: false } };
      if (method === 'chat.history') return { sessionKey: key, sessionId: target.sessionId, messages: [], hasMore: false };
      if (method === 'sessions.list' && !params.spawnedBy) return { sessions: Array.from({ length: 25 }, (_, i) => ({ ...target, key: `agent:cylena:${Number(params.offset) + i}` })), hasMore: true };
      return { sessions: [], hasMore: false };
    });
    const page = await f.tasks.listSessions('cylena'); expect(page.sessions).toHaveLength(25);
    expect((await f.tasks.listSessions('cylena', page.nextCursor)).sessions[0].sessionKey).toBe('agent:cylena:25');
    await expect(f.tasks.listSessions('cylena', `${page.nextCursor}tampered`)).rejects.toMatchObject({ code: 'invalid-request' });
    for (let i = 0; i < 101; i++) await f.tasks.getTask({ ...target, sessionKey: `agent:cylena:${i}` });
    f.rpc.mockRejectedValue(Error('offline'));
    await expect(f.tasks.getTask({ ...target, sessionKey: 'agent:cylena:0' })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await f.tasks.getTask({ ...target, sessionKey: 'agent:cylena:100' })).source.state).toBe('stale'); f.tasks.close();
  });
  it('preserves opaque Gateway lifecycle revisions through selection and history', async () => {
    const f = fixture(); f.setRow({ lifecycleRevision: 'lifecycle-fixture-uuid' });
    const selected = (await f.tasks.listSessions('cylena')).sessions[0];
    expect(selected.lifecycleRevision).toBe('lifecycle-fixture-uuid');
    expect((await f.tasks.getTask(selected)).target.lifecycleRevision).toBe('lifecycle-fixture-uuid'); f.tasks.close();
  });
  it('continues from the history leaf when describe omits that field', async () => {
    const f = fixture(); const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (method, params, signal) => {
      const value = await original(method, params, signal);
      if (method !== 'sessions.describe') return value;
      const result = value as { session: Record<string, unknown> }; return { ...result, session: { ...result.session, activeLeafEntryId: undefined } };
    });
    const initial = await f.tasks.getTask(target);
    expect((await f.tasks.getTask({ ...target, cursor: initial.nextCursor })).loadedRecords).toBe(250); f.tasks.close();
  });
  it('renders a genuine empty transcript whose authoritative active leaf is null', async () => {
    const f = fixture(); f.setRow({ activeLeafEntryId: undefined, hasActiveRun: false });
    f.history.mockImplementation(async () => ({ sessionKey: target.sessionKey, sessionId: target.sessionId, sessionInfo: { activeLeafEntryId: null }, messages: [], inFlightRun: undefined, hasMore: false } as never));
    const task = await f.tasks.getTask(target); expect(task.request).toBeUndefined(); expect(task.requestState).toBe('unavailable'); expect(task.target.activeLeafEntryId).toBeUndefined(); f.tasks.close();
  });
  it('keeps a request discovered beyond 200 records through the next tail refresh', async () => {
    const f = fixture(); const original = f.history.getMockImplementation()!;
    f.history.mockImplementation(async offset => offset === 150 ? { ...(await original(offset)), messages: [] } : original(offset));
    const initial = await f.tasks.getTask(target); expect(initial.request).toBeUndefined();
    const expanded = await f.tasks.getTask({ ...target, cursor: initial.nextCursor }); expect(expanded.requestAssociation).toBe('run');
    f.event({ event: 'sessions.changed', payload: {} });
    const refreshed = await f.tasks.getTask(target); expect(refreshed.request?.id).toBe(expanded.request?.id); expect(refreshed.loadedRecords).toBeGreaterThanOrEqual(250); f.tasks.close();
  });
  it('fences the old target and its cursors after the actual branch-switch event', async () => {
    const f = fixture(); const initial = await f.tasks.getTask(target);
    f.event({ event: 'sessions.changed', payload: { reason: 'branch-switch', agentId: target.agentId, sessionKey: target.sessionKey } });
    await expect(f.tasks.getTask(target)).rejects.toMatchObject({ code: 'session-changed' });
    await expect(f.tasks.getTask({ ...target, cursor: initial.nextCursor })).rejects.toThrow();
    const selected = (await f.tasks.listSessions('cylena')).sessions[0]; expect(selected.branchId).toBeTruthy();
    expect((await f.tasks.getTask(selected)).target).toMatchObject({ sessionId: selected.sessionId, branchId: selected.branchId }); f.tasks.close();
  });
});
