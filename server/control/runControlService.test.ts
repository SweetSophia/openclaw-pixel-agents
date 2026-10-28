// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseControlStatus, type ControlTaskSnapshot } from '../../shared/control';
import { currentDirectRun, parseControlStopReceipt, parseControlStopRequest } from '../../shared/controlRun';
import { createRunControlService } from './runControlService';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';
import { createTaskService, type TaskService } from './taskService';

const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 's1', lifecycleRevision: 'life1', branchId: 'branch1' };
const input = { target, runId: 'run1' };
const closers: (() => void)[] = [];
afterEach(() => { closers.splice(0).forEach(close => close()); vi.restoreAllMocks(); });
function fixture() {
  const snapshot: ControlTaskSnapshot = { target, source: { state: 'current', observedAt: Date.now() }, hasActiveRun: true,
    activeRunIds: ['run1'], runId: 'run1', runState: 'running', requestAssociation: 'unknown', requestState: 'unavailable',
    activity: [], children: [], childrenComplete: true, loadedRecords: 1 };
  const gateway: ControlGateway = { start() {}, close() {}, status: () => ({ configured: true, state: 'ready', canRead: true, canSend: true, canStop: true }),
    onEvent: () => () => {}, request: vi.fn(async () => ({ ok: true, aborted: true, runIds: ['run1'] })) };
  const tasks = { getTask: vi.fn(async () => structuredClone(snapshot)), verifyTarget: vi.fn(async () => ({ hasActiveRun: true, activeRunIds: ['run1'] })) } as unknown as TaskService;
  const controls = createRunControlService(gateway, tasks); closers.push(() => controls.close());
  return { snapshot, gateway, tasks, controls };
}
describe('exact-run Stop contract', () => {
  it('preserves older status responses but rejects Stop capability without read authority', () => {
    expect(parseControlStatus({ configured: true, state: 'ready', canRead: true, canSend: false })).not.toBeNull();
    expect(parseControlStatus({ configured: true, state: 'ready', canRead: true, canSend: false, canStop: true })?.canStop).toBe(true);
    expect(parseControlStatus({ configured: true, state: 'unavailable', canRead: false, canSend: false, canStop: true })).toBeNull();
    expect(parseControlStatus({ configured: true, state: 'ready', canRead: true, canSend: true, canStop: 'true' })).toBeNull();
  });
  it('rejects unknown fields at either level and malformed or bidi-spoofed run identifiers', () => {
    expect(parseControlStopRequest(input)).toEqual(input);
    for (const body of [{ ...input, clearQueued: true }, { ...input, target: { ...target, method: 'chat.abort' } },
      ...['', ' run1', 'run\n1', 'run\u202e1', 'run\u061c1', 'run\u20691', 'x'.repeat(257)].map(runId => ({ ...input, runId }))]) {
      expect(parseControlStopRequest(body)).toBeNull();
    }
    expect(parseControlStopReceipt({ ...input, phase: 'requested' })).toEqual({ ...input, phase: 'requested' });
    expect(parseControlStopReceipt({ ...input, phase: 'completed' })).toBeNull();
    expect(parseControlStopReceipt({ ...input, phase: 'unknown', clearQueued: true })).toBeNull();
  });
  it.each([['requested'], ['not-running'], ['unknown'], { toString: () => 'requested' }, null, 1, true])('rejects non-string receipt phases without coercion: %j', phase => {
    expect(parseControlStopReceipt({ ...input, phase })).toBeNull();
  });
  it('preserves only valid negotiated Stop denial reasons', () => {
    const status = { configured: true, state: 'ready', canRead: true, canSend: false, canStop: false };
    expect(parseControlStatus({ ...status, stopDisabledReason: 'unsupported' })?.stopDisabledReason).toBe('unsupported');
    expect(parseControlStatus({ ...status, stopDisabledReason: 'scope-required' })?.stopDisabledReason).toBe('scope-required');
    expect(parseControlStatus({ ...status, stopDisabledReason: 'other' })).toBeNull();
    expect(parseControlStatus({ ...status, canStop: true, stopDisabledReason: 'unsupported' })).toBeNull();
  });
  it('requires exactly one identified direct running run and enforces freshness and future-skew bounds', () => {
    const f = fixture(); const now = Date.now();
    for (const offset of [-15000, 5000]) expect(currentDirectRun({ ...f.snapshot, source: { state: 'current', observedAt: now + offset } }, now)).toBe('run1');
    for (const patch of [{ activeRunIds: undefined }, { activeRunIds: [] }, { activeRunIds: ['run1', 'run2'] }, { activeRunIds: ['other'] },
      { hasActiveRun: null }, { hasActiveRun: false }, { runState: 'completed' }, { runId: 'run\u200f1' },
      ...[-15001, 5001, NaN, Infinity].map(offset => ({ source: { state: 'current', observedAt: now + offset } })), { source: { state: 'stale', observedAt: now } }]) {
      expect(currentDirectRun({ ...f.snapshot, ...patch } as ControlTaskSnapshot, now)).toBeUndefined();
    }
  });
});
describe('exact-run Stop service', () => {
  it('performs a fresh unchanged read and final verification before sending only the exact canonical run', async () => {
    const f = fixture();
    expect(await f.controls.stop(input)).toEqual({ ...input, phase: 'requested' });
    expect(f.tasks.getTask).toHaveBeenCalledWith(target, expect.any(AbortSignal), { fresh: true, coalesce: false, requireUnchangedObservation: true });
    expect(f.tasks.verifyTarget).toHaveBeenCalledWith(target, expect.any(AbortSignal));
    expect(f.gateway.request).toHaveBeenCalledWith('chat.abort', { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', runId: 'run1' }, expect.any(AbortSignal));
  });
  it.each([{ runId: 'old-run' }, { source: { state: 'stale', observedAt: 1 } }, { activeRunIds: undefined }, { activeRunIds: ['run1', 'run2'] },
    { target: { ...target, sessionId: 'replacement' } }, { target: { ...target, branchId: 'replacement' } }])('denies stale, ambiguous and replaced observations: %j', async patch => {
    const f = fixture(); Object.assign(f.snapshot, patch);
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: 'session-changed' }); expect(f.gateway.request).not.toHaveBeenCalled();
  });
  it('preserves task invalidation and final target-verification failures', async () => {
    const f = fixture(); vi.mocked(f.tasks.verifyTarget).mockRejectedValue(new GatewayRequestError('session-changed'));
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: 'session-changed' }); expect(f.gateway.request).not.toHaveBeenCalled();
  });
  it.each([{ hasActiveRun: true, activeRunIds: ['replacement'] }, { hasActiveRun: false, activeRunIds: ['run1'] }, { hasActiveRun: true }])('denies final run replacement or unidentified work: %j', async row => {
    const f = fixture(); vi.mocked(f.tasks.verifyTarget).mockResolvedValue(row);
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: 'session-changed' }); expect(f.gateway.request).not.toHaveBeenCalled();
  });
  it.each([{ readOnly: true }, { sendPolicy: 'deny' }])('denies final session authority: %j', async row => {
    const f = fixture(); vi.mocked(f.tasks.verifyTarget).mockResolvedValue({ hasActiveRun: true, activeRunIds: ['run1'], ...row });
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: 'stop-denied' }); expect(f.gateway.request).not.toHaveBeenCalled();
  });
  it('checks negotiated capability again after the asynchronous final verification', async () => {
    const f = fixture(); vi.mocked(f.tasks.verifyTarget).mockImplementation(async () => { f.gateway.status = () => ({ configured: true, state: 'ready', canRead: true, canSend: true, canStop: false }); return { hasActiveRun: true, activeRunIds: ['run1'] }; });
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: 'unsupported' }); expect(f.gateway.request).not.toHaveBeenCalled();
  });
  it('does not mutate if its fresh observation expires during final verification', async () => {
    const f = fixture(); const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(f.tasks.verifyTarget).mockImplementation(async () => { vi.mocked(Date.now).mockReturnValue(now + 15001); return { hasActiveRun: true, activeRunIds: ['run1'] }; });
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: 'session-changed' }); expect(f.gateway.request).not.toHaveBeenCalled();
  });
  it('does not couple independently negotiated Stop to send/create support', async () => {
    const f = fixture(); f.gateway.status = () => ({ configured: true, state: 'ready', canRead: true, canSend: false, canStop: true });
    expect((await f.controls.stop(input)).phase).toBe('requested');
  });
  it.each(['unsupported', 'scope-required'] as const)('preserves negotiated Stop denial %s when both send/create and Stop are unavailable', async reason => {
    const f = fixture(); f.gateway.status = () => ({ configured: true, state: 'ready', canRead: true, canSend: false, canStop: false, stopDisabledReason: reason });
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: reason });
    expect(f.tasks.getTask).not.toHaveBeenCalled(); expect(f.gateway.request).not.toHaveBeenCalled();
  });
  it('denies absent capability and invalid input before private reads', async () => {
    const f = fixture(); f.gateway.status = () => ({ configured: true, state: 'ready', canRead: true, canSend: true, canStop: false });
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(f.controls.stop({ ...input, clearQueued: true })).rejects.toMatchObject({ code: 'invalid-request' }); expect(f.tasks.getTask).not.toHaveBeenCalled();
  });
  it('coalesces duplicate clicks and retains unknown outcome without replay', async () => {
    const f = fixture(); vi.mocked(f.gateway.request).mockRejectedValue(Error('lost response'));
    const receipts = await Promise.all([f.controls.stop(input), f.controls.stop(input)]);
    expect(receipts).toEqual([{ ...input, phase: 'unknown' }, { ...input, phase: 'unknown' }]);
    expect(await f.controls.stop(input)).toEqual({ ...input, phase: 'unknown' }); expect(f.gateway.request).toHaveBeenCalledTimes(1);
  });
  it.each([{ ok: true, aborted: true, runIds: ['other'] }, { ok: true, aborted: true, runIds: ['run1', 'other'] }, { ok: true }, null,
    { ok: true, aborted: true, runIds: ['run1'], clearQueued: true }, { ok: 'true', aborted: true, runIds: ['run1'] },
    { ok: true, aborted: 'true', runIds: ['run1'] }, { ok: true, aborted: true, runIds: 'run1' },
    { ok: true, aborted: true, runIds: [1] }, { ok: true, aborted: true, runIds: ['run\u202e1'] },
    { ok: true, aborted: true, runIds: ['run1', ...Array.from({ length: 64 }, (_, index) => `run-${index}`)] },
    { ok: true, aborted: true, runIds: ['x'.repeat(256 * 1024)] }, { ok: true, aborted: false, runIds: ['run1'] },
  ])('rejects malformed native acknowledgement case %# with a typed error and retains the attempted ledger', async reply => {
    const f = fixture(); vi.mocked(f.gateway.request).mockResolvedValue(reply);
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: 'invalid-source' });
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: 'invalid-source' }); expect(f.gateway.request).toHaveBeenCalledTimes(1);
  });
  it('reports native no-longer-running without claiming completion', async () => {
    const f = fixture(); vi.mocked(f.gateway.request).mockResolvedValue({ ok: true, aborted: false, runIds: [] });
    expect(await f.controls.stop(input)).toEqual({ ...input, phase: 'not-running' });
  });
  it('keeps native ownership refusal distinct and never replays that attempt', async () => {
    const f = fixture(); vi.mocked(f.gateway.request).mockRejectedValue(new GatewayRequestError('stop-denied'));
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: 'stop-denied' });
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: 'stop-denied' }); expect(f.gateway.request).toHaveBeenCalledTimes(1);
  });
  it('does not let an HTTP disconnect cancel an admitted exact operation', async () => {
    const f = fixture(); const consumer = new AbortController(); let finish!: (value: unknown) => void;
    vi.mocked(f.gateway.request).mockImplementation((_method, _params, signal) => { expect(signal?.aborted).toBe(false); return new Promise(resolve => { finish = resolve; }); });
    const pending = f.controls.stop(input, consumer.signal); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    consumer.abort(); finish({ ok: true, aborted: true, runIds: ['run1'] }); expect((await pending).phase).toBe('requested');
  });
  it('refuses already-aborted consumers and closes in-flight verification without mutation', async () => {
    const f = fixture(); const consumer = new AbortController(); consumer.abort();
    await expect(f.controls.stop(input, consumer.signal)).rejects.toMatchObject({ code: 'unavailable' });
    vi.mocked(f.tasks.getTask).mockImplementation((_target, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Error('closed')), { once: true })));
    const pending = f.controls.stop(input); f.controls.close(); await expect(pending).rejects.toMatchObject({ code: 'unavailable' }); expect(f.gateway.request).not.toHaveBeenCalled();
  });
  it('bounds unique Stop attempts without consuming budget for duplicates', async () => {
    const f = fixture();
    for (let n = 0; n < 10; n++) {
      f.snapshot.runId = `run${n}`; f.snapshot.activeRunIds = [`run${n}`];
      vi.mocked(f.tasks.verifyTarget).mockResolvedValue({ hasActiveRun: true, activeRunIds: [`run${n}`] });
      vi.mocked(f.gateway.request).mockResolvedValue({ ok: true, aborted: true, runIds: [`run${n}`] });
      await f.controls.stop({ target, runId: `run${n}` });
    }
    await f.controls.stop(input);
    await expect(f.controls.stop({ target, runId: 'eleventh' })).rejects.toMatchObject({ code: 'rate-limited' }); expect(f.gateway.request).toHaveBeenCalledTimes(10);
  });
});

