// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalService } from './approvalService';
import { projectApproval } from './approvalProjection';
import { GatewayRequestError, type ControlGateway, type GatewayEvent } from './gatewayClient';
import type { TaskService } from './taskService';
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:main', sessionId: 'session-1', lifecycleRevision: 'revision-1' };
const expiry = Date.now() + 600000;
const native = (changes: Record<string, unknown> = {}) => ({ id: 'exact-full-id', urlPath: '/approval/exact-full-id', status: 'pending', createdAtMs: 1, expiresAtMs: expiry,
  ...(changes.status === 'allowed' ? { decision: 'allow-once', reason: 'user' } : changes.status === 'denied' ? { decision: 'deny', reason: 'user' }
    : changes.status === 'expired' ? { reason: 'timeout' } : changes.status === 'cancelled' ? { reason: 'run-aborted' } : {}),
  presentation: { kind: 'exec', commandText: 'synthetic command', allowedDecisions: ['allow-once', 'allow-always', 'deny'] }, ...changes });
const services: ReturnType<typeof createApprovalService>[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); vi.useRealTimers(); });
function fixture() {
  const listeners = new Set<(event: GatewayEvent) => void>(); let items: unknown[] = [native()];
  const request = vi.fn(async (method: string, _params?: Record<string, unknown>, _signal?: AbortSignal): Promise<unknown> => {
    if (method === 'sessions.messages.subscribe') return { subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 10, approvals: items, truncated: false } };
    if (method === 'approval.get') return { approval: native() };
    if (method === 'approval.resolve') return { applied: true, approval: native({ status: 'denied', resolvedAtMs: 20 }) };
    return { subscribed: false, key: _params?.key ?? target.sessionKey };
  });
  const gateway = { status: () => ({ configured: true, state: 'ready', canRead: true, canSend: false, canReviewApprovals: true }), request,
    onEvent: (callback: (event: GatewayEvent) => void) => { listeners.add(callback); return () => listeners.delete(callback); } } as unknown as ControlGateway;
  const tasks = { verifyTarget: vi.fn(async () => ({ key: target.sessionKey, sessionId: target.sessionId })) } as unknown as TaskService;
  const service = createApprovalService(gateway, tasks); services.push(service);
  return { service, gateway, tasks, request, listeners, setItems(value: unknown[]) { items = value; }, emit(event: GatewayEvent) { for (const listener of listeners) listener(event); } };
}
describe('private conversation approvals', () => {
  it.each(['expired-inspection', 'changed', 'rate-limit'] as const)('proves non-dispatch for %s and accepts only a fresh inspection/decision', async scenario => {
    vi.useFakeTimers(); vi.setSystemTime(1000000);
    const host = fixture(); let changed = false; let selectedId = 'exact-full-id';
    const record = () => native({ id: selectedId, expiresAtMs: 2000000, ...(changed ? { presentation: { kind: 'exec', commandText: 'changed command', allowedDecisions: ['deny'] } } : {}) });
    host.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.messages.subscribe') return { subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 10, approvals: [record()], truncated: false } };
      if (method === 'approval.get') return { approval: record() };
      if (method === 'approval.resolve') return { applied: true, approval: native({ id: String(params!.id), expiresAtMs: 2000000, status: 'denied', resolvedAtMs: Date.now() }) };
      return { subscribed: false, key: target.sessionKey };
    });
    if (scenario === 'rate-limit') for (let i = 0; i < 10; i++) {
      selectedId = `prior-${i}`; const inspected = await host.service.inspect({ target, id: selectedId });
      await host.service.resolve({ target, id: selectedId, kind: 'exec', decision: 'deny', observationId: inspected.observationId! });
    }
    selectedId = 'exact-full-id'; const first = await host.service.inspect({ target, id: selectedId });
    if (scenario === 'expired-inspection') vi.advanceTimersByTime(60001);
    if (scenario === 'changed') changed = true;
    const input = { target, id: selectedId, kind: 'exec' as const, decision: 'deny' as const, observationId: first.observationId! };
    const before = host.request.mock.calls.filter(call => call[0] === 'approval.resolve').length;
    await expect(host.service.resolve(input)).rejects.toMatchObject({ code: scenario === 'changed' ? 'approval-changed' : scenario === 'rate-limit' ? 'rate-limited' : 'approval-unavailable', approvalDisposition: 'not-dispatched' });
    expect(host.request.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(before);
    if (scenario === 'rate-limit') vi.advanceTimersByTime(60001);
    const fresh = await host.service.inspect({ target, id: selectedId });
    expect(fresh.observationId).not.toBe(first.observationId);
    await expect(host.service.resolve({ ...input, observationId: fresh.observationId! })).resolves.toMatchObject({ applied: true });
    expect(host.request.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(before + 1);
  });
  it('never labels native approval-unavailable as proven non-dispatch, including after reconnect', async () => {
    const host = fixture(); const inspected = await host.service.inspect({ target, id: 'exact-full-id' });
    const original = host.request.getMockImplementation()!;
    host.request.mockImplementation(async (...args) => { if (args[0] === 'approval.resolve') throw new GatewayRequestError('approval-unavailable'); return original(...args); });
    const input = { target, id: 'exact-full-id', kind: 'exec' as const, decision: 'deny' as const, observationId: inspected.observationId! };
    const error = await host.service.resolve(input).catch(error => error);
    expect(error.code).toBe('approval-unavailable'); expect(error.approvalDisposition).toBeUndefined();
    host.emit({ event: 'source.invalidated', payload: null });
    await expect(host.service.resolve(input)).rejects.toMatchObject({ code: 'approval-outcome-unknown' });
    expect(host.request.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(1);
  });
  it.each([
    { decision: 'allow-always', reason: 'user' }, { decision: 'deny', reason: 'user' },
    { decision: 'allow-once', reason: 'timeout' }, { decision: 'invalid', reason: 'user' },
    { decision: undefined, reason: 'user' }, { decision: 'allow-once', reason: undefined },
  ])('never accepts or replays a contradictory applied terminal verdict %j', async verdict => {
    const host = fixture(); const inspected = await host.service.inspect({ target, id: 'exact-full-id' });
    const original = host.request.getMockImplementation()!;
    host.request.mockImplementation(async (...args) => args[0] === 'approval.resolve'
      ? { applied: true, approval: native({ status: 'allowed', resolvedAtMs: 20, ...verdict }) } : original(...args));
    const input = { target, id: 'exact-full-id', kind: 'exec' as const, decision: 'allow-once' as const, observationId: inspected.observationId! };
    await expect(host.service.resolve(input)).rejects.toMatchObject({ code: 'approval-outcome-unknown' });
    await expect(host.service.resolve(input)).rejects.toMatchObject({ code: 'approval-outcome-unknown' });
    expect(host.request.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(1);
  });
  it.each([
    { status: 'allowed', decision: 'deny', reason: 'user' }, { status: 'allowed', decision: 'allow-once', reason: 'timeout' },
    { status: 'denied', decision: 'allow-once', reason: 'user' }, { status: 'denied', decision: 'deny', reason: 'timeout' },
    { status: 'expired', decision: 'deny', reason: 'timeout' }, { status: 'expired', reason: 'user' },
    { status: 'cancelled', reason: 'user' }, { status: 'pending', decision: 'deny' },
  ])('rejects malformed native terminal discriminators before projection %j', verdict => {
    expect(projectApproval(native({ resolvedAtMs: 20, ...verdict }))).toBeNull();
  });
  it('retries exact observer cleanup after admission failure and blocks new observers until acknowledgment', async () => {
    vi.useFakeTimers(); const host = fixture(); const original = host.request.getMockImplementation()!;
    let cleanupAttempts = 0;
    host.request.mockImplementation(async (...args) => {
      if (args[0] !== 'sessions.messages.unsubscribe') return original(...args);
      if (++cleanupAttempts === 1) throw Error('Too many pending task requests');
      return { subscribed: false, key: args[1]!.key };
    });
    await host.service.read(target);
    await expect(host.service.read(target)).rejects.toMatchObject({ code: 'rate-limited' });
    expect(host.request.mock.calls.filter(call => call[0] === 'sessions.messages.subscribe')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    const cleanups = host.request.mock.calls.filter(call => call[0] === 'sessions.messages.unsubscribe');
    expect(cleanups).toHaveLength(2); expect(cleanups[0][1]).toEqual(cleanups[1][1]);
    await expect(host.service.read(target)).resolves.toMatchObject({ items: [expect.objectContaining({ id: 'exact-full-id' })] });
  });
  it('does not return a discovery page if its source is invalidated during cleanup acknowledgment', async () => {
    const host = fixture(); const original = host.request.getMockImplementation()!;
    host.request.mockImplementation(async (...args) => {
      if (args[0] !== 'sessions.messages.unsubscribe') return original(...args);
      host.emit({ event: 'source.invalidated', payload: null }); return { subscribed: false, key: target.sessionKey };
    });
    await expect(host.service.read(target)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('retains unacknowledged cleanup after office close until the exact observer is released', async () => {
    vi.useFakeTimers(); const host = fixture(); const original = host.request.getMockImplementation()!; let attempts = 0;
    host.request.mockImplementation(async (...args) => args[0] === 'sessions.messages.unsubscribe'
      ? ++attempts === 1 ? {} : { subscribed: false, key: args[1]!.key } : original(...args));
    await host.service.read(target); host.service.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.request.mock.calls.filter(call => call[0] === 'sessions.messages.unsubscribe')).toHaveLength(2);
    expect(host.listeners.size).toBe(0);
    expect(host.request.mock.calls.filter(call => call[0] === 'sessions.messages.subscribe')).toHaveLength(1);
  });
  it.each([
    { status: 'allowed', decision: 'allow-once', reason: 'user' }, { status: 'allowed', decision: 'allow-always', reason: 'user' },
    { status: 'denied', decision: 'deny', reason: 'user' }, { status: 'denied', decision: 'deny', reason: 'malformed-verdict' },
    { status: 'denied', decision: 'deny', reason: 'no-route' }, { status: 'denied', decision: 'deny', reason: 'storage-corrupt' },
    { status: 'expired', reason: 'timeout' }, { status: 'cancelled', reason: 'run-aborted' }, { status: 'cancelled', reason: 'gateway-restart' },
  ])('accepts valid native terminal discriminators without exposing the raw verdict %j', verdict => {
    const projected = projectApproval(native({ resolvedAtMs: 20, ...verdict }));
    expect(projected?.status).toBe(verdict.status);
    expect(projected).not.toHaveProperty('decision'); expect(projected).not.toHaveProperty('reason');
  });
  it('keeps outstanding observers bounded through persistent cleanup failure and discards only the ended generation', async () => {
    vi.useFakeTimers(); const host = fixture(); const original = host.request.getMockImplementation()!;
    host.request.mockImplementation(async (...args) => args[0] === 'sessions.messages.unsubscribe' ? Promise.reject(Error('temporary native failure')) : original(...args));
    await host.service.read(target);
    for (let i = 0; i < 20; i++) await expect(host.service.read(target)).rejects.toMatchObject({ code: 'rate-limited' });
    expect(host.request.mock.calls.filter(call => call[0] === 'sessions.messages.subscribe')).toHaveLength(1);
    const oldId = host.request.mock.calls.find(call => call[0] === 'sessions.messages.subscribe')![1]!.subscriptionId;
    host.emit({ event: 'source.invalidated', payload: null }); host.request.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.request).not.toHaveBeenCalled();
    host.request.mockImplementation(async (...args) => args[0] === 'sessions.messages.unsubscribe' ? { subscribed: false, key: args[1]!.key } : original(...args));
    await host.service.read(target);
    expect(host.request.mock.calls.find(call => call[0] === 'sessions.messages.unsubscribe')![1]!.subscriptionId).not.toBe(oldId);
  });
  it('bounds new operations to ten per minute and retains all 1000 attempted native identities without eviction', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000000); const host = fixture();
    let selected = 'id-0';
    host.request.mockImplementation(async (method, params) => {
      const record = native({ id: selected });
      if (method === 'sessions.messages.subscribe') return { subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 10, approvals: [record], truncated: false } };
      if (method === 'approval.get') return { approval: record };
      if (method === 'approval.resolve') return { applied: true, approval: native({ id: String(params!.id), status: 'denied', resolvedAtMs: Date.now() }) };
      return { subscribed: false, key: target.sessionKey };
    });
    const decide = async () => {
      const inspected = await host.service.inspect({ target, id: selected });
      return host.service.resolve({ target, id: selected, kind: 'exec', decision: 'deny', observationId: inspected.observationId! });
    };
    for (let i = 0; i < 1000; i++) {
      if (i && i % 10 === 0) { selected = `blocked-${i}`; await expect(decide()).rejects.toMatchObject({ code: 'rate-limited' }); vi.advanceTimersByTime(60001); }
      selected = `id-${i}`; await expect(decide()).resolves.toMatchObject({ applied: true });
    }
    vi.advanceTimersByTime(60001); selected = 'capacity-exceeded'; await expect(decide()).rejects.toMatchObject({ code: 'rate-limited' });
    selected = 'id-0'; await expect(decide()).rejects.toMatchObject({ code: 'approval-outcome-unknown' });
    expect(host.request.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(1000);
  });
  it('bounds remembered membership to 200 entries while preserving current inspections', async () => {
    const host = fixture();
    const first = await host.service.inspect({ target, id: 'exact-full-id' });
    for (let offset = 0; offset < 200; offset += 25) {
      host.setItems(Array.from({ length: 25 }, (_, i) => native({ id: `new-${offset + i}` })));
      await host.service.read(target);
    }
    await expect(host.service.resolve({ target, id: 'exact-full-id', kind: 'exec', decision: 'deny', observationId: first.observationId! })).rejects.toMatchObject({ code: 'approval-unavailable' });
  });
  it('bounds concurrent discovery to four and releases listeners/observers when closed in flight', async () => {
    const host = fixture(); const admissions: (() => void)[] = [];
    vi.mocked(host.tasks.verifyTarget).mockImplementation(() => new Promise(resolve => admissions.push(() => resolve({}))));
    const reads = Array.from({ length: 4 }, () => host.service.read(target).catch(error => error));
    await expect(host.service.read(target)).rejects.toMatchObject({ code: 'rate-limited' });
    host.service.close(); admissions.forEach(resolve => resolve());
    for (const result of await Promise.all(reads)) expect(result).toMatchObject({ code: 'unavailable' });
    expect(host.listeners.size).toBe(0); expect(host.request).not.toHaveBeenCalled();
  });
  it('keeps the four-read bound while inspections wait for exact native records', async () => {
    const host = fixture(); const original = host.request.getMockImplementation()!;
    const releases: (() => void)[] = [];
    host.request.mockImplementation(async (...args) => args[0] === 'approval.get' ? new Promise(resolve => releases.push(() => resolve({ approval: native() }))) : original(...args));
    const inspections = Array.from({ length: 4 }, () => host.service.inspect({ target, id: 'exact-full-id' }).catch(error => error));
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    await expect(host.service.read(target)).rejects.toMatchObject({ code: 'rate-limited' });
    host.service.close(); releases.forEach(resolve => resolve()); await Promise.all(inspections);
  });
  it('unsubscribes exact in-flight observer after HTTP abort and rejects any data', async () => {
    const host = fixture(); let release!: (value: unknown) => void;
    host.request.mockImplementation(async method => method === 'sessions.messages.subscribe' ? new Promise(resolve => { release = resolve; }) : { subscribed: false, key: target.sessionKey });
    const abort = new AbortController(); const read = host.service.read(target, abort.signal);
    await vi.waitFor(() => expect(release).toBeDefined()); abort.abort();
    release({ subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 10, approvals: [], truncated: false } });
    await expect(read).rejects.toMatchObject({ code: 'unavailable' });
    expect(host.request.mock.calls.filter(call => call[0] === 'sessions.messages.unsubscribe')).toHaveLength(1);
    expect(host.listeners.size).toBe(1);
  });
  it('returns a terminal winner after pending audience disappears without resolving again', async () => {
    const host = fixture(); const inspected = await host.service.inspect({ target, id: 'exact-full-id' });
    host.setItems([]);
    host.request.mockImplementation(async method => method === 'sessions.messages.subscribe'
      ? { subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 10, approvals: [], truncated: false } }
      : { approval: native({ status: 'expired', resolvedAtMs: Date.now() }) });
    await expect(host.service.resolve({ target, id: 'exact-full-id', kind: 'exec', decision: 'deny', observationId: inspected.observationId! })).resolves.toMatchObject({ applied: false, approval: { status: 'expired' } });
    expect(host.request.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(0);
  });
  it('does not dispatch two concurrent resolutions for the same native identity', async () => {
    const host = fixture(); const inspected = await host.service.inspect({ target, id: 'exact-full-id' });
    const input = { target, id: 'exact-full-id', kind: 'exec' as const, decision: 'deny' as const, observationId: inspected.observationId! };
    const first = host.service.resolve(input);
    await expect(host.service.resolve(input)).rejects.toMatchObject({ code: 'rate-limited' });
    await first; expect(host.request.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(1);
  });
  it('keeps reviewer-binding denial local and never forwards raw native diagnostics', async () => {
    const host = fixture();
    host.request.mockRejectedValueOnce(new GatewayRequestError('approvals-denied'));
    await expect(host.service.read(target)).rejects.toMatchObject({ code: 'approvals-denied' });
  });
  it('treats oversized resolve responses as unknown and never replays even after a fresh inspection', async () => {
    const host = fixture(); const inspected = await host.service.inspect({ target, id: 'exact-full-id' });
    const original = host.request.getMockImplementation()!;
    host.request.mockImplementation(async (...args) => args[0] === 'approval.resolve'
      ? { applied: true, approval: native({ status: 'denied', resolvedAtMs: 20 }), private: 'x'.repeat(256 * 1024) } : original(...args));
    const input = { target, id: 'exact-full-id', kind: 'exec' as const, decision: 'deny' as const, observationId: inspected.observationId! };
    await expect(host.service.resolve(input)).rejects.toMatchObject({ code: 'approval-outcome-unknown' });
    await host.service.inspect({ target, id: input.id });
    await expect(host.service.resolve(input)).rejects.toMatchObject({ code: 'approval-outcome-unknown' });
  });
  it('requires the exact inspected observation and fences changed decision-relevant presentation', async () => {
    const host = fixture(); const inspected = await host.service.inspect({ target, id: 'exact-full-id' });
    const input = { target, id: 'exact-full-id', kind: 'exec' as const, decision: 'allow-once' as const, observationId: inspected.observationId! };
    await expect(host.service.resolve({ ...input, observationId: 'forged' })).rejects.toMatchObject({ code: 'approval-unavailable' });
    host.setItems([native({ presentation: { ...native().presentation, warningText: 'changed warning' } })]);
    await expect(host.service.resolve(input)).rejects.toMatchObject({ code: 'approval-changed' });
    expect(host.request.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(0);
  });
  it('expires an inspection after sixty seconds even when polling refreshes unchanged membership', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000000); const host = fixture();
    const inspected = await host.service.inspect({ target, id: 'exact-full-id' });
    vi.advanceTimersByTime(59000); await host.service.read(target); vi.advanceTimersByTime(1001);
    await expect(host.service.resolve({ target, id: 'exact-full-id', kind: 'exec', decision: 'deny', observationId: inspected.observationId! })).rejects.toMatchObject({ code: 'approval-unavailable' });
    expect(host.request.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(0);
  });
  it('does not claim an applied success for an inconsistent native verdict', async () => {
    const host = fixture(); const inspected = await host.service.inspect({ target, id: 'exact-full-id' });
    const original = host.request.getMockImplementation()!;
    host.request.mockImplementation(async (...args) => args[0] === 'approval.resolve'
      ? { applied: true, approval: native({ status: 'allowed', resolvedAtMs: 20 }) } : original(...args));
    await expect(host.service.resolve({ target, id: 'exact-full-id', kind: 'exec', decision: 'deny', observationId: inspected.observationId! })).rejects.toMatchObject({ code: 'approval-outcome-unknown' });
  });
  it('does not reuse an observation across canonical lifecycle or audience identities', async () => {
    const host = fixture(); const inspected = await host.service.inspect({ target, id: 'exact-full-id' });
    await expect(host.service.resolve({ target: { ...target, lifecycleRevision: 'replacement' }, id: 'exact-full-id', kind: 'exec', decision: 'deny', observationId: inspected.observationId! })).rejects.toMatchObject({ code: 'approval-unavailable' });
    host.emit({ event: 'source.invalidated', payload: null });
    await expect(host.service.resolve({ target, id: 'exact-full-id', kind: 'exec', decision: 'deny', observationId: inspected.observationId! })).rejects.toMatchObject({ code: 'approval-unavailable' });
  });
  it('never replays an attempted full native ID through another authorized audience after source loss', async () => {
    const host = fixture(); const child = { ...target, sessionKey: 'agent:cylena:child', sessionId: 'child-session' };
    host.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.messages.subscribe') return { subscribed: true, key: params!.key, agentId: target.agentId, approvalReplay: { sessionKey: params!.key, updatedAtMs: 10, approvals: [native()], truncated: false } };
      if (method === 'approval.get') return { approval: native() };
      if (method === 'approval.resolve') { host.emit({ event: 'source.invalidated', payload: null }); throw Error('lost'); }
      return { subscribed: false, key: params!.key };
    });
    const first = await host.service.inspect({ target, id: 'exact-full-id' });
    await expect(host.service.resolve({ target, id: 'exact-full-id', kind: 'exec', decision: 'deny', observationId: first.observationId! })).rejects.toMatchObject({ code: 'approval-outcome-unknown' });
    const second = await host.service.inspect({ target: child, id: 'exact-full-id' });
    await expect(host.service.resolve({ target: child, id: 'exact-full-id', kind: 'exec', decision: 'deny', observationId: second.observationId! })).rejects.toMatchObject({ code: 'approval-outcome-unknown' });
    expect(host.request.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(1);
  });
  it.each([true, Array.from({ length: 1001 }, (_, i) => native({ id: `id-${i}` })), [native(), native()]])('fails closed on truncated, overflowing or duplicate replay', async bad => {
    const host = fixture();
    host.request.mockImplementation(async method => method === 'sessions.messages.subscribe' ? { subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 10, approvals: Array.isArray(bad) ? bad : [native()], truncated: bad === true } } : { subscribed: false, key: target.sessionKey });
    await expect(host.service.read(target)).rejects.toMatchObject({ code: 'invalid-source' });
    expect(host.request.mock.calls.filter(call => call[0] === 'sessions.messages.unsubscribe')).toHaveLength(1);
  });
  it('bounds visible pages and expires remembered inspection identities', async () => {
    vi.useFakeTimers(); const host = fixture();
    host.setItems(Array.from({ length: 26 }, (_, i) => native({ id: i === 0 ? 'exact-full-id' : `id-${i}` })));
    const page = await host.service.read(target); expect(page.items).toHaveLength(25); expect(page.truncated).toBe(true);
    const inspected = await host.service.inspect({ target, id: 'exact-full-id' });
    vi.advanceTimersByTime(60001);
    await expect(host.service.resolve({ target, id: 'exact-full-id', kind: 'exec', decision: 'deny', observationId: inspected.observationId! })).rejects.toMatchObject({ code: 'approval-unavailable' });
  });
  it('rejects an overflowing or malformed racing event buffer and cleans up the exact observer', async () => {
    const host = fixture();
    host.request.mockImplementation(async method => {
      if (method === 'sessions.messages.subscribe') {
        for (let i = 0; i < 101; i++) host.emit({ event: 'session.approval', payload: { sessionKey: target.sessionKey, phase: 'pending', updatedAtMs: 11, approval: native() } });
        return { subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 10, approvals: [], truncated: false } };
      }
      return { subscribed: false, key: target.sessionKey };
    });
    await expect(host.service.read(target)).rejects.toMatchObject({ code: 'invalid-source' });
    const sub = host.request.mock.calls.find(call => call[0] === 'sessions.messages.subscribe')!;
    expect(host.request).toHaveBeenCalledWith('sessions.messages.unsubscribe', expect.objectContaining({ subscriptionId: sub[1]!.subscriptionId }));
  });
  it('rejects aborted and closed operations without dispatch and retains only one source listener', async () => {
    const host = fixture(); const abort = new AbortController(); abort.abort();
    await expect(host.service.read(target, abort.signal)).rejects.toMatchObject({ code: 'unavailable' });
    expect(host.request).not.toHaveBeenCalled(); host.service.close();
    await expect(host.service.read(target)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('projects only safe presentation and never offers a standing grant', () => {
    const projected = projectApproval({ ...native(), request: { env: 'secret', cwd: '/private' }, presentation: { ...native().presentation, rawPlan: 'secret' } });
    expect(projected?.allowedDecisions).toEqual(['allow-once', 'deny']);
    expect(JSON.stringify(projected)).not.toMatch(/secret|private|rawPlan/);
    expect(projectApproval(native({ presentation: { kind: 'unknown' } }))).toBeNull();
  });
  it('retains payment and publication blast-radius facts in plugin presentations', () => {
    const presentation = { kind: 'plugin', title: 'Synthetic payment', description: 'Review this payment', severity: 'critical', allowedDecisions: ['allow-once', 'deny'] };
    const payment = projectApproval(native({ presentation: { ...presentation, scope: { kind: 'payment', amount: '25.00', currency: 'EUR', target: 'fixture-recipient' } } }));
    expect(payment?.details).toEqual(expect.arrayContaining(['Payment: 25.00 EUR', 'Payment target: fixture-recipient', 'Severity: critical']));
    const publication = projectApproval(native({ presentation: { ...presentation, scope: { kind: 'external-post', target: 'fixture-channel', visibility: 'public' } } }));
    expect(publication?.details).toEqual(expect.arrayContaining(['Publication target: fixture-channel', 'Visibility: public']));
    expect(projectApproval(native({ presentation: { ...presentation, scope: { kind: 'unrecognized-side-effect' } } }))).toBeNull();
  });
  it('preserves recipient scope and exact system proposal hash without exposing execution bindings', () => {
    const recipients = projectApproval(native({ presentation: { ...native().presentation, scope: { kind: 'message-send', target: 'fixture-channel', recipientCount: 3, recipients: ['fixture-recipient'], audience: 'external' }, systemRunBinding: 'private-binding' } }));
    expect(recipients?.details).toEqual(expect.arrayContaining(['Recipients: 3 (external)', 'Named recipients: fixture-recipient']));
    expect(JSON.stringify(recipients)).not.toContain('private-binding');
    const system = projectApproval(native({ presentation: { kind: 'system-agent', title: 'Synthetic proposal', description: 'Review this change', proposalHash: 'a'.repeat(64), allowedDecisions: ['allow-once', 'deny'] } }));
    expect(system?.details).toEqual([`Proposal hash: ${'a'.repeat(64)}`]);
    expect(projectApproval(native({ presentation: { kind: { toString: null } } }))).toBeNull();
  });
  it('uses a distinct opt-in observer and always releases it', async () => {
    const { service, request, tasks } = fixture(); const page = await service.read(target);
    expect(page.items).toHaveLength(1); expect(tasks.verifyTarget).toHaveBeenCalledTimes(2);
    const subscribe = request.mock.calls.find(call => call[0] === 'sessions.messages.subscribe');
    expect(subscribe?.[1]).toMatchObject({ key: target.sessionKey, includeApprovals: true, subscriptionId: expect.any(String) });
    expect(request).toHaveBeenCalledWith('sessions.messages.unsubscribe', expect.objectContaining({ subscriptionId: (subscribe?.[1] as Record<string, unknown>).subscriptionId }));
  });
  it('rejects an approval from another target before lookup or mutation', async () => {
    const { service, request } = fixture();
    await expect(service.resolve({ target, id: 'other-approval-id', kind: 'exec', decision: 'deny', observationId: 'unobserved' })).rejects.toMatchObject({ code: 'approval-unavailable' });
    expect(request.mock.calls.some(call => call[0].startsWith('approval.'))).toBe(false);
  });
  it('revalidates membership and returns the recorded first answer, not the requested choice', async () => {
    const { service, request } = fixture();
    request.mockImplementation(async method => method === 'sessions.messages.subscribe'
      ? { subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 10, approvals: [native()], truncated: false } }
      : method === 'approval.get' ? { approval: native() }
        : method === 'approval.resolve' ? { applied: false, approval: native({ status: 'denied', resolvedAtMs: 20 }) } : { subscribed: false, key: target.sessionKey });
    const inspected = await service.inspect({ target, id: 'exact-full-id' });
    const result = await service.resolve({ target, id: 'exact-full-id', kind: 'exec', decision: 'allow-once', observationId: inspected.observationId! });
    expect(result).toMatchObject({ applied: false, approval: { status: 'denied' } });
    expect(request).toHaveBeenCalledWith('approval.resolve', { id: 'exact-full-id', kind: 'exec', decision: 'allow-once' }, expect.any(AbortSignal));
  });
  it('does not mutate after target replacement, stale expiry, or source invalidation', async () => {
    const { service, request, tasks } = fixture();
    vi.mocked(tasks.verifyTarget).mockRejectedValueOnce(Object.assign(Error(), { code: 'session-changed' }));
    await expect(service.read(target)).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
    const expired = native({ expiresAtMs: Date.now() - 1 });
    request.mockImplementation(async method => method === 'sessions.messages.subscribe'
      ? { subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 10, approvals: [expired], truncated: false } }
      : method === 'sessions.messages.unsubscribe' ? { subscribed: false, key: target.sessionKey } : { approval: expired });
    const inspected = await service.inspect({ target, id: 'exact-full-id' });
    await expect(service.resolve({ target, id: 'exact-full-id', kind: 'exec', decision: 'deny', observationId: inspected.observationId! })).rejects.toMatchObject({ code: 'approval-unavailable' });
    expect(request.mock.calls.some(call => call[0] === 'approval.resolve')).toBe(false);
  });
  it('treats a lost resolution response as unknown and never replays it', async () => {
    const { service, request } = fixture();
    request.mockImplementation(async method => {
      if (method === 'sessions.messages.subscribe') return { subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 10, approvals: [native()], truncated: false } };
      if (method === 'approval.get') return { approval: native() };
      if (method === 'approval.resolve') throw Error('transport dropped');
      return { subscribed: false, key: target.sessionKey };
    });
    const inspected = await service.inspect({ target, id: 'exact-full-id' });
    const input = { target, id: 'exact-full-id', kind: 'exec' as const, decision: 'deny' as const, observationId: inspected.observationId! };
    await expect(service.resolve(input)).rejects.toMatchObject({ code: 'approval-outcome-unknown' });
    await service.inspect({ target, id: input.id });
    await expect(service.resolve(input)).rejects.toMatchObject({ code: 'approval-outcome-unknown' });
    expect(request.mock.calls.filter(call => call[0] === 'approval.resolve')).toHaveLength(1);
  });
  it('does not resurrect a terminal event that raced the pending replay at the same timestamp', async () => {
    const host = fixture();
    host.request.mockImplementation(async method => {
      if (method === 'sessions.messages.subscribe') {
        host.emit({ event: 'session.approval', payload: { sessionKey: target.sessionKey, updatedAtMs: 10, phase: 'terminal', approval: native({ status: 'allowed', resolvedAtMs: 10 }) } });
        host.emit({ event: 'session.approval', payload: { sessionKey: target.sessionKey, updatedAtMs: 10, phase: 'pending', approval: native() } });
        return { subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 10, approvals: [native()], truncated: false } };
      }
      return { subscribed: false, key: target.sessionKey };
    });
    expect((await host.service.read(target)).items).toEqual([]);
  });
  it('releases an observer and returns no data when source loss races replay verification', async () => {
    const host = fixture();
    vi.mocked(host.tasks.verifyTarget).mockImplementationOnce(async () => ({})).mockImplementationOnce(async () => {
      host.emit({ event: 'source.invalidated', payload: null }); return {};
    });
    await expect(host.service.read(target)).rejects.toMatchObject({ code: 'unavailable' });
    expect(host.request.mock.calls.some(call => call[0] === 'approval.resolve')).toBe(false);
  });
  it('rejects extra decision fields before any Gateway request', async () => {
    const host = fixture();
    await expect(host.service.resolve({ target, id: 'exact-full-id', kind: 'exec', decision: 'deny', reviewer: 'spoofed' } as never)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(host.request).not.toHaveBeenCalled();
  });
});
