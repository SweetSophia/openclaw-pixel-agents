// @vitest-environment node
import express from 'express';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlRouter } from './routes';
import { createAttachmentAdmission } from './attachmentAdmission';
import { createAttachmentService } from './attachmentService';
import { createTaskService } from './taskService';
import { attachmentGatewayFixture, attachmentInput, attachmentMessage, attachmentTarget } from './fixtures/attachments';
import { attachmentFailure, isAttachmentPreparationRequest } from './attachmentIngress';

const preparePath = '/api/control/agents/main/attachments/prepare';
const body = JSON.stringify({ target: attachmentTarget, message: attachmentMessage, image: attachmentInput });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0)) await close(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture() {
  const f = attachmentGatewayFixture(); let elapsed = 0;
  const admission = createAttachmentAdmission({ now: () => elapsed });
  const tasks = createTaskService(f.gateway, () => f.state.registered);
  const service = createAttachmentService({ gateway: f.gateway, tasks, admission, enabled: () => f.state.enabled, registeredAgentIds: () => f.state.registered });
  const config = { enabled: true, deviceDirectory: '/synthetic-not-used', controlToken: 'fixture-key', sendEnabled: true, approvalsEnabled: false, allowTailnetHttp: false };
  const stats = { parserSubscriptions: 0, onParser: () => {} };
  const app = express();
  app.use((req, res, next) => {
    req.on('newListener', event => { if (event === 'data') { stats.parserSubscriptions++; stats.onParser(); } });
    if (req.method !== 'GET' && req.headers.origin !== 'https://pixel.test') { res.status(403).json({ error: 'Forbidden origin' }); return; }
    next();
  });
  const ordinaryJson = express.json({ limit: '100kb' });
  app.use((req, res, next) => isAttachmentPreparationRequest(req) ? next() : ordinaryJson(req, res, next));
  app.use('/api/control', createControlRouter({ gateway: f.gateway, tasks, config, attachments: service }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: 'Bounded request rejected' });
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No fixture address');
  const port = address.port;
  cleanups.push(async () => { service.close(); tasks.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  function stream(path = preparePath, headers: Record<string, string> = {}, method = 'POST') {
    const client = httpRequest({ host: '127.0.0.1', port, method, path,
      headers: { Origin: 'https://pixel.test', Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json',
        ...('Content-Length' in headers ? {} : { 'Transfer-Encoding': 'chunked' }), ...headers } });
    const response = new Promise<{ status: number; body: Record<string, unknown>; headers: IncomingHttpHeaders }>((resolve, reject) => {
      client.on('error', reject);
      client.on('response', res => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : {}, headers: res.headers });
      }); });
    });
    void response.catch(() => {});
    return { client, response };
  }
  async function send(value = body, path = preparePath, headers: Record<string, string> = {}, method = 'POST') {
    const s = stream(path, headers, method); s.client.end(value); return s.response;
  }
  return { ...f, admission, service, config, stats, stream, send, advance: (ms: number) => { elapsed += ms; } };
}

