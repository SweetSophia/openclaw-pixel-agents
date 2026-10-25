// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { loadControlConfig } from './config';
import type { ControlGateway } from './gatewayClient';
import { createTaskService } from './taskService';
import { createWorkspaceService } from './workspaceService';
import { createControlRouter } from './routes';

it('protects workspace pages and content before Gateway work and rejects arbitrary paths', async () => {
  const rpc = vi.fn(async () => ({ agentId: 'cylena', path: '', offset: 0, totalEntries: 0, entries: [] }));
  const gateway: ControlGateway = { start() {}, close() {}, onEvent: () => () => {}, request: rpc,
    status: () => ({ configured: true, state: 'ready', canRead: true, canSend: false }) };
  const tasks = createTaskService(gateway, () => new Set(['cylena'])); const workspace = createWorkspaceService(gateway, () => new Set(['cylena']));
  rpc.mockClear();
  const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'ws://localhost:18789', PIXEL_CONTROL_TOKEN: 'fixture-key' }, '/tmp/workspace-fixture');
  const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway, tasks, workspace, config }));
  try {
    for (const suffix of ['workspace', 'workspace/file']) expect((await request(app).post(`/api/control/agents/cylena/${suffix}`).send({})).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    for (const body of [{ path: '/etc/passwd' }, { path: '../private' }, { path: '', url: 'http://example.com' }]) {
      expect((await request(app).post('/api/control/agents/cylena/workspace').auth('fixture-key', { type: 'bearer' }).send(body)).status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
    const page = await request(app).post('/api/control/agents/cylena/workspace').auth('fixture-key', { type: 'bearer' }).send({});
    expect(page.status).toBe(200); expect(page.body.entries).toEqual([]); expect(page.headers['cache-control']).toBe('no-store');
    const denied = await request(app).post('/api/control/agents/other/workspace').auth('fixture-key', { type: 'bearer' }).send({});
    expect(denied.status).toBe(404); expect(rpc).toHaveBeenCalledTimes(1);
    app.set('trust proxy', 1);
    const transport = await request(app).post('/api/control/agents/cylena/workspace').set('X-Forwarded-For', '198.51.100.1').auth('fixture-key', { type: 'bearer' }).send({});
    expect(transport.status).toBe(403); expect(transport.body.code).toBe('transport-required'); expect(rpc).toHaveBeenCalledTimes(1);
  } finally { workspace.close(); tasks.close(); }
});
