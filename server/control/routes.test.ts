// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createControlRouter } from './routes';
import { loadControlConfig } from './config';
import type { ControlGateway } from './gatewayClient';
import { createTaskService } from './taskService';

describe('private control routes', () => {
  function fixture(enabled = true) {
    const config = loadControlConfig(enabled ? { OPENCLAW_GATEWAY_URL: 'ws://localhost:18789', PIXEL_CONTROL_TOKEN: 'fixture-key' } : {}, '/tmp/fixture');
    const gateway: ControlGateway = { start() {}, close() {}, status: () => ({ configured: enabled, state: enabled ? 'ready' : 'disabled', canRead: enabled, canSend: false }), request: vi.fn(async () => ({ sessions: [] })), onEvent: () => () => {} };
    const tasks = createTaskService(gateway, () => new Set(['cylena']));
    vi.mocked(gateway.request).mockClear();
    const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway, tasks, config }));
    return { app, gateway, tasks };
  }
  it('allows disabled status without exposing configured capabilities and marks private responses no-store', async () => {
    const disabled = fixture(false); expect((await request(disabled.app).get('/api/control/status')).body).toMatchObject({ configured: false, state: 'disabled' }); disabled.tasks.close();
    const f = fixture(); expect((await request(f.app).get('/api/control/status')).status).toBe(401);
    const res = await request(f.app).get('/api/control/status').auth('fixture-key', { type: 'bearer' });
    expect(res.body).toMatchObject({ canRead: true, canSend: false }); expect(res.headers['cache-control']).toBe('no-store'); f.tasks.close();
  });
  it('validates route/body identity, bounded cursor and unknown fields before Gateway work', async () => {
    const f = fixture();
    for (const body of [{}, { sessionKey: 'agent:cylena:fixture', sessionId: 's1', agentId: 'other' }, { sessionKey: 'agent:cylena:fixture', sessionId: 's1', method: 'chat.send' }]) {
      const res = await request(f.app).post('/api/control/agents/cylena/task').auth('fixture-key', { type: 'bearer' }).send(body); expect(res.status).toBe(400);
    }
    expect((await request(f.app).get(`/api/control/agents/cylena/sessions?cursor=${'x'.repeat(2049)}`).auth('fixture-key', { type: 'bearer' })).status).toBe(400);
    expect(f.gateway.request).not.toHaveBeenCalled(); f.tasks.close();
  });
  it('authenticates and validates sends while rejecting writes by default', async () => {
    const f = fixture(); const url = '/api/control/agents/cylena/send';
    const body = { agentId: 'cylena', newConversation: true, message: 'hello', idempotencyKey: 'send-fixture' };
    expect((await request(f.app).post(url).send(body)).status).toBe(401);
    expect((await request(f.app).post(url).auth('fixture-key', { type: 'bearer' }).send({ ...body, deliver: true })).status).toBe(400);
    const disabled = await request(f.app).post(url).auth('fixture-key', { type: 'bearer' }).send(body);
    expect(disabled.status).toBe(403); expect(disabled.body.code).toBe('scope-required');
    expect(f.gateway.request).not.toHaveBeenCalled(); f.tasks.close();
  });
  it('returns only normalized session lists and never offers a generic RPC route', async () => {
    const f = fixture(); const res = await request(f.app).get('/api/control/agents/cylena/sessions').auth('fixture-key', { type: 'bearer' });
    expect(res.status).toBe(200); expect(res.body.sessions).toEqual([]);
    expect((await request(f.app).post('/api/control/rpc').auth('fixture-key', { type: 'bearer' }).send({ method: 'chat.send' })).status).toBe(404); f.tasks.close();
  });
  it('retains the real application origin boundary and closes control work with the HTTP server', async () => {
    vi.resetModules(); vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('CORS_ORIGIN', 'https://pixel.test');
    vi.stubEnv('OPENCLAW_GATEWAY_URL', ''); vi.stubEnv('PIXEL_CONTROL_TOKEN', '');
    const close = vi.fn(); const start = vi.fn();
    vi.doMock('./gatewayClient', () => ({ createControlGateway: () => ({ start, close, status: () => ({ configured: false, state: 'disabled', canRead: false, canSend: false }), onEvent: () => () => {}, request: vi.fn() }) }));
    const { app, server, io } = await import('../index');
    try {
      expect((await request(app).post('/api/control/agents/main/task').set('Origin', 'https://other.test').send({})).status).toBe(403);
      expect((await request(app).get('/api/control/status')).body.state).toBe('disabled');
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      expect(start).toHaveBeenCalled();
      await new Promise<void>(resolve => server.close(() => resolve()));
      expect(close).toHaveBeenCalled();
    } finally { await io.close(); vi.doUnmock('./gatewayClient'); vi.unstubAllEnvs(); vi.resetModules(); }
  });
});