describe('authenticated streamed attachment ingress', () => {
  it('destroys a response with flushed headers instead of attempting a second JSON write', () => {
    const destroy = vi.fn(); const status = vi.fn().mockReturnThis();
    const json = vi.fn(() => { throw Error('Headers already sent'); });
    const response = { destroyed: false, writableEnded: false, headersSent: true, destroy, status, json } as unknown as express.Response;
    expect(() => attachmentFailure(response, Error('late route failure'))).not.toThrow();
    expect(destroy).toHaveBeenCalledOnce(); expect(status).not.toHaveBeenCalled(); expect(json).not.toHaveBeenCalled();
  });
  it('auth_precedes_large_body_read', async () => {
    const f = await fixture(); const large = '{"private":"' + 'x'.repeat(120 * 1024);
    for (const [headers, status] of [
      [{ Authorization: 'Bearer wrong' }, 401],
      [{ 'X-Forwarded-For': '198.51.100.9' }, 403],
      [{ Origin: 'https://wrong.test' }, 403],
    ] as const) {
      const s = f.stream(preparePath, headers); s.client.write(large);
      expect((await s.response).status).toBe(status); s.client.destroy();
    }
    f.config.enabled = false;
    expect((await f.send(large)).status).toBe(503); f.config.enabled = true;
    f.state.enabled = false;
    expect((await f.send(large)).status).toBe(503); f.state.enabled = true;
    f.state.caps = null;
    expect((await f.send(large)).status).toBe(501);
    expect(f.stats.parserSubscriptions).toBe(0);
    expect(f.requests.filter(row => row.method !== 'sessions.subscribe')).toHaveLength(0);
    expect(f.nativeSends).toHaveLength(0);
  });

  it('only_prepare_gets_large_parser, including canonical trailing slash', async () => {
    const f = await fixture(); const padded = body + ' '.repeat(120 * 1024);
    for (const path of [preparePath, preparePath + '/']) {
      const result = await f.send(padded, path); expect(result.status).toBe(200);
      f.service.discard('main', { operationId: String(result.body.operationId) });
    }
    for (const [path, method] of [
      [preparePath.replace('/main/', '/%6dain/'), 'POST'],
      [preparePath.replace('/attachments/', '/Attachments/'), 'POST'],
      [preparePath.replace('/api/', '/API/'), 'POST'],
      [preparePath + '/extra', 'POST'], [preparePath + '?token=not-allowed', 'POST'],
      [preparePath.replace('/main/', '/' + 'a'.repeat(65) + '/'), 'POST'],
      [preparePath.replace('/main/', '/_main/'), 'POST'],
      [preparePath.replace('/main/', '/constructor/'), 'POST'],
      [preparePath.replace('/main/', '/__proto__/'), 'POST'],
      [preparePath.replace('/prepare', '/confirm'), 'POST'],
      [preparePath.replace('/prepare', '/receipt'), 'POST'],
      [preparePath.replace('/prepare', '/discard'), 'POST'],
      [preparePath, 'PUT'], [preparePath, 'GET'],
    ]) expect((await f.send(padded, path, {}, method)).status).toBe(413);
    expect((await f.send(body, preparePath.replace('/main/', '/%6dain/'))).status).toBe(400);
    expect(f.nativeSends).toHaveLength(0);
  });

  it('slow_chunked_compressed_body_is_bounded without relying on Content-Length', async () => {
    const f = await fixture();
    const chunked = f.stream(); chunked.client.write(body.slice(0, 20)); chunked.client.end(body.slice(20));
    const prepared = await chunked.response; expect(prepared.status).toBe(200);
    f.service.discard('main', { operationId: String(prepared.body.operationId) });
    const compressed = f.stream(preparePath, { 'Content-Encoding': 'gzip' }); compressed.client.write(gzipSync(body));
    expect((await compressed.response).status).toBe(415); compressed.client.destroy();
    expect((await f.send(body, preparePath, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await f.send(body, preparePath, { 'Content-Type': 'application/json; charset=utf-16' })).status).toBe(415);
    const declared = f.stream(preparePath, { 'Content-Length': '6291457' }); declared.client.flushHeaders();
    expect((await declared.response).status).toBe(413); declared.client.destroy();
    const falseLength = await f.send(body, preparePath, { 'Content-Length': '10' }); expect(falseLength.status).toBe(400);
    const over = f.stream();
    for (let i = 0; i < 97; i++) over.client.write(Buffer.alloc(65_536, 32));
    expect((await over.response).status).toBe(413); over.client.destroy();
    const a = f.service.acquirePreparation('main'), b = f.service.acquirePreparation('main'); a.release(); b.release();
    expect(f.nativeSends).toHaveLength(0);
  });

  it('returns receiving slots on a real streamed abort and rejects a third occupied slot before parsing', async () => {
    const f = await fixture(), receiving = deferred();
    f.stats.onParser = () => { if (f.stats.parserSubscriptions === 2) receiving.resolve(); };
    const a = f.stream(), b = f.stream(); a.client.write('{'); b.client.write('{'); await receiving.promise;
    expect((await f.send()).status).toBe(429); expect(f.stats.parserSubscriptions).toBe(2);
    const closed = new Promise<void>(resolve => a.client.once('close', resolve)); a.client.destroy(); await closed;
    const secondClosed = new Promise<void>(resolve => b.client.once('close', resolve)); b.client.destroy(); await secondClosed;
    // Poll a real request boundary: client close can precede the server's abort callback.
    await vi.waitFor(async () => { const result = await f.send(); expect(result.status).toBe(200); f.service.discard('main', { operationId: String(result.body.operationId) }); });
    const first = f.service.acquirePreparation('main'), second = f.service.acquirePreparation('main'); first.release(); second.release();
  });

  it('enforces ten preparations per minute per IP without duplicating or resetting the private access budget', async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) {
      const result = await f.send(); expect(result.status).toBe(200); f.service.discard('main', { operationId: String(result.body.operationId) });
    }
    expect((await f.send()).status).toBe(429); expect(f.stats.parserSubscriptions).toBe(10);
    // The eleven requests above already consumed the single shared 120-read budget.
    for (let i = 0; i < 109; i++) expect((await f.send('', '/api/control/status', {}, 'GET')).status).toBe(200);
    expect((await f.send('', '/api/control/status', {}, 'GET')).status).toBe(429);
    expect(f.nativeSends).toHaveLength(0);
  });

  it('expires a stalled body at 30 seconds and frees both receiving slots', async () => {
    const f = await fixture(), reading = deferred(); f.stats.onParser = reading.resolve;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = f.stream(); s.client.write('{'); await reading.promise;
    f.advance(29_999); await vi.advanceTimersByTimeAsync(29_999);
    const other = f.service.acquirePreparation('main'); expect(() => f.service.acquirePreparation('main')).toThrow('rate-limited');
    f.advance(1); await vi.advanceTimersByTimeAsync(1);
    expect((await s.response).status).toBe(408); s.client.destroy(); other.release();
    const a = f.service.acquirePreparation('main'), b = f.service.acquirePreparation('main'); a.release(); b.release();
    expect(f.nativeSends).toHaveLength(0);
  });

  it.each(['complete', 'disconnect'] as const)('keeps preparing custody beyond the receiving deadline after %s', async kind => {
    const f = await fixture(), reading = deferred(), entered = deferred(), gate = deferred(), cancelled = deferred();
    f.stats.onParser = reading.resolve;
    let signal: AbortSignal | undefined; const request = f.gateway.request;
    vi.spyOn(f.gateway, 'request').mockImplementation((method, params, incoming) => {
      if (method === 'sessions.describe') { signal = incoming; incoming?.addEventListener('abort', cancelled.resolve, { once: true }); }
      return request(method, params, incoming);
    });
    f.state.afterRequest = async method => { if (method === 'sessions.describe') { entered.resolve(); await gate.promise; } };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = f.stream(); s.client.write(body.slice(0, 20)); await reading.promise;
    f.advance(29_999); await vi.advanceTimersByTimeAsync(29_999); s.client.end(body.slice(20)); await entered.promise;
    const other = f.service.acquirePreparation('main');
    f.advance(2); await vi.advanceTimersByTimeAsync(2);
    expect(() => f.service.acquirePreparation('main')).toThrow('rate-limited');
    expect((await f.send('{}')).status).toBe(429); expect(f.stats.parserSubscriptions).toBe(1);
    if (kind === 'disconnect') { s.client.destroy(); await cancelled.promise; expect(signal?.aborted).toBe(true); }
    expect(() => f.service.acquirePreparation('main')).toThrow('rate-limited');
    expect((await f.send('{}')).status).toBe(429); expect(f.stats.parserSubscriptions).toBe(1);
    gate.resolve();
    if (kind === 'complete') {
      const result = await s.response; expect(result.status).toBe(200);
      expect(() => f.service.acquirePreparation('main')).toThrow('rate-limited');
      expect((await f.send('{}')).status).toBe(429);
      f.service.discard('main', { operationId: String(result.body.operationId) });
    } else {
      vi.useRealTimers(); await vi.waitFor(() => { const lease = f.service.acquirePreparation('main'); lease.release(); });
    }
    other.release(); const a = f.service.acquirePreparation('main'), b = f.service.acquirePreparation('main'); a.release(); b.release();
    expect(f.nativeSends).toHaveLength(0);
  });

  it('HTTP disconnect and discard cannot release or replay a native admitted confirmation', async () => {
    const f = await fixture(), entered = deferred(), gate = deferred();
    const review = (await f.send()).body;
    f.state.nativeResult = async id => { entered.resolve(); await gate.promise; return { runId: id }; };
    const confirmation = JSON.stringify({ operationId: review.operationId, reviewToken: review.reviewToken, sharingAcknowledged: true });
    const s = f.stream(preparePath.replace('/prepare', '/confirm')); s.client.end(confirmation); await entered.promise; s.client.destroy();
    const operation = JSON.stringify({ operationId: review.operationId });
    expect((await f.send(operation, preparePath.replace('/prepare', '/receipt'))).body).toMatchObject({ phase: 'sending', nativeInvoked: true });
    expect((await f.send(operation, preparePath.replace('/prepare', '/discard'))).status).toBe(200);
    const other = f.service.acquirePreparation('main'); expect(() => f.service.acquirePreparation('main')).toThrow('rate-limited');
    expect((await f.send('{}')).status).toBe(429);
    expect(f.nativeSends).toHaveLength(1); gate.resolve();
    await vi.waitFor(async () => expect((await f.send(operation, preparePath.replace('/prepare', '/receipt'))).body.phase).toBe('accepted'));
    expect((await f.send(confirmation, preparePath.replace('/prepare', '/confirm'))).body).toMatchObject({ phase: 'accepted', nativeInvoked: true });
    expect(f.nativeSends).toHaveLength(1); other.release();
  });
});
