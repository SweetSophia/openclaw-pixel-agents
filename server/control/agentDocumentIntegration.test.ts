// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentDocumentGateway, type ControlGateway } from './gatewayClient';
import { loadAgentDocumentConfig } from './agentDocumentConfig';
import { createAgentDocumentService } from './agentDocumentService';
import { createControlRouter } from './routes';
import { createTaskService } from './taskService';
import { loadControlConfig } from './config';
import { createWorkspaceService } from './workspaceService';
import { documentFixture, encodeDocumentFrame } from './fixtures/agentDocuments';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllEnvs(); vi.resetModules(); });
async function appFixture(enabled = true, options: Parameters<typeof documentFixture>[0] = {}) {
  const host = await documentFixture(options); cleanups.push(() => host.close()); host.config.enabled = enabled;
  const documentGateway = createAgentDocumentGateway(host.config);
  const documents = createAgentDocumentService(documentGateway, () => new Set(['main'])); cleanups.push(() => documents.close());
  const ordinaryFrames: unknown[] = [];
  const gateway: ControlGateway = { start() {}, close() {}, onEvent: () => () => {}, status: () => ({ configured: true, state: 'ready', canRead: true, canSend: false }), async request(method, params) { ordinaryFrames.push({ method, params }); return { agentId: 'main', path: '', offset: 0, totalEntries: 0, entries: [] }; } };
  const tasks = createTaskService(gateway, () => new Set(['main'])); cleanups.push(() => tasks.close());
  const workspace = createWorkspaceService(gateway, () => new Set(['main'])); cleanups.push(() => workspace.close());
  const app = express(); app.use(express.json({ limit: '100kb' }));
  app.use('/api/control', createControlRouter({ gateway, tasks, workspace, documents, config: host.control }));
  return { app, host, documentGateway, ordinaryFrames };
}
describe('authenticated document route and signed native integration', () => {
  const path = '/api/control/agents/main/documents';
  it('reports document-local pairing admission denial while the ordinary office key stays valid', async () => {
    let connects = 0;
    const { app, host, documentGateway } = await appFixture(true, { onRequest(frame, socket) {
      if (frame.method !== 'connect' || ++connects === 1) return;
      socket.write(encodeDocumentFrame({ type: 'res', id: frame.id, ok: false, error: { code: 'INVALID_REQUEST', details: { code: 'PAIRING_REQUIRED' } } })); return true;
    } });
    await request(app).get(`${path}/status`).auth('document-access-fixture', { type: 'bearer' });
    await vi.waitFor(() => expect(documentGateway.status().canEdit).toBe(true));
    const loaded = await request(app).post(`${path}/read`).auth('document-access-fixture', { type: 'bearer' }).send({ name: 'AGENTS.md' });
    expect(loaded.status).toBe(200);
    for (const socket of host.sockets) socket.destroy();
    await vi.waitFor(() => expect(documentGateway.status().state).toBe('pairing-required'), { timeout: 2000 });
    for (const [operation, body] of [['read', { name: 'AGENTS.md' }], ['save', { name: 'AGENTS.md', revision: loaded.body.revision, operationId: 'pairing-admission-operation', content: 'private draft' }]] as const) {
      const denied = await request(app).post(`${path}/${operation}`).auth('document-access-fixture', { type: 'bearer' }).send(body);
      expect(denied.status).toBe(403); expect(denied.body.code).toBe('document-denied');
    }
    expect(documentGateway.status()).toMatchObject({ state: 'pairing-required', reason: 'pairing-required', canEdit: false });
    const ordinary = await request(app).get('/api/control/status').auth('document-access-fixture', { type: 'bearer' });
    expect(ordinary.status).toBe(200); expect(ordinary.body.canRead).toBe(true);
    expect(host.frames.map(frame => frame.method)).toEqual(['connect', 'agents.files.get', 'connect']);
  });
  it('runs access/transport validation before lazy identity creation and preserves exact agent params', async () => {
    const { app, host } = await appFixture();
    expect((await request(app).get(`${path}/status`)).status).toBe(401);
    expect((await request(app).post(`${path}/read`).send({ name: 'AGENTS.md' })).status).toBe(401);
    expect((await request(app).post(`${path}/save`).send({})).status).toBe(401);
    expect((await request(app).get(`${path}/status`).set('X-Forwarded-For', '198.51.100.1').auth('document-access-fixture', { type: 'bearer' })).status).toBe(403);
    const invalidAgent = await request(app).get('/api/control/agents/MAIN/documents/status').auth('document-access-fixture', { type: 'bearer' });
    expect(invalidAgent.status).toBe(404); expect(invalidAgent.body.code).toBe('invalid-target');
    expect(host.frames).toEqual([]); expect(existsSync(host.config.deviceDirectory)).toBe(false);
    const status = await request(app).get(`${path}/status`).auth('document-access-fixture', { type: 'bearer' }); expect(status.status).toBe(200);
    await vi.waitFor(() => expect(host.frames).toHaveLength(1));
    await vi.waitFor(async () => expect((await request(app).get(`${path}/status`).auth('document-access-fixture', { type: 'bearer' })).body.canEdit).toBe(true));
    const read = await request(app).post(`${path}/read`).auth('document-access-fixture', { type: 'bearer' }).send({ name: 'AGENTS.md' });
    expect(read.status).toBe(200); expect(read.headers['cache-control']).toBe('no-store'); expect(JSON.stringify(read.body)).not.toContain('/fixture');
    const saved = await request(app).post(`${path}/save`).auth('document-access-fixture', { type: 'bearer' }).send({ name: 'AGENTS.md', revision: read.body.revision, operationId: 'browser-document-operation', content: 'private new draft' });
    expect(saved.status).toBe(200); expect(saved.body).toMatchObject({ agentId: 'main', state: 'saved', snapshot: { content: 'private new draft' } });
    expect(host.frames.map(frame => frame.method)).toEqual(['connect', 'agents.files.get', 'agents.files.set']);
  });
  it('ordinary workspace browsing and disabled editor never create document identity/authority', async () => {
    const { app, host, ordinaryFrames } = await appFixture(false);
    const browse = await request(app).post('/api/control/agents/main/workspace').auth('document-access-fixture', { type: 'bearer' }).send({}); expect(browse.status).toBe(200);
    const status = await request(app).get(`${path}/status`).auth('document-access-fixture', { type: 'bearer' });
    expect(status.body).toEqual({ configured: false, state: 'disabled', canEdit: false, epoch: null, reason: 'disabled' });
    expect((await request(app).post(`${path}/read`).auth('document-access-fixture', { type: 'bearer' }).send({ name: 'AGENTS.md' })).body.code).toBe('disabled');
    expect(host.frames).toEqual([]); expect(existsSync(host.config.deviceDirectory)).toBe(false);
    expect(ordinaryFrames).toContainEqual({ method: 'agents.workspace.list', params: { agentId: 'main', path: '', offset: 0, limit: 50 } });
  });
  it('rejects closed-body/query violations and consumes no native frame', async () => {
    const { app, host } = await appFixture();
    for (const body of [{ name: '../AGENTS.md' }, { name: 'agents.md' }, { name: 'BOOTSTRAP.md' }, { name: 'AGENTS.md', path: '/private' }]) expect((await request(app).post(`${path}/read`).auth('document-access-fixture', { type: 'bearer' }).send(body)).status).toBe(400);
    expect((await request(app).get(`${path}/status?force=true`).auth('document-access-fixture', { type: 'bearer' })).status).toBe(400);
    expect((await request(app).post(`${path}/save`).auth('document-access-fixture', { type: 'bearer' }).send({ name: 'AGENTS.md', revision: 'revision', operationId: 'operation', content: '', expectedWorkspace: '/private' })).status).toBe(400);
    expect(host.frames).toEqual([]); expect(existsSync(host.config.deviceDirectory)).toBe(false);
  });
  it('real default-off index startup keeps Origin/auth guards and creates no document directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pixel-document-startup-')); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATA_DIR', directory); vi.stubEnv('DATA_SOURCE', 'ingest'); vi.stubEnv('INGEST_API_TOKEN', 'fixture-ingest');
    vi.stubEnv('OPENCLAW_GATEWAY_URL', 'ws://127.0.0.1:1'); vi.stubEnv('PIXEL_CONTROL_TOKEN', 'startup-fixture-key'); vi.stubEnv('CONTROL_DOCUMENTS_EDIT_ENABLED', 'false'); vi.stubEnv('OPENCLAW_DOCUMENTS_GATEWAY_TOKEN', 'disabled-fixture-secret');
    vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
    const runtime = await import('../index'); cleanups.push(() => new Promise<void>(resolve => runtime.server.close(() => resolve())));
    expect(existsSync(join(directory, 'control-documents'))).toBe(false);
    const denied = await request(runtime.app).post(`${path}/read`).set('Origin', 'https://untrusted.invalid').auth('startup-fixture-key', { type: 'bearer' }).send({ name: 'AGENTS.md' }); expect(denied.status).toBe(403);
    const locked = await request(runtime.app).post(`${path}/read`).set('Origin', 'http://localhost:3000').send({ name: 'AGENTS.md' }); expect(locked.status).toBe(401);
    const status = await request(runtime.app).get(`${path}/status`).auth('startup-fixture-key', { type: 'bearer' }); expect(status.status).toBe(200); expect(status.body.canEdit).toBe(false);
    expect(existsSync(join(directory, 'control-documents'))).toBe(false);
  });
});
