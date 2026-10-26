// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { ControlGateway, GatewayEvent } from './gatewayClient';
import { GatewayRequestError } from './gatewayClient';
import { createTaskService } from './taskService';
import { createUsageService } from './usageService';

const target = { agentId: 'cylena', sessionKey: 'agent:cylena:usage', sessionId: 'instance-1', lifecycleRevision: 'rev1', branchId: 'branch1' };
const cleanup: Array<() => void> = []; afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture() {
  const listeners = new Set<(event: GatewayEvent) => void>(); const registered = new Set(['cylena']);
  let row = { ...target, key: target.sessionKey, model: 'fixture-model', modelProvider: 'fixture', contextTokens: 128000, totalTokens: 99000, totalTokensFresh: true };
  let raw: unknown = { updatedAt: 1500, sessions: [{ key: target.sessionKey, agentId: 'cylena', sessionId: target.sessionId, scope: 'instance',
    usage: { input: 0, output: 20, cacheRead: 30, cacheWrite: 2, totalTokens: 52, totalCost: 0.25, missingCostEntries: 0, computedAt: 1000, sessionFile: '/never-expose' } }], cacheStatus: { status: 'fresh' }, totals: { totalCost: 9999 } };
  let duringRead = () => {}; let duringDescription = (_count: number) => {}; let descriptions = 0; let failure: Error | undefined;
  const request = vi.fn(async (method: string, _params: Record<string, unknown>, _signal?: AbortSignal): Promise<unknown> => {
    if (method === 'sessions.describe') { duringDescription(++descriptions); return { session: structuredClone(row) }; }
    if (method === 'sessions.usage') { duringRead(); if (failure) throw failure; return raw; }
    if (method === 'sessions.subscribe') return {};
    throw Error(`Unexpected RPC: ${method}`);
  });
  const gateway: ControlGateway = { request, status: () => ({ configured: true, state: 'ready', canRead: true, canSend: false }),
    start() {}, close() {}, onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const tasks = createTaskService(gateway, () => registered); const service = createUsageService(gateway, tasks);
  cleanup.push(() => { service.close(); tasks.close(); }); request.mockClear();
  return { service, request, registered, read: () => service.read(target), setRaw: (value: unknown) => { raw = value; }, raw: () => raw as Record<string, unknown>,
    mutate: (change: Partial<typeof row>) => { row = { ...row, ...change }; }, during: (fn: () => void) => { duringRead = fn; },
    fail: (error: Error) => { failure = error; }, onDescription: (fn: (count: number) => void) => { duringDescription = fn; }, disconnect: () => { for (const listener of listeners) listener({ event: 'source.invalidated', payload: null }); } };
}
it('reads exactly one instance and exposes only normalized metrics, not host paths or global totals', async () => {
  const f = fixture(); const value = await f.read();
  expect(value).toMatchObject({ target, state: 'ready', tokens: { input: 0, output: 20, cacheRead: 30, total: 52 }, cost: { usd: 0.25, missingEntries: 0 }, computedAt: 1000, model: 'fixture/fixture-model', contextLimit: 128000 });
  expect(value).not.toHaveProperty('contextUsed'); expect(JSON.stringify(value)).not.toContain('never-expose'); expect(JSON.stringify(value)).not.toContain('9999');
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['sessions.describe', 'sessions.usage', 'sessions.describe']);
  expect(f.request.mock.calls[1]).toHaveLength(3);
  expect(f.request.mock.calls[1][1]).toEqual({ key: target.sessionKey, agentId: 'cylena', range: 'all', groupBy: 'instance', limit: 1, includeContextWeight: false });
});
it('keeps partial cache/pricing and the original native computation time explicit', async () => {
  const f = fixture(); const raw = f.raw(); const row = (raw.sessions as Array<Record<string, unknown>>)[0];
  row.usage = { output: 0, totalCost: 0, missingCostEntries: 3, computedAt: 1000, refreshing: true };
  raw.cacheStatus = { status: 'partial' };
  const value = await f.read(); expect(value.state).toBe('partial'); expect(value.tokens).toEqual({ output: 0 });
  expect(value.cost).toEqual({ usd: 0, missingEntries: 3 }); expect(value.computedAt).toBe(1000);
});
it('distinguishes loading, absent and unsupported usage without synthetic zeros', async () => {
  const f = fixture(); f.setRaw({ sessions: [{ key: target.sessionKey, agentId: 'cylena', sessionId: target.sessionId, usage: null, computing: true }] });
  expect(await f.read()).toMatchObject({ state: 'loading', tokens: {}, cost: {} });
  f.setRaw({ sessions: [] }); expect(await f.read()).toMatchObject({ state: 'unavailable', tokens: {} });
  f.fail(new GatewayRequestError('unsupported')); expect(await f.read()).toMatchObject({ state: 'unsupported', contextLimit: 128000, tokens: {} });
});
it.each(['agentId', 'sessionId', 'key', 'scope'])('rejects a foreign or aggregated %s', async field => {
  const f = fixture(); const row = (f.raw().sessions as Array<Record<string, unknown>>)[0]; row[field] = field === 'scope' ? 'family' : 'other';
  await expect(f.read()).rejects.toMatchObject({ code: 'invalid-source' });
});
it.each(['session', 'branch', 'registry', 'connection', 'close'])('refuses a late read after %s changes', async change => {
  const f = fixture(); f.during(() => {
    if (change === 'session') f.mutate({ sessionId: 'replacement' });
    else if (change === 'branch') f.mutate({ branchId: 'replacement' });
    else if (change === 'registry') f.registered.clear();
    else if (change === 'connection') f.disconnect(); else f.service.close();
  });
  await expect(f.read()).rejects.toBeDefined();
});
it('rejects invalid numeric data and forwards scoped access failures', async () => {
  const f = fixture(); (f.raw().sessions as Array<Record<string, unknown>>)[0].usage = { input: -3 };
  await expect(f.read()).rejects.toMatchObject({ code: 'invalid-source' });
  f.fail(new GatewayRequestError('scope-required')); await expect(f.read()).rejects.toMatchObject({ code: 'scope-required' });
  f.registered.clear(); f.request.mockClear(); await expect(f.read()).rejects.toMatchObject({ code: 'invalid-target' }); expect(f.request).not.toHaveBeenCalled();
});
it('rechecks registry membership after the final canonical describe resolves', async () => {
  const f = fixture(); f.onDescription(count => { if (count === 2) f.registered.clear(); });
  await expect(f.read()).rejects.toMatchObject({ code: 'invalid-target' });
});
