// @vitest-environment node
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { io as connectSocket, type Socket } from 'socket.io-client';

type Frame = { id: string; method: string; params: Record<string, any> };

// A protocol-boundary fixture, not a scheduler: only the office's actual signed
// connections and native requests can populate this declaration.
async function signedHost() {
  const frames: Frame[] = []; const signatures: boolean[] = []; const sockets = new Set<Duplex>();
  let nativeJob: Record<string, any> | undefined;
  const encode = (value: unknown) => {
    const data = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(data.length < 126 ? 2 : 4); header[0] = 0x81;
    if (header.length === 2) header[1] = data.length; else { header[1] = 126; header.writeUInt16BE(data.length, 2); }
    return Buffer.concat([header, data]);
  };
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(encode({ type: 'event', event: 'connect.challenge', payload: { nonce: 'restart-nonce', ts: 123 } }));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15; let length = buffer[1] & 127; let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const masked = Boolean(buffer[1] & 128); const bytes = masked ? 4 : 0;
        if (buffer.length < offset + bytes + length) return;
        const mask = buffer.subarray(offset, offset + bytes); offset += bytes; const data = Buffer.from(buffer.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const frame = JSON.parse(data.toString()) as Frame; frames.push(frame); let payload: unknown;
        if (frame.method === 'connect') {
          const p = frame.params;
          const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(p.device.publicKey, 'base64url')]), type: 'spki', format: 'der' });
          signatures.push(verify(null, Buffer.from(['v3', p.device.id, 'cli', 'backend', 'operator', p.scopes.join(','), '123', p.auth.token, 'restart-nonce', process.platform, ''].join('|')), key, Buffer.from(p.device.signature, 'base64url')));
          payload = { type: 'hello-ok', protocol: 4, server: { version: 'synthetic-restart', connId: randomUUID() },
            features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'cron.list', 'cron.get', 'cron.add', 'cron.update'], events: [] }, snapshot: {},
            auth: { role: 'operator', scopes: p.scopes, deviceToken: p.scopes.includes('operator.admin') ? 'restart-manager' : 'restart-reader' },
            policy: { maxPayload: 2097152, maxBufferedBytes: 4194304, tickIntervalMs: 15000 } };
        } else if (frame.method === 'cron.add') {
          nativeJob = { ...frame.params, id: 'restart-job', configRevision: 'revision-1', state: {} };
          // Accept the declaration, then lose the reply. A replay here would
          // overwrite the second operator's later edit, just like native upsert.
          socket.destroy(); continue;
        } else if (frame.method === 'cron.get') payload = nativeJob;
        else if (frame.method === 'cron.list') {
          const offset = frame.params.offset;
          payload = { jobs: nativeJob && offset === 0 ? [nativeJob] : [], snapshotRevision: 'restart-snapshot', total: nativeJob ? 1 : 0, offset, limit: 50, hasMore: false, nextOffset: null };
        } else payload = { sessions: [] };
        socket.write(encode({ type: 'res', id: frame.id, ok: true, payload }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing synthetic address');
  return { frames, signatures, url: `ws://127.0.0.1:${address.port}/`,
    job: () => nativeJob!,
    changeJob() { nativeJob = { ...nativeJob, payload: { kind: 'agentTurn', message: 'Changed by another operator' }, configRevision: 'revision-2' }; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it('dropped_create_reply_then_native_edit_and_restart_never_upserts_again', async () => {
  const host = await signedHost(); const directory = fs.mkdtempSync(join(tmpdir(), 'pixel-process-restart-'));
  const children: ChildProcess[] = []; const sockets: Socket[] = []; const logs: string[] = [];
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'exit'); child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 7000);
    try { await ended; } finally { clearTimeout(force); }
    expect(child.exitCode).toBe(0); expect(child.signalCode).toBeNull();
  };
  try {
    async function office() {
      const lease = createServer(); await new Promise<void>(resolve => lease.listen(0, '127.0.0.1', resolve));
      const address = lease.address(); if (!address || typeof address === 'string') throw Error('Missing office port');
      await new Promise<void>(resolve => lease.close(() => resolve()));
      const origin = `http://127.0.0.1:${address.port}`; const index = logs.push('') - 1;
      // No ambient Gateway configuration, HOME identity or live data is inherited.
      const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(),
        env: { PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(address.port), CORS_ORIGIN: origin,
          DATA_DIR: directory, DATA_SOURCE: 'ingest', INGEST_API_TOKEN: 'restart-ingest', OPENCLAW_AGENTS_DIR: join(directory, 'absent-agents'),
          OPENCLAW_GATEWAY_URL: host.url, PIXEL_CONTROL_TOKEN: 'restart-office', OPENCLAW_GATEWAY_TOKEN: 'restart-bootstrap-reader',
          CONTROL_SCHEDULES_MANAGE_ENABLED: 'true', OPENCLAW_SCHEDULES_GATEWAY_TOKEN: 'restart-bootstrap-manager' }, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); child.on('error', error => { logs[index] += error.message; });
      for (const stream of [child.stdout, child.stderr]) stream!.on('data', chunk => { logs[index] += String(chunk); });
      const call = (suffix: string, body?: unknown) => fetch(`${origin}/api/control/agents/main/schedules${suffix}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer restart-office', Origin: origin,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
      await vi.waitFor(async () => {
        expect(child.exitCode, logs[index]).toBeNull();
        const response = await call(''); expect(response.status).toBe(200); expect((await response.json()).management.canManage).toBe(true);
      }, { timeout: 10000, interval: 100 });
      const socket = connectSocket(origin, { transports: ['websocket'], extraHeaders: { Origin: origin }, reconnection: false }); sockets.push(socket);
      await vi.waitFor(() => expect(socket.connected).toBe(true));
      return { child, call };
    }
    const first = await office();
    const intent = { kind: 'create', draft: { name: 'Restart qualification', message: 'Synthetic restart prompt', schedule: { kind: 'every', everyMs: 60000 } } };
    const prepare = await first.call('/prepare', { intent }); expect(prepare.status).toBe(200);
    const confirmation = await prepare.json(); const input = { operationId: confirmation.operationId, intent };
    const submit = await first.call('/submit', input); expect(submit.status).toBe(200); expect((await submit.json()).state).toBe('unknown');
    expect(host.job()).toMatchObject({ enabled: false, sessionTarget: 'isolated', delivery: { mode: 'none' }, failureAlert: false });
    await stop(first.child);
    await vi.waitFor(() => expect(sockets[0].connected).toBe(false));
    const journal = join(directory, 'control-schedules', 'journal.json');
    expect(fs.readFileSync(journal, 'utf8')).not.toContain('Synthetic restart prompt');
    expect(fs.existsSync(join(directory, 'control-schedules', 'journal.lock'))).toBe(false);
    host.changeJob();
    const second = await office(); expect(second.child.pid).not.toBe(first.child.pid);
    const metadata = await (await second.call('/operations')).json(); expect(metadata.operations).toMatchObject([{ operationId: input.operationId, state: 'unknown' }]);
    expect((await (await second.call('/submit', input)).json()).state).toBe('unknown');
    const recovery = await (await second.call(`/operations/${input.operationId}/reconcile`, {})).json();
    expect(recovery).toMatchObject({ state: 'changed', jobId: 'restart-job' }); expect(recovery.state).not.toBe('confirmed');
    expect((await (await second.call('/submit', input)).json()).state).toBe('changed');
    const nativeJob = host.job(); const frames = host.frames;
    expect(frames.filter(frame => frame.method === 'cron.add')).toHaveLength(1);
    expect(nativeJob.payload.message).toBe('Changed by another operator');
    expect(frames.filter(frame => frame.method === 'cron.update')).toHaveLength(0);
    expect(host.signatures.length).toBeGreaterThanOrEqual(4); expect(host.signatures.every(Boolean)).toBe(true);
    await stop(second.child); expect(fs.existsSync(join(directory, 'control-schedules', 'journal.lock'))).toBe(false);
    await vi.waitFor(() => expect(sockets[1].connected).toBe(false));
    expect(logs.join('')).not.toContain('forced shutdown');
    expect(logs.join('')).not.toContain('Synthetic restart prompt');
    console.info(`Synthetic OS restart verified: PIDs ${first.child.pid} -> ${second.child.pid}; signed handshakes ${host.signatures.length}; cron.add=1; changed job preserved; clean SIGTERM exits.`);
  } finally {
    for (const child of children) await stop(child);
    for (const socket of sockets) socket.disconnect();
    await host.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
