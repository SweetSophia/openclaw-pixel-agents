// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlRouter } from './routes';
import { createAttachmentAdmission } from './attachmentAdmission';
import { createAttachmentService } from './attachmentService';
import { createTaskService } from './taskService';
import { attachmentGatewayFixture, attachmentInput, attachmentMessage, attachmentTarget } from './fixtures/attachments';
import { isAttachmentPreparationRequest } from './attachmentIngress';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(close => close()));
function fixture() {
  const f = attachmentGatewayFixture(), admission = createAttachmentAdmission();
  const tasks = createTaskService(f.gateway, () => f.state.registered);
  const service = createAttachmentService({ gateway: f.gateway, tasks, admission, enabled: () => f.state.enabled, registeredAgentIds: () => f.state.registered });
  const config = { enabled: true, deviceDirectory: '/synthetic-not-used', controlToken: 'fixture-key', sendEnabled: true, approvalsEnabled: false, allowTailnetHttp: false };
  const app = express(), ordinaryJson = express.json({ limit: '100kb' });
  app.use((req, res, next) => isAttachmentPreparationRequest(req) ? next() : ordinaryJson(req, res, next));
  app.use('/api/control', createControlRouter({ gateway: f.gateway, tasks, config, attachments: service }));
  cleanups.push(() => { service.close(); tasks.close(); });
  const post = (route: string, body: object) => request(app).post(`/api/control/agents/main/attachments/${route}`).auth('fixture-key', { type: 'bearer' }).send(body);
  const prepare = () => post('prepare', { target: attachmentTarget, message: attachmentMessage, image: attachmentInput });
  return { ...f, service, app, post, prepare };
}

