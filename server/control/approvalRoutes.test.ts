// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createControlRouter } from './routes';
import { loadControlConfig } from './config';
import type { ControlGateway } from './gatewayClient';
import type { TaskService } from './taskService';
import type { ApprovalService } from './approvalService';
import { ControlError } from './errors';
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:main', sessionId: 'session-1' };
function fixture() {
  const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:18789', PIXEL_CONTROL_TOKEN: 'fixture-key', CONTROL_APPROVALS_ENABLED: 'true' }, '/tmp/fixture');
  const approvals = { read: vi.fn(async () => ({ target, source: { state: 'current', observedAt: 1 }, items: [], truncated: false })), inspect: vi.fn(), resolve: vi.fn(), close() {} } as ApprovalService;
  const gateway = { status: () => ({ configured: true, state: 'ready', canRead: true, canSend: false }) } as ControlGateway;
  const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway, config, approvals, tasks: {} as TaskService }));
  return { app, approvals };
}
describe('private approval HTTP boundary', () => {
  it('rejects history selectors, arbitrary fields, and missing inspected identity on authenticated requests', async () => {
    const f = fixture();
    const cases = [
      ['list', { target, runId: 'history' }], ['inspect', { target, id: 'id', reviewer: {} }],
      ['resolve', { target, id: 'id', kind: 'exec', decision: 'deny' }],
    ] as const;
    for (const [action, body] of cases) expect((await request(f.app).post(`/api/control/agents/cylena/approvals/${action}`).auth('fixture-key', { type: 'bearer' }).send(body)).status).toBe(400);
    expect(f.approvals.read).not.toHaveBeenCalled(); expect(f.approvals.inspect).not.toHaveBeenCalled(); expect(f.approvals.resolve).not.toHaveBeenCalled();
  });
  it('requires the private key for every approval operation before service work', async () => {
    const f = fixture();
    for (const suffix of ['/list', '/inspect', '/resolve']) expect((await request(f.app).post(`/api/control/agents/cylena/approvals${suffix}`).send({ target, id: 'id', kind: 'exec', decision: 'deny' })).status).toBe(401);
    expect(f.approvals.read).not.toHaveBeenCalled(); expect(f.approvals.inspect).not.toHaveBeenCalled(); expect(f.approvals.resolve).not.toHaveBeenCalled();
  });
  it('rejects route-owner mismatch, permanent grants and spoofing before resolving', async () => {
    const f = fixture();
    for (const body of [{ target: { ...target, agentId: 'other' }, id: 'id', kind: 'exec', decision: 'deny' },
      { target, id: 'id', kind: 'exec', decision: 'allow-always' }, { target, id: 'id', kind: 'exec', decision: 'deny', reviewer: {} }])
      expect((await request(f.app).post('/api/control/agents/cylena/approvals/resolve').auth('fixture-key', { type: 'bearer' }).send(body)).status).toBe(400);
    expect(f.approvals.resolve).not.toHaveBeenCalled();
  });
  it('uses no-store and preserves approval-local denial and unknown outcome codes', async () => {
    const f = fixture(); const read = await request(f.app).post('/api/control/agents/cylena/approvals/list').auth('fixture-key', { type: 'bearer' }).send({ target });
    expect(read.status).toBe(200); expect(read.headers['cache-control']).toBe('no-store');
    for (const [code, status] of [['approvals-denied', 403], ['approval-outcome-unknown', 409]] as const) {
      vi.mocked(f.approvals.resolve).mockRejectedValueOnce(new ControlError(code));
      const response = await request(f.app).post('/api/control/agents/cylena/approvals/resolve').auth('fixture-key', { type: 'bearer' }).send({ target, id: 'id', kind: 'exec', decision: 'deny', observationId: 'inspected' });
      expect(response.status).toBe(status); expect(response.body.code).toBe(code);
    }
  });
});
