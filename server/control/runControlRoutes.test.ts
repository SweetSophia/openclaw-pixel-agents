// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlRouter } from './routes';
import { loadControlConfig } from './config';
import { ControlError, createTaskService } from './taskService';
import type { ControlGateway } from './gatewayClient';

const input = { target: { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 's1' }, runId: 'run-1' };
const cleanups: (() => void)[] = []; afterEach(() => cleanups.splice(0).forEach(close => close()));
function fixture(enabled = true, service = true) {
  const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'ws://localhost:18789', PIXEL_CONTROL_TOKEN: 'fixture-key', CONTROL_SEND_ENABLED: String(enabled) }, '/tmp/fixture');
  const gateway: ControlGateway = { start() {}, close() {}, status: () => ({ configured: true, state: 'ready', canRead: true, canSend: true, canStop: true }), request: vi.fn(async () => ({})), onEvent: () => () => {} };
  const tasks = createTaskService(gateway, () => new Set(['cylena'])); cleanups.push(() => tasks.close());
  const stop = vi.fn(async () => ({ ...input, phase: 'requested' as const }));
  const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway, tasks, config, ...(service ? { runControls: { stop, close() {} } } : {}) }));
  return { app, stop };
}
describe('private Stop route', () => {
  it('requires authentication and secure transport, then forwards a validated exact selection with no-store', async () => {
    const f = fixture(); const url = '/api/control/agents/cylena/stop';
    expect((await request(f.app).post(url).send(input)).status).toBe(401); expect(f.stop).not.toHaveBeenCalled();
    const response = await request(f.app).post(url).auth('fixture-key', { type: 'bearer' }).send(input);
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store'); expect(f.stop).toHaveBeenCalledWith(input, expect.any(AbortSignal));
    f.app.set('trust proxy', 1);
    expect((await request(f.app).post(url).set('X-Forwarded-For', '198.51.100.1').auth('fixture-key', { type: 'bearer' }).send(input)).status).toBe(403);
    expect(f.stop).toHaveBeenCalledTimes(1);
  });
  it('rejects route mismatch, extras, unidentified and bidi-spoofed runs before mutation', async () => {
    const f = fixture();
    for (const body of [{ target: input.target }, { ...input, runId: 'run\u202e1' }, { ...input, clearQueued: true }, { ...input, target: { ...input.target, method: 'sessions.abort' } }, { ...input, target: { ...input.target, agentId: 'other' } }]) {
      expect((await request(f.app).post('/api/control/agents/cylena/stop').auth('fixture-key', { type: 'bearer' }).send(body)).status).toBe(400);
    }
    expect(f.stop).not.toHaveBeenCalled();
  });
  it('requires opted-in writes and an installed service', async () => {
    const f = fixture(false);
    expect((await request(f.app).post('/api/control/agents/cylena/stop').auth('fixture-key', { type: 'bearer' }).send(input)).status).toBe(403); expect(f.stop).not.toHaveBeenCalled();
    const missing = fixture(true, false);
    expect((await request(missing.app).post('/api/control/agents/cylena/stop').auth('fixture-key', { type: 'bearer' }).send(input)).status).toBe(501);
  });
  it.each([['stop-denied', 403], ['scope-required', 403], ['session-changed', 409], ['invalid-target', 404], ['unsupported', 501], ['rate-limited', 429], ['unavailable', 503], ['invalid-source', 503]] as const)('maps %s without leaking diagnostics', async (code, status) => {
    const f = fixture(); f.stop.mockRejectedValue(new ControlError(code));
    const response = await request(f.app).post('/api/control/agents/cylena/stop').auth('fixture-key', { type: 'bearer' }).send(input);
    expect(response.status).toBe(status); expect(response.body.code).toBe(code); expect(response.headers['cache-control']).toBe('no-store');
  });
});