describe('closed private attachment routes', () => {
  it('mounts authenticated status and preparation without native send', async () => {
    const f = fixture();
    await request(f.app).get('/api/control/agents/main/attachments/status').expect(401);
    const status = await request(f.app).get('/api/control/agents/main/attachments/status').auth('fixture-key', { type: 'bearer' }).expect(200);
    expect(status.body).toMatchObject({ canPrepare: true, maxBytes: 4_194_304 });
    const review = await f.prepare().expect(200); expect(review.headers['cache-control']).toBe('no-store');
    expect(review.body.image).toMatchObject({ bytes: 68, filename: 'picture.png' });
    expect(JSON.stringify(review.body)).not.toContain(attachmentInput.contentBase64);
    expect(f.nativeSends).toHaveLength(0);
  });

  it('rejects authority substitutions, query selectors, missing acknowledgment and foreign ownership before dispatch', async () => {
    const f = fixture(); const review = (await f.prepare().expect(200)).body;
    const confirm = { operationId: review.operationId, reviewToken: review.reviewToken, sharingAcknowledged: true };
    for (const input of [{ ...confirm, message: 'replacement' }, { ...confirm, image: attachmentInput }, { ...confirm, sharingAcknowledged: false },
      { ...confirm, target: attachmentTarget }, { ...confirm, idempotencyKey: 'browser-id' }]) await f.post('confirm', input).expect(400);
    for (const route of ['confirm', 'receipt', 'discard']) await f.post(route + '?token=selector', { operationId: review.operationId }).expect(400);
    await request(f.app).get('/api/control/agents/main/attachments/status?operationId=selector').auth('fixture-key', { type: 'bearer' }).expect(400);
    await request(f.app).post('/api/control/agents/foreign/attachments/confirm').auth('fixture-key', { type: 'bearer' }).send(confirm).expect(409);
    expect(f.nativeSends).toHaveLength(0);
  });

  it('makes unconfirmed discard idempotent and keeps receipts metadata-only', async () => {
    const f = fixture(); const review = (await f.prepare().expect(200)).body; const operation = { operationId: review.operationId };
    await f.post('discard', operation).expect(200); await f.post('discard', operation).expect(200);
    const receipt = await f.post('receipt', operation).expect(200);
    expect(receipt.body).toMatchObject({ phase: 'not-dispatched', nativeInvoked: false });
    expect(receipt.body.message).toBeUndefined(); expect(receipt.body.reviewToken).toBeUndefined();
    expect(JSON.stringify(receipt.body)).not.toContain(attachmentInput.contentBase64);
    const a = f.service.acquirePreparation('main'), b = f.service.acquirePreparation('main'); a.release(); b.release();
  });

  it('coalesces confirmations and discard cannot cancel a native admitted operation', async () => {
    const f = fixture(); const review = (await f.prepare().expect(200)).body;
    let settle!: () => void; const pending = new Promise<void>(resolve => { settle = resolve; });
    f.state.nativeResult = async id => { await pending; return { runId: id }; };
    const confirm = { operationId: review.operationId, reviewToken: review.reviewToken, sharingAcknowledged: true };
    const first = f.post('confirm', confirm).then(result => result);
    await vi.waitFor(() => expect(f.nativeSends).toHaveLength(1));
    const second = f.post('confirm', confirm).then(result => result);
    await f.post('discard', { operationId: review.operationId }).expect(200);
    const lease = f.service.acquirePreparation('main'); expect(() => f.service.acquirePreparation('main')).toThrow('rate-limited');
    settle(); expect((await first).body).toMatchObject({ phase: 'accepted', nativeInvoked: true });
    expect((await second).body).toMatchObject({ phase: 'accepted', nativeInvoked: true });
    expect(f.nativeSends).toHaveLength(1); lease.release();
  });

  it('returns generic no-store failures without reflecting private malformed input', async () => {
    const f = fixture(); const result = await f.post('prepare', { private: 'secret-image-name-and-prompt' }).expect(400);
    expect(result.headers['cache-control']).toBe('no-store'); expect(JSON.stringify(result.body)).not.toContain('secret-image');
    for (const route of ['receipt', 'discard']) await f.post(route, { operationId: 'missing', extra: true }).expect(400);
  });

  it.each([[true, true, 200], [false, true, 503], [true, false, 503]] as const)(
    'uses actual runtime mounting and disposes without startServer (attachments=%s, send=%s)', async (attachments, send, expected) => {
      const directory = mkdtempSync(join(tmpdir(), 'pixel-attachment-runtime-'));
      mkdirSync(join(directory, 'agents'));
      const f = attachmentGatewayFixture();
      const events = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'] as const;
      const listeners = new Map(events.map(event => [event, [...process.listeners(event)]]));
      const intervals = vi.spyOn(globalThis, 'setInterval');
      vi.resetModules();
      for (const [key, value] of Object.entries({ DATA_DIR: directory, OPENCLAW_AGENTS_DIR: join(directory, 'agents'),
        DATA_SOURCE: 'ingest', INGEST_API_TOKEN: 'synthetic-ingest', AGENT_ROSTER_PATH: '', OPENCLAW_BIN: '/synthetic-do-not-execute',
        NODE_ENV: 'production', CORS_ORIGIN: 'https://pixel.test', LOG_LEVEL: 'silent', PORT: '0', TRUST_PROXY: '',
        FRONTEND_DIR: join(directory, 'frontend'), OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:9', PIXEL_CONTROL_TOKEN: 'fixture-key',
        OPENCLAW_GATEWAY_TOKEN: '', OPENCLAW_GATEWAY_PASSWORD: '', CONTROL_SEND_ENABLED: String(send),
        CONTROL_ATTACHMENTS_ENABLED: String(attachments), CONTROL_APPROVALS_ENABLED: 'false', CONTROL_ALLOW_TAILNET_HTTP: 'false',
        CONTROL_SCHEDULES_MANAGE_ENABLED: 'false', CONTROL_DOCUMENTS_EDIT_ENABLED: 'false' })) vi.stubEnv(key, value);
      let runtimeService: ReturnType<typeof createAttachmentService> | undefined;
      vi.doMock('./gatewayClient', async importOriginal => ({ ...await importOriginal<typeof import('./gatewayClient')>(), createControlGateway: () => f.gateway }));
      vi.doMock('./attachmentService', async importOriginal => {
        const original = await importOriginal<typeof import('./attachmentService')>();
        return { ...original, createAttachmentService: (options: Parameters<typeof createAttachmentService>[0]) => {
          runtimeService = original.createAttachmentService(options); return runtimeService;
        } };
      });
      let runtime: typeof import('../index') | undefined;
      try {
        runtime = await import('../index');
        await new Promise<void>(resolve => runtime!.server.listen(0, '127.0.0.1', resolve));
        const address = runtime.server.address(); if (!address || typeof address === 'string') throw Error('No runtime fixture address');
        let parserCalls = 0;
        runtime.server.prependListener('request', req => req.on('newListener', event => { if (event === 'data') parserCalls++; }));
        const streamed = (authorization: string) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
          const client = httpRequest({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/api/control/agents/main/attachments/prepare',
            headers: { Origin: 'https://pixel.test', Authorization: authorization, 'Content-Type': 'application/json' } }, response => {
            const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
          });
          client.on('error', reject);
          const data = JSON.stringify({ target: attachmentTarget, message: attachmentMessage, image: attachmentInput });
          client.write(data.slice(0, 20)); client.end(data.slice(20) + ' '.repeat(120 * 1024));
        });
        expect((await streamed('Bearer wrong')).status).toBe(401); expect(parserCalls).toBe(0);
        const result = await streamed('Bearer fixture-key'); expect(result.status).toBe(expected);
        expect(parserCalls).toBe(expected === 200 ? 1 : 0); expect(f.nativeSends).toHaveLength(0);
        await new Promise<void>(resolve => runtime!.server.close(() => resolve()));
        expect(() => runtimeService!.acquirePreparation('main')).toThrow('unavailable');
      } finally {
        runtime?.server.closeAllConnections(); await runtime?.io.close();
        for (const timer of intervals.mock.results) if (timer.type === 'return') clearInterval(timer.value);
        intervals.mockRestore();
        for (const event of events) for (const listener of process.listeners(event)) if (!listeners.get(event)?.includes(listener)) process.removeListener(event, listener);
        vi.doUnmock('./gatewayClient'); vi.doUnmock('./attachmentService'); vi.unstubAllEnvs(); vi.resetModules();
        rmSync(directory, { recursive: true, force: true });
      }
    });
});
