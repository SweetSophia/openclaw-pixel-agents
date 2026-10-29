// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlRouter } from './routes';
import { loadControlConfig } from './config';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';
import type { TaskService } from './taskService';
import { createApprovalService, type ApprovalService } from './approvalService';
import { ControlError } from './errors';
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:main', sessionId: 'session-1' };
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:18789', PIXEL_CONTROL_TOKEN: 'fixture-key', CONTROL_APPROVALS_ENABLED: 'true' }, '/tmp/fixture');
  const approvals = { read: vi.fn(async () => ({ target, source: { state: 'current', observedAt: 1 }, items: [], truncated: false })), inspect: vi.fn(), resolve: vi.fn(), close() {} } as ApprovalService;
  const gateway = { status: () => ({ configured: true, state: 'ready', canRead: true, canSend: false }) } as ControlGateway;
  const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway, config, approvals, tasks: {} as TaskService }));
  return { app, approvals };
}
describe('private approval HTTP boundary', () => {
  it.each(['reads', 'failed-access'] as const)('marks the %s middleware rate rejection as pre-dispatch and permits a fresh request later', async budget => {
    const f = fixture(); let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (let i = 0; i < (budget === 'reads' ? 120 : 60); i++) {
      const operation = request(f.app).post('/api/control/agents/cylena/approvals/list');
      const response = await (budget === 'reads' ? operation.auth('fixture-key', { type: 'bearer' }) : operation).send({ target });
      expect(response.status).toBe(budget === 'reads' ? 200 : 401);
    }
    const input = { target, id: 'id', kind: 'exec', decision: 'deny', observationId: 'expired-inspection' };
    const response = await request(f.app).post('/api/control/agents/cylena/approvals/resolve').auth('fixture-key', { type: 'bearer' }).send(input);
    expect(response.status).toBe(429); expect(response.body).toMatchObject({ code: 'rate-limited', approvalDisposition: 'not-dispatched' });
    expect(f.approvals.resolve).not.toHaveBeenCalled();
    now += 60001;
    vi.mocked(f.approvals.resolve).mockResolvedValueOnce({ target, source: { state: 'current', observedAt: now }, approval: { id: 'id', kind: 'exec', title: 'Synthetic', text: 'operation', details: [], status: 'denied', createdAtMs: 1, expiresAtMs: now, resolvedAtMs: now, allowedDecisions: [] }, applied: true });
    expect((await request(f.app).post('/api/control/agents/cylena/approvals/resolve').auth('fixture-key', { type: 'bearer' }).send({ ...input, observationId: 'fresh-inspection' })).status).toBe(200);
    expect(f.approvals.resolve).toHaveBeenCalledTimes(1);
  });
  it('serializes the real service pre-native proof but not the same native rejection code', async () => {
    const f = fixture();
    const approval = { id: 'exact-id', urlPath: '/approval/exact-id', status: 'pending', createdAtMs: 1, expiresAtMs: Date.now() + 600000, presentation: { kind: 'exec', commandText: 'synthetic command', allowedDecisions: ['deny'] } };
    const native = vi.fn(async (method: string) => {
      if (method === 'sessions.messages.subscribe') return { subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 1, truncated: false, approvals: [approval] } };
      if (method === 'sessions.messages.unsubscribe') return { subscribed: false, key: target.sessionKey };
      if (method === 'approval.get') return { approval };
      throw new GatewayRequestError('approval-unavailable');
    });
    const service = createApprovalService({ status: () => ({ canRead: true, canReviewApprovals: true }), request: native, onEvent: () => () => {} } as unknown as ControlGateway, { verifyTarget: async () => ({}) } as unknown as TaskService);
    vi.mocked(f.approvals.resolve).mockImplementation((...args) => service.resolve(...args));
    try {
      const input = { target, id: 'exact-id', kind: 'exec', decision: 'deny', observationId: 'not-inspected' };
      const rejected = await request(f.app).post('/api/control/agents/cylena/approvals/resolve').auth('fixture-key', { type: 'bearer' }).send(input);
      expect(rejected.status).toBe(404); expect(rejected.body).toMatchObject({ code: 'approval-unavailable', approvalDisposition: 'not-dispatched' }); expect(native).not.toHaveBeenCalled();
      const inspected = await service.inspect({ target, id: 'exact-id' });
      const attempted = await request(f.app).post('/api/control/agents/cylena/approvals/resolve').auth('fixture-key', { type: 'bearer' }).send({ ...input, observationId: inspected.observationId });
      expect(attempted.status).toBe(404); expect(attempted.body.code).toBe('approval-unavailable'); expect(attempted.body).not.toHaveProperty('approvalDisposition');
      expect(native.mock.calls.filter(([method]) => method === 'approval.resolve')).toHaveLength(1);
    } finally { service.close(); }
  });
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