describe('Stop with real task ownership and observation verification', () => {
  function realTasksFixture(change: 'none' | 'owner' | 'session' | 'branch' | 'run' | 'invalidation') {
    let describes = 0; const listeners = new Set<(event: { event: string; payload: unknown }) => void>();
    const gateway: ControlGateway = {
      start() {}, close() {}, status: () => ({ configured: true, state: 'ready', canRead: true, canSend: true, canStop: true }),
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      request: vi.fn(async (method, params) => {
        if (method === 'sessions.describe') {
          describes++;
          return { session: { ...target, key: target.sessionKey, hasActiveRun: true, activeRunIds: [change === 'run' && describes > 1 ? 'replacement' : 'run1'],
            ...(describes > 1 ? change === 'owner' ? { agentId: 'other' } : change === 'session' ? { sessionId: 'replacement' } : change === 'branch' ? { branchId: 'replacement' } : {} : {}) } };
        }
        if (method === 'chat.history') {
          if (change === 'invalidation') listeners.forEach(listener => listener({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey } }));
          return { sessionKey: target.sessionKey, sessionId: target.sessionId, messages: [], hasMore: false, inFlightRun: { runId: 'run1' } };
        }
        if (method === 'sessions.list') return { sessions: [], hasMore: false };
        if (method === 'chat.abort') { expect(params).toEqual({ agentId: 'cylena', sessionKey: target.sessionKey, runId: 'run1' }); return { ok: true, aborted: true, runIds: ['run1'] }; }
        return {};
      }),
    };
    const tasks = createTaskService(gateway, () => new Set(['cylena'])); const controls = createRunControlService(gateway, tasks);
    closers.push(() => { controls.close(); tasks.close(); }); return { controls, gateway };
  }
  it('cancels only after canonical source verification through the real TaskService', async () => {
    const f = realTasksFixture('none'); expect(await f.controls.stop(input)).toEqual({ ...input, phase: 'requested' });
    expect(vi.mocked(f.gateway.request).mock.calls.filter(([method]) => method === 'sessions.describe')).toHaveLength(2);
  });
  it.each(['owner', 'session', 'branch', 'run', 'invalidation'] as const)('rejects a %s race through the real TaskService before any abort', async change => {
    const f = realTasksFixture(change);
    await expect(f.controls.stop(input)).rejects.toMatchObject({ code: change === 'owner' ? 'invalid-target' : 'session-changed' });
    expect(vi.mocked(f.gateway.request).mock.calls.some(([method]) => method === 'chat.abort')).toBe(false);
  });
});
