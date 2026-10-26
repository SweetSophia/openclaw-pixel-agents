// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createRunHistoryService } from './runHistoryService';
import type { ControlGateway, GatewayEvent } from './gatewayClient';
import { GatewayRequestError } from './gatewayClient';
import { createTaskService } from './taskService';
import { parseControlTarget } from '../../shared/control';
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 'session-1' };
function fixture() {
  let row: Record<string, unknown> = { ...target, key: target.sessionKey, hasActiveRun: false, lastRunId: 'latest', status: 'completed', activeLeafEntryId: 'leaf-1' };
  const listeners = new Set<(event: GatewayEvent) => void>();
  let state: 'ready' | 'unavailable' | 'auth-error' = 'ready';
  const pages = vi.fn(async (offset: number) => ({ sessionKey: target.sessionKey, sessionId: target.sessionId, sessionInfo: row,
    messages: [{ role: 'user', content: `Prompt ${offset}`, __openclaw: { id: `user-${offset}`, runId: offset ? 'older' : 'latest' } },
      { role: 'assistant', content: `Response ${offset}`, stopReason: 'stop', __openclaw: { id: `answer-${offset}`, runId: offset ? 'older' : 'latest' } }], nextOffset: offset + 50, hasMore: offset < 200 }));
  const rpc = vi.fn<ControlGateway['request']>(async (method, params) => { if (state !== 'ready') throw new GatewayRequestError(state === 'auth-error' ? 'scope-required' : 'unavailable'); return method === 'sessions.describe' ? { session: row } : method === 'chat.history' ? pages(Number(params.offset)) : {}; });
  const gateway: ControlGateway = { request: rpc, start() {}, close() {}, status: () => ({ configured: true, state, canRead: state === 'ready', canSend: state === 'ready' }), onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const tasks = createTaskService(gateway, () => new Set(['cylena'])); const history = createRunHistoryService(gateway, tasks);
  return { history, tasks, pages, rpc, status: (value: typeof state) => { state = value; }, row: (change: object) => { row = { ...row, ...change }; }, event: (event: GatewayEvent) => listeners.forEach(fn => fn(event)) };
}
describe('bounded historical run selection', () => {
  it('discovers only recorded run identities, selects exact messages, and never uses the latest outcome for an older run', async () => {
    const f = fixture(); const page = await f.history.read(target);
    expect(page.runs.map(run => run.runId)).toEqual(['latest', 'older']); expect(f.pages).toHaveBeenCalledTimes(4);
    const selected = await f.history.read({ ...target, runId: 'older' });
    expect(selected.task).toMatchObject({ runId: 'older', runState: 'unknown', requestAssociation: 'run', request: { runId: 'older' }, latestResponse: { runId: 'older' } });
    expect(selected.task?.result).toBeUndefined(); expect(selected.task?.children).toEqual([]);
    expect((await f.history.read({ ...target, runId: 'missing' })).task).toBeUndefined();
    f.history.close(); f.tasks.close();
  });
  it('loads earlier through a leaf-bound cursor and invalidates historical proofs on a branch event', async () => {
    const f = fixture(); const page = await f.history.read(target); expect(page.nextCursor).toBeTruthy();
    const expanded = await f.history.read({ ...target, cursor: page.nextCursor }); expect(expanded.loadedRecords).toBe(10); expect(f.pages).toHaveBeenCalledTimes(5);
    await expect(f.history.read({ ...target, sessionId: 'other', cursor: page.nextCursor })).rejects.toMatchObject({ code: 'invalid-request' });
    f.row({ activeLeafEntryId: 'leaf-2' }); await expect(f.history.read({ ...target, cursor: page.nextCursor })).rejects.toMatchObject({ code: 'invalid-request' });
    f.event({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey, reason: 'branch-switch' } });
    await expect(f.history.task(target, 'older')).rejects.toMatchObject({ code: 'session-changed' }); f.history.close(); f.tasks.close();
  });
  it('keeps explicit discovery bounded to 50 more records and 2,000 cumulative records, without inventing identities for untagged rows', async () => {
    const f = fixture(); f.pages.mockImplementation(async offset => ({ sessionKey: target.sessionKey, sessionId: target.sessionId, sessionInfo: {},
      messages: Array.from({ length: 50 }, (_, index) => ({ role: 'user', content: 'recorded prompt', __openclaw: { id: `record-${offset + index}`, ...(index ? { runId: `run-${offset + index}` } : {}) } })), hasMore: true, nextOffset: offset + 50 } as never));
    let page = await f.history.read(target); expect(page.loadedRecords).toBe(200); expect(page.runs).toHaveLength(100); expect(page.runsTruncated).toBe(true);
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
    const f = fixture(); const rpc = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((method, params, signal) => method === 'audit.activity.list' ? Promise.resolve({ events: [{ eventType: 'agent_run', kind: 'agent_run', action: 'agent.run.finished', status: 'succeeded',
      agentId: target.agentId, sessionId: target.sessionId, sessionKey: target.sessionKey, runId: 'older', eventId: 'finished', sequence: 2, sourceSequence: 2, schemaVersion: 1, redaction: 'metadata_only', occurredAt: 50, actor: { type: 'agent', id: target.agentId } }] }) : rpc(method, params, signal));
    const snapshot = await f.history.read({ ...target, runId: 'older' }); expect(snapshot.task).toMatchObject({ runState: 'completed', endedAt: 50, result: { runId: 'older' } }); expect(snapshot.outcome?.state).toBe('recorded');
    expect(f.rpc.mock.calls.find(([method]) => method === 'audit.activity.list')?.[1]).toEqual({ agentId: target.agentId, sessionKey: target.sessionKey, runId: 'older', kind: 'agent_run', limit: 50 });
    f.rpc.mockImplementation((method, params, signal) => method === 'audit.activity.list' ? Promise.reject(new GatewayRequestError('unavailable')) : rpc(method, params, signal));
    const retained = await f.history.read({ ...target, runId: 'older' }); expect(retained.task?.runState).toBe('completed'); expect(retained.source).toEqual({ ...snapshot.source, state: 'stale' }); expect(retained.outcome).toEqual(snapshot.outcome);
    f.history.close(); f.tasks.close();
  });
});
