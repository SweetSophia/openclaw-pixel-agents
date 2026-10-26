// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createControlRouter } from './routes';
import { loadControlConfig } from './config';
import type { ControlGateway } from './gatewayClient';
import { ControlError, createTaskService } from './taskService';
import type { ControlErrorCode } from '../../shared/control';
import type { ArtifactService } from './artifactService';
import type { ArtifactContent } from './artifactTransfer';
import { createServer, request as httpRequest } from 'node:http';
import type { RunHistoryService } from './runHistoryService';

describe('private control routes', () => {
  function fixture(enabled = true, sendFailure?: ControlErrorCode, artifacts?: ArtifactService, runHistory?: RunHistoryService) {
    const config = loadControlConfig(enabled ? { OPENCLAW_GATEWAY_URL: 'ws://localhost:18789', PIXEL_CONTROL_TOKEN: 'fixture-key' } : {}, '/tmp/fixture');
    const gateway: ControlGateway = { start() {}, close() {}, status: () => ({ configured: enabled, state: enabled ? 'ready' : 'disabled', canRead: enabled, canSend: false }), request: vi.fn(async () => ({ sessions: [] })), onEvent: () => () => {} };
    const tasks = createTaskService(gateway, () => new Set(['cylena']));
    const sends = sendFailure ? { send: vi.fn(async () => { throw new ControlError(sendFailure); }), close() {} } : undefined;
    if (sends) config.sendEnabled = true;
    vi.mocked(gateway.request).mockClear();
    const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway, tasks, config, sends, artifacts, runHistory }));
    return { app, gateway, tasks };
  }
  const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 'session-1' };
  const fileInput = { target, scope: { kind: 'run', runId: 'run-1' }, artifactId: 'artifact-1', intent: 'download' };
  it('authenticates and strictly validates run discovery without widening Usage or send selections', async () => {
    const runs: RunHistoryService = { read: vi.fn<RunHistoryService['read']>(async input => ({ target, source: { state: 'current', observedAt: 100 }, runs: [], runsTruncated: false, messages: [], messagesTruncated: false, limitReached: false, loadedRecords: 0, selectedRunId: input.runId })), task: vi.fn(), close() {} };
    const f = fixture(true, undefined, undefined, runs);
    expect((await request(f.app).post('/api/control/agents/cylena/runs').send(target)).status).toBe(401); expect(runs.read).not.toHaveBeenCalled();
    for (const body of [{ ...target, runId: '' }, { ...target, runId: 'bad\nrun' }, { ...target, agentId: 'other' }, { ...target, path: '/private/fixture' }, { ...target, refresh: true, cursor: 'old' }]) {
      expect((await request(f.app).post('/api/control/agents/cylena/runs').auth('fixture-key', { type: 'bearer' }).send(body)).status).toBe(400);
    }
    const body = { ...target, runId: 'older' }; const result = await request(f.app).post('/api/control/agents/cylena/runs').auth('fixture-key', { type: 'bearer' }).send(body);
    expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store'); expect(runs.read).toHaveBeenCalledWith(body, expect.any(AbortSignal));
    expect((await request(f.app).post('/api/control/agents/cylena/usage').auth('fixture-key', { type: 'bearer' }).send(body)).status).toBe(400);
    expect((await request(f.app).post('/api/control/agents/cylena/send').auth('fixture-key', { type: 'bearer' }).send({ agentId: 'cylena', target: body, newConversation: false, message: 'Hello', idempotencyKey: 'fixture-send' })).status).toBe(400);
    f.tasks.close();
  });
  it('passes an explicit historical run to Results without accepting arbitrary extra fields', async () => {
    const f = filesFixture(); const body = { ...target, runId: 'older' };
    expect((await request(f.app).post('/api/control/agents/cylena/results').auth('fixture-key', { type: 'bearer' }).send(body)).status).toBe(200);
    expect(f.artifacts.read).toHaveBeenCalledWith(body, expect.any(AbortSignal));
    expect((await request(f.app).post('/api/control/agents/cylena/results').auth('fixture-key', { type: 'bearer' }).send({ ...body, path: '/private/fixture' })).status).toBe(400); f.tasks.close();
  });
  function filesFixture() {
    const bytes: ArtifactContent = { kind: 'bytes', data: Buffer.from('{"ok":true}'), mimeType: 'application/json', filename: 'Résumé 🧪.json', truncated: false };
    const artifacts: ArtifactService = { read: vi.fn<ArtifactService['read']>(async () => ({ target, scope: { kind: 'run', runId: 'run-1' }, source: { state: 'current', observedAt: 123 },
      sourceRevision: 'source-1', runState: 'unknown', responseKind: 'none', artifactState: 'ready', artifacts: [], artifactsTruncated: false })),
      file: vi.fn<ArtifactService['file']>(async () => bytes), clear() {}, close() {} };
    return { ...fixture(true, undefined, artifacts), artifacts };
  }
  it('authenticates private results and file routes before reading content', async () => {
    const f = filesFixture();
    for (const path of ['results', 'results/file']) expect((await request(f.app).post(`/api/control/agents/cylena/${path}`).send(path === 'results' ? target : fileInput)).status).toBe(401);
    expect(f.artifacts.read).not.toHaveBeenCalled(); expect(f.artifacts.file).not.toHaveBeenCalled(); f.tasks.close();
  });
  it('retains the actual transport guard for file requests despite a forwarded client address', async () => {
    const f = filesFixture(); f.app.set('trust proxy', 1);
    const response = await request(f.app).post('/api/control/agents/cylena/results/file').set('X-Forwarded-For', '198.51.100.8').auth('fixture-key', { type: 'bearer' }).send(fileInput);
    expect(response.status).toBe(403); expect(response.body.code).toBe('transport-required'); expect(f.artifacts.file).not.toHaveBeenCalled(); f.tasks.close();
  });
  it('validates exact target/scope and route identity without accepting host paths or URLs', async () => {
    for (const body of [{ ...fileInput, path: '/fake-host-file' }, { ...fileInput, url: 'https://example.com/file' },
      { ...fileInput, target: { ...target, agentId: 'other' } }, { ...fileInput, scope: { kind: 'workspace' } },
      JSON.parse(JSON.stringify(fileInput).replace('"target":', '"constructor":{},"target":'))]) {
      const f = filesFixture(); expect((await request(f.app).post('/api/control/agents/cylena/results/file').auth('fixture-key', { type: 'bearer' }).send(body)).status).toBe(400);
      expect(f.artifacts.file).not.toHaveBeenCalled(); f.tasks.close();
    }
    const f = filesFixture(); expect((await request(f.app).post('/api/control/agents/cylena/results').auth('fixture-key', { type: 'bearer' }).send({ ...target, cursor: 'not-a-results-field' })).status).toBe(400);
    expect(f.artifacts.read).not.toHaveBeenCalled(); f.tasks.close();
  });
  it('keeps JSON file bytes distinct from link descriptors and error JSON with safe download headers', async () => {
    const f = filesFixture();
    const bytes = await request(f.app).post('/api/control/agents/cylena/results/file').auth('fixture-key', { type: 'bearer' }).send(fileInput);
    expect(bytes.status).toBe(200); expect(bytes.text).toBe('{"ok":true}'); expect(bytes.headers['x-pixel-control-file']).toBe('bytes');
    expect(bytes.headers['content-disposition']).toContain('attachment;'); expect(bytes.headers['content-disposition']).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%20%F0%9F%A7%AA.json");
    expect(bytes.headers['cache-control']).toBe('no-store'); expect(bytes.headers['x-content-type-options']).toBe('nosniff');
    vi.mocked(f.artifacts.file).mockResolvedValue({ kind: 'external', url: 'https://example.com/report', host: 'example.com', title: 'Shared report' });
    const link = await request(f.app).post('/api/control/agents/cylena/results/file').auth('fixture-key', { type: 'bearer' }).send(fileInput);
    expect(link.status).toBe(200); expect(link.headers['x-pixel-control-file']).toBe('link'); expect(link.body.host).toBe('example.com');
    f.tasks.close();
  });
  it.each([['file-unavailable', 404], ['file-too-large', 413], ['preview-unsupported', 415]] as const)('maps %s to %s without a successful-file discriminator', async (code, status) => {
    const f = filesFixture(); vi.mocked(f.artifacts.file).mockRejectedValue(new ControlError(code));
    const response = await request(f.app).post('/api/control/agents/cylena/results/file').auth('fixture-key', { type: 'bearer' }).send(fileInput);
    expect(response.status).toBe(status); expect(response.body.code).toBe(code); expect(response.headers['x-pixel-control-file']).toBeUndefined(); f.tasks.close();
  });
  it('labels shortened previews explicitly without marking a full download as shortened', async () => {
    const f = filesFixture(); vi.mocked(f.artifacts.file).mockResolvedValue({ kind: 'bytes', data: Buffer.from('short prefix'), mimeType: 'text/plain; charset=utf-8', filename: 'report.txt', truncated: true });
    const preview = await request(f.app).post('/api/control/agents/cylena/results/file').auth('fixture-key', { type: 'bearer' }).send({ ...fileInput, intent: 'preview' });
    expect(preview.status).toBe(200); expect(preview.headers['x-pixel-preview-truncated']).toBe('true'); expect(preview.headers['content-type']).toContain('charset=utf-8');
    const download = await request(f.app).post('/api/control/agents/cylena/results/file').auth('fixture-key', { type: 'bearer' }).send(fileInput);
    expect(download.headers['x-pixel-preview-truncated']).toBeUndefined(); f.tasks.close();
  });
  it('keeps content admission independent of the metadata request budget, including case-insensitive route matching', async () => {
    const f = filesFixture();
    for (let index = 0; index < 120; index++) expect((await request(f.app).get('/api/control/status').auth('fixture-key', { type: 'bearer' })).status).toBe(200);
    expect((await request(f.app).get('/api/control/status').auth('fixture-key', { type: 'bearer' })).status).toBe(429);
    expect((await request(f.app).post('/api/control/agents/cylena/Results/File').auth('fixture-key', { type: 'bearer' }).send(fileInput)).status).toBe(200); f.tasks.close();
  });
  it('aborts file work when the browser disconnects', async () => {
    const f = filesFixture(); let aborted = false;
    vi.mocked(f.artifacts.file).mockImplementation((_input, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => { aborted = true; reject(new ControlError('unavailable')); })));
    const server = createServer(f.app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture listener');
    try {
      const client = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/api/control/agents/cylena/results/file', method: 'POST',
        headers: { Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' } }); client.on('error', () => {}); client.end(JSON.stringify(fileInput));
      await vi.waitFor(() => expect(f.artifacts.file).toHaveBeenCalledTimes(1)); client.destroy(); await vi.waitFor(() => expect(aborted).toBe(true));
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.tasks.close(); }
  });
  it.each([['outcome-unknown', 409], ['pairing-required', 403]] as const)('maps %s explicitly without inviting generic service-unavailable retries', async (code, status) => {
    const f = fixture(true, code); const response = await request(f.app).post('/api/control/agents/cylena/send').auth('fixture-key', { type: 'bearer' }).send({ newConversation: true, message: 'ordinary text', idempotencyKey: 'send-fixture' });
    expect(response.status).toBe(status); expect(response.body.code).toBe(code); f.tasks.close();
  });
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
      for (const path of ['results', 'results/file']) expect((await request(app).post(`/api/control/agents/main/${path}`).set('Origin', 'https://other.test').send({})).status).toBe(403);
      expect((await request(app).get('/api/control/status')).body.state).toBe('disabled');
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      expect(start).toHaveBeenCalled();
      await new Promise<void>(resolve => server.close(() => resolve()));
      expect(close).toHaveBeenCalled();
    } finally { await io.close(); vi.doUnmock('./gatewayClient'); vi.unstubAllEnvs(); vi.resetModules(); }
  });
});
