// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlRouter } from './routes';
import { loadControlConfig } from './config';
import { createTaskService } from './taskService';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';
import { createModelService } from './modelService';
import * as modelModule from './modelService';

const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 's1' };
const closers: (() => void)[] = [];
afterEach(() => { closers.splice(0).forEach(close => close()); vi.restoreAllMocks(); });
function fixture(writeEnabled = true) {
  let selected = 'old';
  const gateway: ControlGateway = { start() {}, close() {}, onEvent: () => () => {},
    status: () => ({ configured: true, state: 'ready', canRead: true, canSend: false }),
    modelCapabilities: () => ({ canRead: true, canChange: true }),
    request: vi.fn(async method => {
      if (method === 'sessions.describe') return { session: { key: target.sessionKey, agentId: 'cylena', sessionId: 's1', hasActiveRun: false, modelProvider: 'p', model: selected } };
      if (method === 'models.list') return { models: [{ provider: 'p', id: 'new', name: 'New', manualSelectionAllowed: true, available: true }] };
      if (method === 'sessions.patch') { selected = 'new'; return { ok: true, key: target.sessionKey, path: '/private/synthetic-store', entry: { sessionId: 's1', providerOverride: 'p', modelOverride: 'new', modelOverrideSource: 'user', modelOverrideRouteResolution: 'resolved' }, resolved: { modelProvider: 'p', model: 'new' } }; }
      return { sessions: [] };
    }) };
  const tasks = createTaskService(gateway, () => new Set(['cylena'])); closers.push(() => tasks.close());
  const models = createModelService(gateway, tasks); closers.push(() => models.close());
  vi.mocked(gateway.request).mockClear();
  const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'ws://localhost:18789', PIXEL_CONTROL_TOKEN: 'fixture-key' }, '/tmp/model-route-fixture');
  config.sendEnabled = writeEnabled;
  const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway, tasks, config, models }));
  return { app, gateway };
}
describe('protected model routes', () => {
  it('owns model service disposal on server close even without startServer', async () => {
    const close = vi.fn();
    const factory = vi.spyOn(modelModule, 'createModelService').mockReturnValue({ read: vi.fn(), select: vi.fn(), close });
    const { server, io } = await import('../index');
    try { server.emit('close'); expect(close).toHaveBeenCalledTimes(1); } finally { factory.mockRestore(); await io.close(); }
  });
  it('protects both closed POST routes before any source read, and keeps responses no-store', async () => {
    const f = fixture();
    for (const path of ['models', 'model']) {
      const response = await request(f.app).post(`/api/control/agents/cylena/${path}`).send({ target });
      expect(response.status).toBe(401); expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(f.gateway.request).not.toHaveBeenCalled();
  });
  it('rejects route mismatch, historical run and metadata-bearing targets', async () => {
    const f = fixture();
    for (const body of [{ target: { ...target, agentId: 'other' } }, { target, runId: 'run1' }, { target: { ...target, name: 'metadata' } }, { target, refresh: true }]) {
      expect((await request(f.app).post('/api/control/agents/cylena/models').auth('fixture-key', { type: 'bearer' }).send(body)).status).toBe(400);
      expect((await request(f.app).post('/api/control/agents/cylena/model').auth('fixture-key', { type: 'bearer' }).send({ ...body, selectionId: 'o1', model: null })).status).toBe(400);
    }
    expect(f.gateway.request).not.toHaveBeenCalled();
  });
  it('returns only normalized private snapshots and confirmed preference outcomes', async () => {
    const f = fixture(); const read = await request(f.app).post('/api/control/agents/cylena/models').auth('fixture-key', { type: 'bearer' }).send({ target });
    expect(read.status).toBe(200); expect(read.body).toMatchObject({ target, currentModel: 'p/old', choices: [{ id: 'p/new', label: 'New', selectable: true, available: true }] });
    const result = await request(f.app).post('/api/control/agents/cylena/model').auth('fixture-key', { type: 'bearer' }).send({ target, selectionId: read.body.selectionId, model: 'p/new' });
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ target, outcome: 'confirmed', snapshot: { currentModel: 'p/new' } });
    expect(result.headers['cache-control']).toBe('no-store'); expect(JSON.stringify(result.body)).not.toMatch(/path|Override|private/);
  });
  it('requires write opt-in independently of send readiness and preserves the transport guard', async () => {
    const f = fixture(false); const read = await request(f.app).post('/api/control/agents/cylena/models').auth('fixture-key', { type: 'bearer' }).send({ target });
    const result = await request(f.app).post('/api/control/agents/cylena/model').auth('fixture-key', { type: 'bearer' }).send({ target, selectionId: read.body.selectionId, model: null });
    expect(result.status).toBe(403); expect(result.body.code).toBe('model-denied');
    expect(vi.mocked(f.gateway.request).mock.calls.some(call => call[0] === 'sessions.patch')).toBe(false);
    const insecure = await request(f.app).post('/api/control/agents/cylena/models').set('X-Forwarded-For', '198.51.100.8').auth('fixture-key', { type: 'bearer' }).send({ target });
    expect(insecure.status).toBe(403); expect(insecure.body.code).toBe('transport-required');
  });
  it.each([['model-denied', 403], ['model-busy', 409], ['unsupported', 501]] as const)('keeps %s method-local and does not reveal source diagnostics', async (code, status) => {
    const f = fixture(); const original = f.gateway.request;
    f.gateway.request = vi.fn((method, params, signal) => { if (method === 'models.list') throw new GatewayRequestError(code); return original(method, params, signal); });
    const result = await request(f.app).post('/api/control/agents/cylena/models').auth('fixture-key', { type: 'bearer' }).send({ target });
    expect(result.status).toBe(status); expect(result.body).toEqual({ code, error: 'The private request could not be completed.' });
    expect((await request(f.app).get('/api/control/agents/cylena/sessions').auth('fixture-key', { type: 'bearer' })).status).toBe(200);
    expect((await request(f.app).get('/api/control/status').auth('fixture-key', { type: 'bearer' })).body.canRead).toBe(true);
  });
});
