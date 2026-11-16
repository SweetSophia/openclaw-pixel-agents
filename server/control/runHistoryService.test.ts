// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createRunHistoryService } from './runHistoryService';
import type { ControlGateway, GatewayEvent } from './gatewayClient';
import { GatewayRequestError } from './gatewayClient';
import { createTaskService } from './taskService';
import { CONTROL_LIMITS, parseControlTarget } from '../../shared/control';
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 'session-1' };
function fixture() {
  let row: Record<string, unknown> = { ...target, key: target.sessionKey, hasActiveRun: false, lastRunId: 'latest', status: 'completed', activeLeafEntryId: 'leaf-1' };
  const listeners = new Set<(event: GatewayEvent) => void>();
  let state: 'ready' | 'unavailable' | 'auth-error' = 'ready';
  const pages = vi.fn(async (offset: number) => ({ sessionKey: String(row.key), sessionId: String(row.sessionId), sessionInfo: row,
    messages: [{ role: 'user', content: `Prompt ${offset}`, __openclaw: { id: `user-${offset}`, runId: offset ? 'older' : 'latest' } },
      { role: 'assistant', content: `Response ${offset}`, stopReason: 'stop', __openclaw: { id: `answer-${offset}`, runId: offset ? 'older' : 'latest' } }], nextOffset: offset + 50, hasMore: offset < 200 }));
  const rpc = vi.fn<ControlGateway['request']>(async (method, params) => { if (state !== 'ready') throw new GatewayRequestError(state === 'auth-error' ? 'scope-required' : 'unavailable'); return method === 'sessions.describe' ? { session: row } : method === 'chat.history' ? pages(Number(params.offset)) : {}; });
  const gateway: ControlGateway = { request: rpc, start() {}, close() {}, status: () => ({ configured: true, state, canRead: state === 'ready', canSend: state === 'ready' }), onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const tasks = createTaskService(gateway, () => new Set(['cylena'])); const history = createRunHistoryService(gateway, tasks);
  return { history, tasks, pages, rpc, status: (value: typeof state) => { state = value; }, row: (change: object) => { row = { ...row, ...change }; }, event: (event: GatewayEvent) => listeners.forEach(fn => fn(event)) };
}
function historyLeafFixture(initial: unknown = 'leaf-1') {
  const f = fixture(); f.row({ activeLeafEntryId: undefined }); let leaf = initial;
  const pages = f.pages.getMockImplementation()!;
  f.pages.mockImplementation(async offset => {
    const page = await pages(offset);
    return { ...page, sessionInfo: { ...page.sessionInfo, ...(offset === 0 ? { activeLeafEntryId: leaf } : {}) },
      ...(leaf === null ? { messages: [], hasMore: false } : {}) };
  });
  const rpc = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (method, params, signal) => {
    const page = await rpc(method, params, signal);
    if (method !== 'chat.history' || params.limit !== 1) return page;
    const result = page as { messages: unknown[] }; return { ...result, messages: result.messages.slice(-1) };
  });
  return { ...f, leaf: (value: unknown) => { leaf = value; } };
}
describe('bounded historical run selection', () => {
  it('reads and selects history when native descriptions omit the leaf provided only by the history head', async () => {
    const f = historyLeafFixture();
    const page = await f.history.read(target);
    expect(page).toMatchObject({ target: { ...target, activeLeafEntryId: 'leaf-1' }, source: { state: 'current' }, loadedRecords: 8 });
    expect(page.runs.map(run => run.runId)).toEqual(['latest', 'older']); expect(page.nextCursor).toBeTruthy();
    const selected = await f.history.read({ ...target, runId: 'older' });
    expect(selected.task).toMatchObject({ runId: 'older', requestAssociation: 'run' }); expect(selected.messages.length).toBeGreaterThan(0);
    f.history.close(); f.tasks.close();
  });
  it('accepts a native null leaf for an empty transcript without emitting null in the browser target', async () => {
    const f = historyLeafFixture(null); const page = await f.history.read(target);
    expect(page).toMatchObject({ target, source: { state: 'current' }, loadedRecords: 0, runs: [] });
    expect(page.target.activeLeafEntryId).toBeUndefined(); expect(page.nextCursor).toBeUndefined();
    f.history.close(); f.tasks.close();
  });
  it('never issues an offset cursor for nonempty history with a native null leaf', async () => {
    const f = historyLeafFixture(null); const pages = f.pages.getMockImplementation()!;
    f.pages.mockImplementation(async offset => ({ ...await pages(offset), messages: [{ role: 'user', content: 'retained transcript', __openclaw: { id: 'retained', runId: 'recorded' } }], hasMore: true }));
    await expect(f.history.read(target)).rejects.toMatchObject({ code: 'unsupported' });
    expect(f.pages.mock.calls.every(([offset]) => offset === 0)).toBe(true);
    f.history.close(); f.tasks.close();
  });
  it.each(['branch', 'auth', 'source'] as const)('fences %s invalidation during the final history-head verification', async reason => {
    const f = historyLeafFixture(); const pages = f.pages.getMockImplementation()!; let heads = 0;
    f.pages.mockImplementation(async offset => {
      const page = await pages(offset);
      if (offset === 0 && ++heads === 2) {
        if (reason === 'branch') f.event({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey, reason: 'branch-switch' } });
        else { f.status(reason === 'auth' ? 'auth-error' : 'unavailable'); f.event({ event: 'source.invalidated', payload: null }); }
      }
      return page;
    });
    await expect(f.history.read(target)).rejects.toMatchObject({ code: reason === 'source' ? 'unavailable' : 'session-changed' });
    expect(heads).toBe(2); f.history.close(); f.tasks.close();
  });
  it('checks a history-only leaf before offset continuation and refreshes appended choices without changing stable identity', async () => {
    const f = historyLeafFixture(); const page = await f.history.read(target); expect(page.nextCursor).toBeTruthy();
    f.leaf('leaf-2');
    await expect(f.history.read({ ...target, cursor: page.nextCursor })).rejects.toMatchObject({ code: 'session-changed' });
    const fresh = await f.history.read(target); expect(fresh.target).toEqual({ ...target, activeLeafEntryId: 'leaf-2' }); expect(fresh.source.state).toBe('current');
    f.history.close(); f.tasks.close();
  });
  it('rejects a history-only leaf changing across automatic page reads', async () => {
    const f = historyLeafFixture(); const pages = f.pages.getMockImplementation()!;
    f.pages.mockImplementation(async offset => { const page = await pages(offset); if (offset === 50) f.leaf('leaf-2'); return page; });
    await expect(f.history.read(target)).rejects.toMatchObject({ code: 'session-changed' });
    expect(f.pages.mock.calls.some(([offset]) => offset === 50)).toBe(true);
    f.history.close(); f.tasks.close();
  });
  it('fails closed when neither descriptions nor history can bind an offset window to a leaf', async () => {
    const f = historyLeafFixture(undefined); f.leaf(undefined);
    await expect(f.history.read(target)).rejects.toMatchObject({ code: 'unsupported' });
    f.history.close(); f.tasks.close();
  });
  it('keeps a complete single-page transcript usable without issuing an unbound continuation', async () => {
    const f = historyLeafFixture(); f.leaf(undefined); const pages = f.pages.getMockImplementation()!;
    f.pages.mockImplementation(async offset => ({ ...await pages(offset), hasMore: false }));
    const page = await f.history.read(target); expect(page.loadedRecords).toBe(2); expect(page.source.state).toBe('current'); expect(page.nextCursor).toBeUndefined();
    f.history.close(); f.tasks.close();
  });
  it('reserves space for native envelope metadata without raising the complete-response byte cap', async () => {
    const f = fixture(); const rpc = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (method, params, signal) => {
      if (method !== 'chat.history') return rpc(method, params, signal);
      return { sessionKey: target.sessionKey, sessionId: target.sessionId, sessionInfo: { activeLeafEntryId: 'leaf-1' }, hasMore: false,
        defaults: { metadata: 'm'.repeat(2048) }, messages: [{ role: 'user', content: 'x'.repeat(Number(params.maxBytes) - 128), __openclaw: { runId: 'recorded' } }] };
    });
    const page = await f.history.read(target); expect(page.runs).toEqual([{ runId: 'recorded' }]); expect(page.loadedRecords).toBe(1);
    const narrow = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (method, params, signal) => method === 'chat.history' ? { ...await narrow(method, params, signal) as object, metadata: 'm'.repeat(CONTROL_LIMITS.responseBytes) } : narrow(method, params, signal));
    await expect(f.history.read({ ...target, refresh: true })).rejects.toMatchObject({ code: 'invalid-source' });
    f.history.close(); f.tasks.close();
  });
  it('rejects malformed history-head leaves before continuing an offset window', async () => {
    const f = historyLeafFixture(); const page = await f.history.read(target); f.leaf(42);
    await expect(f.history.read({ ...target, cursor: page.nextCursor })).rejects.toMatchObject({ code: 'invalid-source' });
    f.history.close(); f.tasks.close();
  });
  it('discovers only recorded run identities, selects exact messages, and never uses the latest outcome for an older run', async () => {
    const f = fixture(); f.row({ activeRunIds: ['live-run'] }); const page = await f.history.read(target);
    expect(page.runs.map(run => run.runId)).toEqual(['latest', 'older']); expect(f.pages).toHaveBeenCalledTimes(4);
    const selected = await f.history.read({ ...target, runId: 'older' });
    expect(selected.task).toMatchObject({ runId: 'older', runState: 'unknown', requestAssociation: 'run', request: { runId: 'older' }, latestResponse: { runId: 'older' } });
    expect(selected.task?.result).toBeUndefined(); expect(selected.task?.children).toEqual([]); expect(selected.task?.activeRunIds).toBeUndefined();
    expect((await f.history.read({ ...target, runId: 'missing' })).task).toBeUndefined();
    f.history.close(); f.tasks.close();
  });
  it('loads earlier through a leaf-bound cursor and invalidates historical proofs on a branch event', async () => {
    const f = fixture(); const page = await f.history.read(target); expect(page.nextCursor).toBeTruthy();
    await expect(f.history.read({ ...target, sessionId: 'other', cursor: page.nextCursor })).rejects.toMatchObject({ code: 'invalid-request' });
    f.row({ activeLeafEntryId: 'leaf-2' }); await expect(f.history.read({ ...target, cursor: page.nextCursor })).rejects.toMatchObject({ code: 'session-changed' });
    f.row({ activeLeafEntryId: 'leaf-1' }); const expanded = await f.history.read({ ...target, cursor: page.nextCursor }); expect(expanded.loadedRecords).toBe(10); expect(f.pages).toHaveBeenCalledTimes(5);
    f.event({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey, reason: 'branch-switch' } });
    await expect(f.history.task(target, 'older')).rejects.toMatchObject({ code: 'session-changed' }); f.history.close(); f.tasks.close();
  });
  it('keeps explicit discovery bounded to 50 more records and 2,000 cumulative records, without inventing identities for untagged rows', async () => {
    const f = fixture(); f.pages.mockImplementation(async offset => ({ sessionKey: target.sessionKey, sessionId: target.sessionId, sessionInfo: {},
      messages: Array.from({ length: 50 }, (_, index) => ({ role: 'user', content: 'recorded prompt', __openclaw: { id: `record-${offset + index}`, ...(index ? { runId: `run-${offset + index}` } : {}) } })), hasMore: true, nextOffset: offset + 50 } as never));
    let page = await f.history.read(target); expect(page.loadedRecords).toBe(200); expect(page.runs).toHaveLength(100); expect(page.runsTruncated).toBe(true);
    const oldSelection = await f.history.read({ ...target, runId: 'run-199' }); expect(oldSelection.runs).toHaveLength(100); expect(oldSelection.runs[oldSelection.runs.length - 1]?.runId).toBe('run-199'); expect(oldSelection.runsTruncated).toBe(true);
    while (page.nextCursor) { const before = f.pages.mock.calls.length; page = await f.history.read({ ...target, cursor: page.nextCursor }); expect(f.pages.mock.calls.length - before).toBe(1); }
    expect(page.loadedRecords).toBe(2000); expect(page.limitReached).toBe(true); expect(f.pages).toHaveBeenCalledTimes(40);
    f.history.close(); f.tasks.close();
  });
  it('retains original historical verification time on source loss and rejects revoked authority', async () => {
    const f = fixture(); const first = await f.history.read({ ...target, runId: 'older' }); f.status('unavailable');
    const retained = await f.history.read({ ...target, runId: 'older' }); expect(retained.source).toEqual({ ...first.source, state: 'stale' }); expect(retained.task?.runState).toBe('unknown');
    f.status('auth-error'); await expect(f.history.read({ ...target, runId: 'older' })).rejects.toMatchObject({ code: 'scope-required' });
    f.history.close(); f.tasks.close();
  });
  it('stops continuation at the private byte budget even before 2,000 source records', async () => {
    const f = fixture(); f.pages.mockImplementation(async offset => ({ sessionKey: target.sessionKey, sessionId: target.sessionId, sessionInfo: {},
      messages: Array.from({ length: 50 }, (_, index) => ({ role: 'user', content: 'x'.repeat(3000), __openclaw: { id: `record-${offset + index}`, runId: `run-${offset + index}` } })), hasMore: true, nextOffset: offset + 50 } as never));
    let page = await f.history.read(target); let actions = 0;
    while (page.nextCursor && actions++ < 40) page = await f.history.read({ ...target, cursor: page.nextCursor });
    expect(page.limitReached).toBe(true); expect(page.nextCursor).toBeUndefined(); expect(page.loadedRecords).toBeGreaterThan(200); expect(page.loadedRecords).toBeLessThan(2000); expect(actions).toBeLessThan(40);
    f.history.close(); f.tasks.close();
  });
  it('accepts a newly selected observed branch while rejecting conflicting native history metadata', async () => {
    const f = fixture(); f.event({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey, reason: 'branch-switch' } });
    const session = await f.tasks.resolveSession(target.agentId, target.sessionKey); const selected = parseControlTarget(session); expect(selected?.branchId).toMatch(/^observed-/);
    await expect(f.history.read(selected!)).resolves.toMatchObject({ target: { branchId: selected!.branchId } });
    const original = f.pages.getMockImplementation()!; f.pages.mockImplementation(async offset => ({ ...await original(offset), sessionInfo: { sessionId: 'replacement' } }));
    await expect(f.history.read({ ...selected!, refresh: true })).rejects.toMatchObject({ code: 'session-changed' }); f.history.close(); f.tasks.close();
  });
  it('never leaks private tool payloads or reasoning into the selected conversation or task', async () => {
    const f = fixture(); f.pages.mockImplementation(async () => ({ sessionKey: target.sessionKey, sessionId: target.sessionId, sessionInfo: {}, hasMore: false,
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'private fixture secret' }, { type: 'text', text: 'Visible response' }, { type: 'toolCall', name: 'read', id: 'call', arguments: { path: 'private fixture secret' } }], __openclaw: { runId: 'older' } },
        { role: 'system', content: 'private fixture secret', __openclaw: { runId: 'system-run' } }] } as never));
    const snapshot = await f.history.read({ ...target, runId: 'older' }); expect(snapshot.runs.map(run => run.runId)).toEqual(['older']); expect(snapshot.messages[0].text).toBe('Visible response'); expect(JSON.stringify(snapshot)).not.toContain('private fixture secret');
    f.history.close(); f.tasks.close();
  });
  it('uses an exact native audit terminal when available and preserves it as last known on optional-reader failure', async () => {
    const f = fixture(); const rpc = f.rpc.getMockImplementation()!; const recorded = { events: [{ eventType: 'agent_run', kind: 'agent_run', action: 'agent.run.finished', status: 'succeeded',
      agentId: target.agentId, sessionId: target.sessionId, sessionKey: target.sessionKey, runId: 'older', eventId: 'finished', sequence: 2, sourceSequence: 2, schemaVersion: 1, redaction: 'metadata_only', occurredAt: 50, actor: { type: 'agent', id: target.agentId } }] };
    f.rpc.mockImplementation((method, params, signal) => method === 'audit.activity.list' ? Promise.resolve(recorded) : rpc(method, params, signal));
    const snapshot = await f.history.read({ ...target, runId: 'older' }); expect(snapshot.task).toMatchObject({ runState: 'completed', endedAt: 50, result: { runId: 'older' } }); expect(snapshot.outcome?.state).toBe('recorded');
    expect(f.rpc.mock.calls.find(([method]) => method === 'audit.activity.list')?.[1]).toEqual({ agentId: target.agentId, sessionKey: target.sessionKey, runId: 'older', kind: 'agent_run', limit: 50 });
    f.rpc.mockImplementation((method, params, signal) => method === 'audit.activity.list' ? Promise.resolve({ events: [], nextCursor: 'incomplete' }) : rpc(method, params, signal));
    const insufficient = await f.history.read({ ...target, runId: 'older' }); expect(insufficient.task?.runState).toBe('completed'); expect(insufficient.outcome).toEqual(snapshot.outcome); expect(insufficient.source.state).toBe('current');
    f.rpc.mockImplementation((method, params, signal) => method === 'audit.activity.list' ? Promise.resolve(recorded) : rpc(method, params, signal));
    const refreshed = await f.history.read({ ...target, runId: 'older' }); expect(refreshed.source.state).toBe('current');
    f.rpc.mockImplementation((method, params, signal) => method === 'audit.activity.list' ? Promise.reject(new GatewayRequestError('unavailable')) : rpc(method, params, signal));
    const retained = await f.history.read({ ...target, runId: 'older' }); expect(retained.task?.runState).toBe('completed'); expect(retained.source).toEqual(snapshot.source); expect(retained.outcome).toEqual(refreshed.outcome);
    f.rpc.mockImplementation((method, params, signal) => method === 'audit.activity.list' ? Promise.resolve(recorded) : rpc(method, params, signal));
    expect((await f.history.read({ ...target, runId: 'older' })).source.state).toBe('current');
    f.history.close(); f.tasks.close();
  });
  it('rejects a malformed native leaf with a typed source error', async () => {
    const f = fixture(); f.row({ activeLeafEntryId: 'x'.repeat(300) });
    await expect(f.history.read({ ...target, refresh: true })).rejects.toMatchObject({ code: 'invalid-source' });
    f.history.close(); f.tasks.close();
  });
  it('keeps history usable when optional audit outcomes are unsupported', async () => {
    const f = fixture(); const rpc = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((method, params, signal) => method === 'audit.activity.list' ? Promise.reject(new GatewayRequestError('unsupported')) : rpc(method, params, signal));
    const snapshot = await f.history.read({ ...target, runId: 'older' });
    expect(snapshot).toMatchObject({ source: { state: 'current' }, selectedRunId: 'older', outcome: { state: 'unsupported' }, task: { runId: 'older' } });
    expect(snapshot.messages.length).toBeGreaterThan(0); f.history.close(); f.tasks.close();
  });
  it('bounds private windows to eight selections and rebuilds expired windows', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const f = fixture(); const selections = Array.from({ length: 9 }, (_, index) => ({
      agentId: target.agentId, sessionKey: `agent:cylena:selection-${index}`, sessionId: `session-${index}`,
    }));
    for (const [index, selected] of selections.entries()) {
      f.row({ ...selected, key: selected.sessionKey, hasActiveRun: false, activeLeafEntryId: `leaf-${index}` }); await f.history.read(selected);
    }
    const beforeEvicted = f.pages.mock.calls.length; const first = selections[0];
    f.row({ ...first, key: first.sessionKey, hasActiveRun: false, activeLeafEntryId: 'leaf-0' }); await f.history.read(first);
    expect(f.pages.mock.calls.length - beforeEvicted).toBe(4);
    vi.setSystemTime(61001); const beforeExpired = f.pages.mock.calls.length; const newest = selections[8];
    f.row({ ...newest, key: newest.sessionKey, hasActiveRun: false, activeLeafEntryId: 'leaf-8' }); await f.history.read(newest);
    expect(f.pages.mock.calls.length - beforeExpired).toBe(4); f.history.close(); f.tasks.close(); vi.useRealTimers();
  });
});
