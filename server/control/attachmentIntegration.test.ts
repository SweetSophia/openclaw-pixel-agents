// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { attachmentHost, attachmentInput, attachmentMessage, attachmentTarget } from './fixtures/attachments';

const root = resolve(import.meta.dirname, '../..');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function office(gatewayUrl?: string, attachments = true) {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-attachment-process-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const roster = join(directory, 'roster.json');
  await writeFile(roster, JSON.stringify({ version: 1, agents: [{ id: 'main', name: 'Synthetic attachment agent' }] }));
  const lease = createServer(); lease.listen(0, '127.0.0.1'); await once(lease, 'listening');
  const port = (lease.address() as { port: number }).port;
  await new Promise<void>((accept, reject) => lease.close(error => error ? reject(error) : accept()));
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined, logs = '';
  const data = join(directory, 'data');
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'exit'); child.kill('SIGTERM');
    const force = setTimeout(() => child?.kill('SIGKILL'), 6500);
    try { await ended; } finally { clearTimeout(force); }
  }
  cleanups.push(stop);
  async function start() {
    logs = '';
    // No ambient configuration, real roster, host home, dotenv, CLI polling or credentials.
    child = spawn(process.execPath, ['--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'), resolve(root, 'server/index.ts')], {
      cwd: directory, env: { PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(port), CORS_ORIGIN: url,
        DATA_DIR: data, DATA_SOURCE: 'ingest', INGEST_API_TOKEN: 'synthetic-process-ingest', AGENT_ROSTER_PATH: roster,
        FRONTEND_DIR: resolve(root, 'dist/client'), LOG_LEVEL: 'info',
        ...(gatewayUrl ? { OPENCLAW_GATEWAY_URL: gatewayUrl, OPENCLAW_GATEWAY_TOKEN: 'synthetic-attachment-bootstrap',
          PIXEL_CONTROL_TOKEN: 'synthetic-process-key', CONTROL_SEND_ENABLED: 'true' } : {}),
        ...(attachments ? { CONTROL_ATTACHMENTS_ENABLED: 'true' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', error => { logs += error.message; });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw Error(`Synthetic office exited: ${logs}`);
      try { if ((await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* readiness only */ }
      await delay(50);
    }
    throw Error(`Synthetic office did not start: ${logs}`);
  }
  async function call(endpoint: string, body?: unknown, signal = AbortSignal.timeout(10000)) {
    return fetch(`${url}/api/control/agents/main/attachments/${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { Origin: url, Authorization: 'Bearer synthetic-process-key',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
    });
  }
  async function ready() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await call('status'); const status = await response.json();
      if (status.canPrepare) return status;
      await delay(50);
    }
    throw Error(`Synthetic attachment source not ready: ${logs}`);
  }
  await start();
  return { url, data, start, stop, ready, call, logs: () => logs };
}
const prepare = { target: attachmentTarget, message: attachmentMessage, image: attachmentInput };

// Would catch a synthetic peer that disconnects legitimate smaller ordinary-read budgets.
it('signed_host_keeps_bounded_ordinary_history_reads_available', async () => {
  const host = await attachmentHost(); cleanups.push(host.close);
  const runtime = await office(host.url); await runtime.ready();
  const response = await fetch(`${runtime.url}/api/control/agents/main/runs`, { method: 'POST',
    headers: { Origin: runtime.url, Authorization: 'Bearer synthetic-process-key', 'Content-Type': 'application/json' },
    body: JSON.stringify(attachmentTarget), signal: AbortSignal.timeout(5000) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ runs: [], source: { state: 'current' } });
  expect(host.frames.filter(frame => frame.method === 'chat.history').map(frame => frame.params.maxBytes)).toContain(245760);
  expect((await (await runtime.call('status')).json()).canPrepare).toBe(true);
  expect(host.sendCount()).toBe(0);
}, 15000);

// Would catch persistence/reconstruction of a replayable image operation across office restart.
it('restart_rejects_old_confirm_without_second_native_send', async () => {
  const host = await attachmentHost({ reply: 'hold' }); cleanups.push(host.close);
  const runtime = await office(host.url); const original = await runtime.ready();
  const response = await runtime.call('prepare', prepare);
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  const review = await response.json(); expect(review.target).toEqual(attachmentTarget); expect(host.sendCount()).toBe(0);
  const confirm = { operationId: review.operationId, reviewToken: review.reviewToken, sharingAcknowledged: true };
  const observer = new AbortController();
  const lost = runtime.call('confirm', confirm, observer.signal).catch(() => undefined);
  const frame = await host.waitForAdmission();
  expect(frame).toEqual({ type: 'req', id: expect.any(String), method: 'chat.send', params: {
    agentId: 'main', sessionKey: 'agent:main:fixture', sessionId: 's1', expectedLeafEntryId: 'leaf-1',
    message: 'Describe this picture', idempotencyKey: review.operationId, queueMode: 'followup', deliver: false,
    attachments: [{ mimeType: 'image/png', fileName: 'picture.png', origin: 'file', content: attachmentInput.contentBase64 }],
  } });
  observer.abort(); await lost; await runtime.stop();
  await runtime.start(); const restarted = await runtime.ready(); expect(restarted.epoch).not.toBe(original.epoch);
  for (const [endpoint, body] of [['confirm', confirm], ['receipt', { operationId: review.operationId }], ['confirm', confirm]] as const) {
    const replay = await runtime.call(endpoint, body);
    expect(replay.status).toBe(409); expect(await replay.json()).toMatchObject({ code: 'attachment-expired' });
  }
  host.releaseReply(); expect(host.sendCount()).toBe(1);
  const connections = host.frames.filter(frame => frame.method === 'connect');
  expect(connections).toHaveLength(2);
  expect(connections.map(frame => frame.params.scopes)).toEqual([['operator.read', 'operator.write'], ['operator.read', 'operator.write']]);
  expect(connections[1].params.device.id).toBe(connections[0].params.device.id);
  expect(host.frames.filter(frame => frame.method === 'sessions.describe').every(frame =>
    frame.params.key === 'agent:main:fixture' && frame.params.agentId === 'main')).toBe(true);
  expect(host.frames.filter(frame => frame.method === 'chat.history').every(frame =>
    frame.params.sessionKey === 'agent:main:fixture' && frame.params.limit <= 50 && frame.params.maxBytes === 262144)).toBe(true);
  for (const forbidden of [attachmentInput.contentBase64, attachmentMessage, attachmentInput.filename, review.reviewToken]) expect(runtime.logs()).not.toContain(forbidden);
  await runtime.stop();
  expect(await readdir(runtime.data)).not.toContain('control-attachments');
}, 25000);

// Would catch a prepare path that dispatches or restores send authority after a lost review response.
it('restart_of_unconfirmed_review_never_sends', async () => {
  const host = await attachmentHost(); cleanups.push(host.close);
  const runtime = await office(host.url); await runtime.ready();
  const lost = await runtime.call('prepare', prepare); expect(lost.status).toBe(200);
  await lost.body?.cancel(); // The browser receives no review body/token.
  expect(host.sendCount()).toBe(0); await runtime.stop(); await runtime.start(); await runtime.ready();
  const stale = await runtime.call('confirm', { operationId: randomUUID(), reviewToken: 'lost-review-token', sharingAcknowledged: true });
  expect(stale.status).toBe(409);
  const fresh = await (await runtime.call('prepare', prepare)).json();
  expect((await runtime.call('discard', { operationId: fresh.operationId })).status).toBe(200);
  expect(host.sendCount()).toBe(0); await runtime.stop();
  const files = await readdir(runtime.data, { recursive: true });
  for (const file of files) if (file.endsWith('.json')) {
    const contents = await readFile(join(runtime.data, file), 'utf8');
    for (const marker of [attachmentMessage, attachmentInput.contentBase64, attachmentInput.filename]) expect(contents).not.toContain(marker);
  }
}, 25000);
