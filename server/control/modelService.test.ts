// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelService } from './modelService';
import { createTaskService } from './taskService';
import { GatewayRequestError, type ControlGateway, type GatewayEvent } from './gatewayClient';

const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 's1', lifecycleRevision: 'l1', branchId: 'b1' };
const closers: (() => void)[] = [];
afterEach(() => { closers.splice(0).reverse().forEach(close => close()); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture() {
  const listeners = new Set<(event: GatewayEvent) => void>(); const owners = new Set(['cylena']);
  const row: Record<string, unknown> = { key: target.sessionKey, agentId: target.agentId, sessionId: 's1', lifecycleRevision: 'l1', branchId: 'b1', hasActiveRun: false, modelProvider: 'provider', model: 'old' };
  const catalog = { models: [
    { provider: 'provider', id: 'old', name: 'Old', manualSelectionAllowed: true, available: true },
    { provider: 'provider', id: 'new', name: 'New', manualSelectionAllowed: true, available: true },
  ] };
  const caps = { canRead: true, canChange: true };
  const receipt: Record<string, unknown> = { ok: true, path: '/private/native/session.db', key: target.sessionKey,
    entry: { sessionId: 's1', lifecycleRevision: 'l1', providerOverride: 'provider', modelOverride: 'new', modelOverrideSource: 'user', modelOverrideRouteResolution: 'resolved' },
    resolved: { modelProvider: 'provider', model: 'new' } };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const gateway: ControlGateway = { start() {}, close() {}, status: () => ({ configured: true, state: 'ready', canRead: true, canSend: false }),
    modelCapabilities: () => caps, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    request: vi.fn(async (method, params) => {
      calls.push({ method, params });
      if (method === 'sessions.describe') return { session: structuredClone(row) };
      if (method === 'models.list') return structuredClone(catalog);
      if (method === 'sessions.patch') {
        const resolved = receipt.resolved as Record<string, unknown>;
        row.model = resolved.model; row.modelProvider = resolved.modelProvider;
        return structuredClone(receipt);
      }
      return {};
    }) };
  const tasks = createTaskService(gateway, () => owners); const models = createModelService(gateway, tasks);
  closers.push(() => { models.close(); tasks.close(); });
  const emit = (event = 'sessions.changed') => listeners.forEach(listener => listener({ event, payload: { sessionKey: target.sessionKey, agentId: target.agentId } }));
  return { row, catalog, caps, receipt, calls, gateway, tasks, models, emit, owners };
}
describe('native scoped model service', () => {
  it('reads configured native choices with only canonical framing independently of send', async () => {
    const f = fixture(); const snap = await f.models.read(target);
    expect(snap).toMatchObject({ target, currentModel: 'provider/old', choices: [
      { id: 'provider/old', label: 'Old', selectable: true, available: true }, { id: 'provider/new', label: 'New', selectable: true, available: true },
    ], canChange: true, disabledReason: null });
    expect(f.calls.filter(x => x.method === 'models.list')).toEqual([{ method: 'models.list', params: { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', view: 'configured', includeDetails: true } }]);
    expect(JSON.stringify(snap)).not.toContain('/private');
  });
  it.each([['busy', { hasActiveRun: true }], ['activity-unknown', { hasActiveRun: null }], ['read-only', { readOnly: true }], ['permission', { sendPolicy: 'deny' }], ['selection-unknown', { model: undefined }]] as const)('reports %s without disguising choices as readiness', async (reason, patch) => {
    const f = fixture(); Object.assign(f.row, patch); const snap = await f.models.read(target);
    expect(snap.canChange).toBe(false); expect(snap.disabledReason).toBe(reason); expect(snap.choices).toHaveLength(2);
  });
  it('separates manual selection from availability and never promotes unknown readiness', async () => {
    const f = fixture(); Object.assign(f.catalog.models[1], { manualSelectionAllowed: false, available: true });
    expect((await f.models.read(target)).choices[1]).toEqual({ id: 'provider/new', label: 'New', selectable: false, available: true });
    for (const patch of [{ manualSelectionAllowed: false, available: true }, { manualSelectionAllowed: true, available: false }, { manualSelectionAllowed: true, available: undefined }]) {
      Object.assign(f.catalog.models[1], patch); const snap = await f.models.read(target);
      await expect(f.models.select({ target, selectionId: snap.selectionId, model: 'provider/new' })).rejects.toMatchObject({ code: 'model-denied' });
    }
    expect(f.calls.some(x => x.method === 'sessions.patch')).toBe(false);
  });
  it.each([{}, { models: [{}] }, { models: [{ provider: 'p', id: 'm', name: 'Bad\u202e', manualSelectionAllowed: true }] },
    { models: [{ provider: 'p', id: 'm', name: 'M', available: 'yes' }] },
    { models: [{ provider: 'p', id: 'm', name: 'M' }, { provider: 'p', id: 'm', name: 'M' }] },
    { models: Array.from({ length: 501 }, (_, i) => ({ provider: 'p', id: String(i), name: 'M' })) },
  ])('rejects malformed or duplicated catalog case %#', async catalog => {
    const f = fixture(); Object.assign(f.catalog, catalog); if (!('models' in catalog)) delete (f.catalog as Partial<typeof f.catalog>).models;
    await expect(f.models.read(target)).rejects.toMatchObject({ code: 'invalid-source' });
  });
  it('confirms exact committed preference and reconciled identity then coalesces immutable duplicate applies', async () => {
    const f = fixture(); const snap = await f.models.read(target); const input = { target, selectionId: snap.selectionId, model: 'provider/new' };
    const outcomes = await Promise.all([f.models.select(input), f.models.select(input)]);
    expect(outcomes[0]).toMatchObject({ target, outcome: 'confirmed', snapshot: { currentModel: 'provider/new' } }); expect(outcomes[1]).toEqual(outcomes[0]);
    expect(await f.models.select(input)).toEqual(outcomes[0]);
    expect(f.calls.filter(x => x.method === 'sessions.patch')).toEqual([{ method: 'sessions.patch', params: { key: target.sessionKey, agentId: 'cylena', expectedSessionId: 's1', expectedLifecycleRevision: 'l1', model: 'provider/new' } }]);
    await expect(f.models.select({ ...input, model: null })).rejects.toMatchObject({ code: 'invalid-request' });
  });
  it.each(['wrong-resolved', 'wrong-override', 'wrong-provenance', 'wrong-route', 'wrong-session', 'wrong-lifecycle', 'missing-ok', 'oversized'] as const)('retains unknown without replay for %s receipt', async kind => {
    const f = fixture(); const entry = f.receipt.entry as Record<string, unknown>;
    if (kind === 'wrong-resolved') { f.receipt.resolved = { modelProvider: 'provider', model: 'wrong' }; entry.modelOverride = 'wrong'; f.row.model = 'wrong'; }
    if (kind === 'wrong-override') entry.modelOverride = 'wrong';
    if (kind === 'wrong-provenance') entry.modelOverrideSource = 'default';
    if (kind === 'wrong-route') delete entry.modelOverrideRouteResolution;
    if (kind === 'wrong-session') entry.sessionId = 'other';
    if (kind === 'wrong-lifecycle') entry.lifecycleRevision = 'other';
    if (kind === 'missing-ok') delete f.receipt.ok;
    if (kind === 'oversized') f.receipt.path = 'x'.repeat(256 * 1024);
    const snap = await f.models.read(target); const input = { target, selectionId: snap.selectionId, model: 'provider/new' };
    expect(await f.models.select(input)).toEqual({ target, outcome: 'unknown' }); f.emit('source.invalidated');
    expect(await f.models.select(input)).toEqual({ target, outcome: 'unknown' }); expect(f.calls.filter(x => x.method === 'sessions.patch')).toHaveLength(1);
  });
  it('requires user override even when explicit selection equals configured default', async () => {
    const f = fixture(); const snap = await f.models.read(target); const entry = f.receipt.entry as Record<string, unknown>;
    f.receipt.entry = { sessionId: 's1', lifecycleRevision: 'l1', modelOverrideSource: 'default' };
    expect(await f.models.select({ target, selectionId: snap.selectionId, model: 'provider/new' })).toEqual({ target, outcome: 'unknown' });
    f.receipt.entry = entry; const fresh = await f.models.read(target);
    expect((await f.models.select({ target, selectionId: fresh.selectionId, model: 'provider/new' })).outcome).toBe('confirmed');
  });
  it.each([false, true])('requires explicit default provenance and absent own override fields (bad=%s)', async bad => {
    const f = fixture(); f.receipt.entry = { sessionId: 's1', lifecycleRevision: 'l1', modelOverrideSource: 'default', ...(bad ? { providerOverride: undefined } : {}) };
    // Native JSON omits undefined, so use null to exercise an own forbidden field on wire.
    if (bad) (f.receipt.entry as Record<string, unknown>).providerOverride = null;
    const snap = await f.models.read(target);
    expect((await f.models.select({ target, selectionId: snap.selectionId, model: null })).outcome).toBe(bad ? 'unknown' : 'confirmed');
  });
  it.each(['busy', 'permission', 'model', 'branch', 'lifecycle', 'owner', 'capability', 'source'] as const)('rechecks %s before dispatch', async kind => {
    const f = fixture(); const snap = await f.models.read(target);
    if (kind === 'busy') f.row.hasActiveRun = true;
    if (kind === 'permission') f.catalog.models[1].manualSelectionAllowed = false;
    if (kind === 'model') f.row.model = 'changed';
    if (kind === 'branch') f.row.branchId = 'changed';
    if (kind === 'lifecycle') f.row.lifecycleRevision = 'changed';
    if (kind === 'owner') f.owners.clear();
    if (kind === 'capability') f.caps.canChange = false;
    if (kind === 'source') f.emit();
    await expect(f.models.select({ target, selectionId: snap.selectionId, model: 'provider/new' })).rejects.toBeDefined();
    expect(f.calls.some(x => x.method === 'sessions.patch')).toBe(false);
  });
  it('bounds observation expiry and capacity without evicting attempted identities', async () => {
    const f = fixture(); let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const first = await f.models.read(target);
    now += 60000; await expect(f.models.select({ target, selectionId: first.selectionId, model: null })).rejects.toMatchObject({ code: 'session-changed' });
    const next = await f.models.read(target); for (let i = 0; i < 100; i++) await f.models.read(target);
    await expect(f.models.select({ target, selectionId: next.selectionId, model: null })).rejects.toMatchObject({ code: 'session-changed' });
  });
  it('aborts private reads and fences late source reads, while limiting concurrent reads to four', async () => {
    const f = fixture(); const wait = deferred<unknown>(); const original = f.gateway.request;
    f.gateway.request = vi.fn((method, params, signal) => method === 'models.list' ? wait.promise : original(method, params, signal));
    const controller = new AbortController(); const reads = [f.models.read(target, controller.signal), ...Array.from({ length: 3 }, () => f.models.read(target))];
    const settled = Promise.allSettled(reads); await expect(f.models.read(target)).rejects.toMatchObject({ code: 'rate-limited' });
    controller.abort(); f.emit('source.invalidated'); wait.resolve(f.catalog);
    expect((await settled).every(x => x.status === 'rejected')).toBe(true);
  });
  it('keeps an admitted mutation independent of HTTP cancellation and never replays after source replacement', async () => {
    const f = fixture(); const wait = deferred<unknown>(); const original = f.gateway.request;
    f.gateway.request = vi.fn((method, params, signal) => method === 'sessions.patch' ? wait.promise : original(method, params, signal));
    const snap = await f.models.read(target); const input = { target, selectionId: snap.selectionId, model: 'provider/new' };
    const result = f.models.select(input); await vi.waitFor(() => expect(f.gateway.request).toHaveBeenCalledWith('sessions.patch', expect.any(Object)));
    f.emit('source.invalidated'); wait.resolve(f.receipt);
    expect(await result).toEqual({ target, outcome: 'unknown' }); expect(await f.models.select(input)).toEqual({ target, outcome: 'unknown' });
    expect(vi.mocked(f.gateway.request).mock.calls.filter(x => x[0] === 'sessions.patch')).toHaveLength(1);
  });
  it('retains uncertain attempts for process lifetime and fails closed at 1000 without eviction', async () => {
    const f = fixture(); let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const original = f.gateway.request; f.gateway.request = vi.fn((method, params, signal) => method === 'sessions.patch' ? Promise.reject(Error('lost')) : original(method, params, signal));
    let first!: { target: typeof target; selectionId: string; model: null };
    for (let i = 0; i < 1000; i++) {
      now += 60001; const snap = await f.models.read(target); const input = { target, selectionId: snap.selectionId, model: null };
      if (i === 0) first = input; expect((await f.models.select(input)).outcome).toBe('unknown');
    }
    now += 60001; const snap = await f.models.read(target);
    await expect(f.models.select({ target, selectionId: snap.selectionId, model: null })).rejects.toMatchObject({ code: 'rate-limited' });
    expect(await f.models.select(first)).toEqual({ target, outcome: 'unknown' });
    expect(vi.mocked(f.gateway.request).mock.calls.filter(x => x[0] === 'sessions.patch')).toHaveLength(1000);
  });
  it('limits new applies to ten per minute but lets identical retries return their original result', async () => {
    const f = fixture(); const original = f.gateway.request; f.gateway.request = vi.fn((method, params, signal) => method === 'sessions.patch' ? Promise.reject(new GatewayRequestError('unavailable')) : original(method, params, signal));
    for (let i = 0; i < 10; i++) { const snap = await f.models.read(target); expect((await f.models.select({ target, selectionId: snap.selectionId, model: null })).outcome).toBe('unknown'); }
    const snap = await f.models.read(target); await expect(f.models.select({ target, selectionId: snap.selectionId, model: null })).rejects.toMatchObject({ code: 'rate-limited' });
  });
  it('binds the whole immutable payload, including target metadata permitted by the closed contract', async () => {
    const f = fixture(); const snap = await f.models.read(target); const input = { target, selectionId: snap.selectionId, model: 'provider/new' };
    await f.models.select(input);
    await expect(f.models.select({ ...input, target: { ...target, activeLeafEntryId: 'different' } })).rejects.toMatchObject({ code: 'invalid-request' });
  });
  it('does not return private cached confirmations after native authority is revoked', async () => {
    const f = fixture(); const snap = await f.models.read(target); const input = { target, selectionId: snap.selectionId, model: 'provider/new' };
    expect((await f.models.select(input)).outcome).toBe('confirmed');
    f.gateway.status = () => ({ configured: true, state: 'auth-error', canRead: false, canSend: false });
    f.emit('source.invalidated'); await expect(f.models.select(input)).rejects.toMatchObject({ code: 'scope-required' });
  });
  it('serializes different observations of the same stable target before any second native dispatch', async () => {
    const f = fixture(); const a = await f.models.read(target); const b = await f.models.read(target); const wait = deferred<unknown>();
    const original = f.gateway.request; f.gateway.request = vi.fn((method, params, signal) => method === 'sessions.patch' ? wait.promise : original(method, params, signal));
    const first = f.models.select({ target, selectionId: a.selectionId, model: 'provider/new' });
    await vi.waitFor(() => expect(f.gateway.request).toHaveBeenCalledWith('sessions.patch', expect.any(Object)));
    await expect(f.models.select({ target, selectionId: b.selectionId, model: 'provider/new' })).rejects.toMatchObject({ code: 'model-busy' });
    wait.resolve(f.receipt); expect((await first).outcome).toBe('unknown');
    expect(vi.mocked(f.gateway.request).mock.calls.filter(x => x[0] === 'sessions.patch')).toHaveLength(1);
  });
  it.each(['busy', 'permission', 'capability', 'source', 'expiry', 'model'] as const)('fences %s arriving while the fresh catalog is pending', async kind => {
    const f = fixture(); const snap = await f.models.read(target); const wait = deferred<unknown>();
    const original = f.gateway.request; f.gateway.request = vi.fn((method, params, signal) => method === 'models.list' ? wait.promise : original(method, params, signal));
    const result = f.models.select({ target, selectionId: snap.selectionId, model: 'provider/new' });
    const rejected = expect(result).rejects.toBeDefined();
    await vi.waitFor(() => expect(f.gateway.request).toHaveBeenCalledWith('models.list', expect.any(Object), undefined));
    if (kind === 'busy') f.row.hasActiveRun = true;
    if (kind === 'permission') f.row.sendPolicy = 'deny';
    if (kind === 'capability') f.caps.canChange = false;
    if (kind === 'source') f.emit();
    if (kind === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60000);
    if (kind === 'model') f.row.model = 'changed';
    wait.resolve(f.catalog); await rejected; expect(vi.mocked(f.gateway.request).mock.calls.some(x => x[0] === 'sessions.patch')).toBe(false);
  });
  it('ignores an aborted read immediately even when a transport replies late', async () => {
    const f = fixture(); const wait = deferred<unknown>(); const original = f.gateway.request;
    f.gateway.request = vi.fn((method, params, signal) => method === 'models.list' ? wait.promise : original(method, params, signal));
    const controller = new AbortController(); const result = f.models.read(target, controller.signal); const rejected = expect(result).rejects.toMatchObject({ code: 'unavailable' });
    await vi.waitFor(() => expect(f.gateway.request).toHaveBeenCalledWith('models.list', expect.any(Object), expect.any(AbortSignal)));
    controller.abort(); await rejected; wait.resolve(f.catalog);
  });
  it.each(['branch', 'lifecycle', 'owner', 'authority', 'source', 'presentation'] as const)('reports unknown, retaining the operation, when %s changes after dispatch', async kind => {
    const f = fixture(); const snap = await f.models.read(target); const wait = deferred<unknown>(); const original = f.gateway.request;
    f.gateway.request = vi.fn((method, params, signal) => method === 'sessions.patch' ? wait.promise : original(method, params, signal));
    const input = { target, selectionId: snap.selectionId, model: 'provider/new' }; const result = f.models.select(input);
    await vi.waitFor(() => expect(f.gateway.request).toHaveBeenCalledWith('sessions.patch', expect.any(Object)));
    if (kind === 'branch') f.row.branchId = 'changed';
    if (kind === 'lifecycle') f.row.lifecycleRevision = 'changed';
    if (kind === 'owner') f.owners.clear();
    if (kind === 'authority') f.caps.canRead = false;
    if (kind === 'source') f.emit('source.invalidated');
    if (kind === 'presentation') f.row.model = 'concurrent-client';
    wait.resolve(f.receipt); expect(await result).toEqual({ target, outcome: 'unknown' });
    f.caps.canRead = true; expect(await f.models.select(input)).toEqual({ target, outcome: 'unknown' });
    expect(vi.mocked(f.gateway.request).mock.calls.filter(x => x[0] === 'sessions.patch')).toHaveLength(1);
  });
  it('rejects read completion on close and never admits a later mutation', async () => {
    const f = fixture(); const snap = await f.models.read(target); const wait = deferred<unknown>(); const original = f.gateway.request;
    f.gateway.request = vi.fn((method, params, signal) => method === 'models.list' ? wait.promise : original(method, params, signal));
    const reading = f.models.read(target); const rejected = expect(reading).rejects.toMatchObject({ code: 'unavailable' });
    f.models.close(); await rejected; wait.resolve(f.catalog);
    await expect(f.models.select({ target, selectionId: snap.selectionId, model: null })).rejects.toMatchObject({ code: 'unavailable' });
    expect(vi.mocked(f.gateway.request).mock.calls.some(x => x[0] === 'sessions.patch')).toBe(false);
  });
  it.each(['model@account', 'model@20261030@account', 'model@q4@account'])('rejects native credential-selector catalog ID %s before any mutation', async id => {
    const f = fixture(); f.catalog.models[1].id = id;
    await expect(f.models.read(target)).rejects.toMatchObject({ code: 'invalid-source' });
    await expect(f.models.select({ target, selectionId: 'unobserved', model: `provider/${id}` })).rejects.toMatchObject({ code: 'invalid-request' });
    expect(f.calls.some(x => x.method === 'sessions.patch')).toBe(false);
  });
  it.each(['absent', 'nonselectable', 'unavailable'] as const)('denies originally %s choices even when the fresh catalog now permits them', async kind => {
    const f = fixture(); const choice = structuredClone(f.catalog.models[1]);
    if (kind === 'absent') f.catalog.models.pop();
    if (kind === 'nonselectable') f.catalog.models[1].manualSelectionAllowed = false;
    if (kind === 'unavailable') f.catalog.models[1].available = false;
    const snap = await f.models.read(target); f.catalog.models[1] = choice;
    await expect(f.models.select({ target, selectionId: snap.selectionId, model: 'provider/new' })).rejects.toMatchObject({ code: 'model-denied' });
    expect(f.calls.some(x => x.method === 'sessions.patch')).toBe(false);
  });
});
