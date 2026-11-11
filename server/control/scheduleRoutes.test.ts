// @vitest-environment node
import express from 'express';
import fs from 'node:fs';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadControlConfig } from './config';
import { createControlRouter } from './routes';
import { createTaskService } from './taskService';
import { createScheduleService, type ScheduleService } from './scheduleService';
import { createControlGateway, createScheduleGateway, type ControlGateway, type ScheduleGateway } from './gatewayClient';
import { loadScheduleConfig } from './scheduleConfig';

const directories: string[] = []; const services: ScheduleService[] = []; const cleanups: Array<() => void | Promise<void>> = [];
function fixture(enabled = true, manage = false) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pixel-schedule-http-')); directories.push(directory);
  const config = loadControlConfig(enabled ? { OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:9', PIXEL_CONTROL_TOKEN: 'synthetic-schedule-key' } : {}, directory);
  const reader: ControlGateway = { start: vi.fn(), close: vi.fn(), status: () => ({ configured: enabled, state: enabled ? 'ready' : 'disabled', canRead: enabled, canSend: false }),
    onEvent: () => () => {}, request: vi.fn(async () => ({ jobs: [], snapshotRevision: 'synthetic-revision', total: 0, offset: 0, limit: 50, hasMore: false, nextOffset: null })) };
  const manager: ScheduleGateway = { start: vi.fn(), close: vi.fn(), status: () => ({ configured: manage, state: manage ? 'pairing-required' : 'disabled', canManage: false, epoch: null, reason: manage ? 'pairing-required' : 'disabled' }), connection: () => null, request: vi.fn() };
  const schedules = createScheduleService({ reader, manager, config: { enabled: manage, url: config.url, deviceDirectory: join(directory, 'control-schedules') }, registeredAgents: () => new Set(['main', 'Upper']) }); services.push(schedules);
  const tasks = createTaskService(reader, () => new Set(['main', 'Upper'])); cleanups.push(() => tasks.close());
  vi.mocked(reader.request).mockClear();
  const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway: reader, tasks, config, schedules }));
  return { app, reader, manager, schedules, directory };
}
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

type SyntheticFrame = { id: string; method: string; params: Record<string, any> };
async function signedScheduleHost() {
  const frames: SyntheticFrame[] = []; const signatures: boolean[] = []; const sockets = new Set<Duplex>();
  const pendingAdds: Duplex[] = []; let job: Record<string, unknown> | undefined;
  const encode = (value: unknown) => {
    const data = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(data.length < 126 ? 2 : 4); header[0] = 0x81;
    if (header.length === 2) header[1] = data.length; else { header[1] = 126; header.writeUInt16BE(data.length, 2); }
    return Buffer.concat([header, data]);
  };
  const server = createServer(); server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(encode({ type: 'event', event: 'connect.challenge', payload: { nonce: 'schedule-nonce', ts: 123 } }));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15; let length = buffer[1] & 127; let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const masked = Boolean(buffer[1] & 128); const bytes = masked ? 4 : 0; if (buffer.length < offset + bytes + length) return;
        const mask = buffer.subarray(offset, offset + bytes); offset += bytes; const data = Buffer.from(buffer.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + length); if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; } if (opcode !== 1) continue;
        const frame = JSON.parse(data.toString()) as SyntheticFrame; frames.push(frame);
        let payload: unknown;
        if (frame.method === 'connect') {
          const p = frame.params; const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(p.device.publicKey, 'base64url')]), type: 'spki', format: 'der' });
          signatures.push(verify(null, Buffer.from(['v3', p.device.id, 'cli', 'backend', 'operator', p.scopes.join(','), '123', p.auth.token, 'schedule-nonce', process.platform, ''].join('|')), key, Buffer.from(p.device.signature, 'base64url')));
          payload = { type: 'hello-ok', protocol: 4, server: { version: 'fixture', connId: randomUUID() },
            features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'cron.list', 'cron.get', 'cron.add', 'cron.update'], events: [] }, snapshot: {},
            auth: { role: 'operator', scopes: p.scopes, deviceToken: p.scopes.includes('operator.admin') ? 'synthetic-manager-grant' : 'synthetic-reader-grant' },
            policy: { maxPayload: 2097152, maxBufferedBytes: 4194304, tickIntervalMs: 15000 } };
        } else if (frame.method === 'cron.add') {
          job = { ...frame.params, id: 'synthetic-job', configRevision: 'revision-1', state: {} }; pendingAdds.push(socket); continue;
        } else if (frame.method === 'cron.get') payload = job;
        else if (frame.method === 'cron.list') {
          const offset = frame.params.offset; const rows = job && offset === 0 ? [job] : [];
          payload = { jobs: rows, snapshotRevision: 'synthetic-snapshot', total: job ? 1 : 0, offset, limit: 50, hasMore: false, nextOffset: null };
        } else payload = { sessions: [] };
        socket.write(encode({ type: 'res', id: frame.id, ok: true, payload }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing synthetic address');
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `ws://127.0.0.1:${address.port}/`, frames, signatures, pendingAdds, sockets, currentJob: () => job,
    changeJob() { job = { ...job, name: 'Edited natively after lost reply', enabled: true, configRevision: 'revision-2' }; } };
}

describe('private agent schedule routes', () => {
  const path = '/api/control/agents/main/schedules';
  it('signed_gateway_real_journal_http_disconnect_and_restart_never_replay_native_add', async () => {
    const host = await signedScheduleHost(); const directory = fs.mkdtempSync(join(tmpdir(), 'pixel-schedule-stack-')); directories.push(directory);
    async function runtime() {
      // Deliberately constructed environment: never inherit host Gateway configuration, grants or office data.
      const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: host.url, PIXEL_CONTROL_TOKEN: 'synthetic-stack-office-key', OPENCLAW_GATEWAY_TOKEN: 'synthetic-reader-bootstrap',
        CONTROL_SEND_ENABLED: 'false', CONTROL_APPROVALS_ENABLED: 'false', CONTROL_ALLOW_TAILNET_HTTP: 'false' }, directory);
      const scheduleConfig = loadScheduleConfig({ CONTROL_SCHEDULES_MANAGE_ENABLED: 'true', OPENCLAW_SCHEDULES_GATEWAY_TOKEN: 'synthetic-manager-bootstrap' }, directory, config);
      const reader = createControlGateway(config); const manager = createScheduleGateway(scheduleConfig);
      const schedules = createScheduleService({ reader, manager, config: scheduleConfig, registeredAgents: () => new Set(['main']) }); services.push(schedules);
      const tasks = createTaskService(reader, () => new Set(['main']));
      const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway: reader, config, tasks, schedules }));
      const http = createServer(app); http.once('close', () => { void schedules.close(); reader.close(); tasks.close(); });
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve)); const address = http.address();
      if (!address || typeof address === 'string') throw Error('Missing synthetic office address');
      const base = `http://127.0.0.1:${address.port}`; let stopped = false;
      async function stop() { if (stopped) return; stopped = true; await new Promise<void>(resolve => http.close(() => resolve())); await schedules.close(); }
      cleanups.push(stop); reader.start(); await vi.waitFor(() => expect(reader.status().canRead).toBe(true));
      const call = (endpoint: string, body?: unknown, signal?: AbortSignal) => fetch(base + path + endpoint, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer synthetic-stack-office-key', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
      return { schedules, reader, manager, stop, call };
    }
    const first = await runtime(); expect((await first.call('/operations')).status).toBe(200); expect(first.manager.connection()).toBeNull();
    await first.call(''); await vi.waitFor(() => expect(first.manager.status().canManage).toBe(true));
    const intent = { kind: 'create', draft: { name: 'Synthetic', message: 'Synthetic integration sentinel', schedule: { kind: 'every', everyMs: 60000 } } };
    const confirmation = await (await first.call('/prepare', { intent })).json(); const input = { operationId: confirmation.operationId, intent };
    const controller = new AbortController(); const lost = first.call('/submit', input, controller.signal).catch(() => undefined);
    await vi.waitFor(() => expect(host.pendingAdds).toHaveLength(1));
    const duplicate = first.call('/submit', input); controller.abort(); await lost;
    const metadata = await (await first.call('/operations')).json(); expect(metadata.operations).toMatchObject([{ operationId: input.operationId, state: 'unknown' }]);
    const disconnectedEpoch = first.manager.status().epoch;
    for (const socket of host.pendingAdds) socket.destroy();
    expect((await (await duplicate).json()).state).toBe('unknown');
    // CI can finish the legitimate backoff reconnect before HTTP keep-alive shutdown completes.
    // Exercise that path deterministically instead of assuming shutdown wins the timer race.
    await vi.waitFor(() => {
      expect(first.manager.status().canManage).toBe(true);
      expect(first.manager.status().epoch).not.toBe(disconnectedEpoch);
    });
    const journalPath = join(directory, 'control-schedules', 'journal.json');
    expect(fs.readFileSync(journalPath, 'utf8')).not.toContain('Synthetic integration sentinel');
    await first.stop(); expect(fs.existsSync(join(directory, 'control-schedules', 'journal.lock'))).toBe(false);
    await vi.waitFor(() => expect(host.sockets.size).toBe(0));
    host.changeJob(); const second = await runtime(); await second.call(''); await vi.waitFor(() => expect(second.manager.status().canManage).toBe(true));
    expect((await (await second.call('/submit', input)).json()).state).toBe('unknown');
    const reconciled = await (await second.call(`/operations/${input.operationId}/reconcile`, {})).json();
    expect(reconciled).toMatchObject({ state: 'changed', jobId: 'synthetic-job' });
    expect((await (await second.call('/submit', input)).json()).state).toBe('changed');
    expect(host.frames.filter(frame => frame.method === 'cron.add')).toHaveLength(1);
    expect(host.frames.some(frame => frame.method === 'cron.update')).toBe(false);
    expect(host.currentJob()).toMatchObject({ name: 'Edited natively after lost reply', enabled: true, configRevision: 'revision-2' });
    const connections = host.frames.filter(frame => frame.method === 'connect');
    expect(host.signatures).toHaveLength(5); expect(host.signatures.every(Boolean)).toBe(true);
    expect(connections.map(frame => frame.params.scopes)).toEqual([
      ['operator.read'], ['operator.read', 'operator.admin'], ['operator.read', 'operator.admin'],
      ['operator.read'], ['operator.read', 'operator.admin'],
    ]);
    const readerDevice = connections[0].params.device.id; const managerDevice = connections[1].params.device.id;
    expect(readerDevice).not.toBe(managerDevice);
    expect(connections.map(frame => frame.params.device.id)).toEqual([readerDevice, managerDevice, managerDevice, readerDevice, managerDevice]);
    await second.stop(); expect(fs.existsSync(join(directory, 'control-schedules', 'journal.lock'))).toBe(false);
    await vi.waitFor(() => expect(host.sockets.size).toBe(0));
    expect(first.reader.status().canRead).toBe(false); expect(first.manager.connection()).toBeNull();
    expect(second.reader.status().canRead).toBe(false); expect(second.manager.connection()).toBeNull();
  }, 15000);
  it('validates_private_confirmation_submit_and_explicit_reconciliation_bodies', async () => {
    const f = fixture(true, true); const draft = { name: 'Synthetic', message: 'Private synthetic prompt', schedule: { kind: 'every', everyMs: 60000 } };
    const intent = { kind: 'create', draft };
    vi.spyOn(f.manager, 'status').mockReturnValue({ configured: true, state: 'ready', canManage: true, epoch: 'e1', reason: null });
    vi.spyOn(f.manager, 'connection').mockReturnValue({ epoch: 'e1', gatewayUrl: 'ws://127.0.0.1:9/', deviceId: 'synthetic-device' });
    vi.mocked(f.manager.request).mockImplementation(async (method, params) => method === 'cron.add'
      ? { created: true, job: { ...params, id: 'job-1', configRevision: 'r1', state: {} } }
      : method === 'cron.get' ? { id: 'job-1' } : { jobs: [], total: 0, offset: 0, limit: 50, hasMore: false, nextOffset: null, snapshotRevision: 's1' });
    expect((await request(f.app).post(`${path}/prepare`).auth('wrong-key', { type: 'bearer' }).send({ intent })).status).toBe(401);
    for (const body of [{ intent, enabled: true }, intent, { intent: { ...intent, agentId: 'other' } }, [], {}]) {
      expect((await request(f.app).post(`${path}/prepare`).auth('synthetic-schedule-key', { type: 'bearer' }).send(body)).status).toBe(400);
    }
    const prepared = await request(f.app).post(`${path}/prepare`).auth('synthetic-schedule-key', { type: 'bearer' }).send({ intent });
    expect(prepared.status).toBe(200); expect(prepared.body).toMatchObject({ agentId: 'main', intent, currentEnabled: null });
    expect(fs.readdirSync(f.directory)).toEqual([]);
    const input = { operationId: prepared.body.operationId, intent };
    expect((await request(f.app).post(`${path}/submit`).auth('synthetic-schedule-key', { type: 'bearer' }).send({ ...input, enabled: true })).status).toBe(400);
    const submitted = await request(f.app).post(`${path}/submit`).auth('synthetic-schedule-key', { type: 'bearer' }).send(input);
    expect(submitted.status).toBe(200); expect(submitted.body).toMatchObject({ state: 'confirmed', jobId: 'job-1' });
    expect(submitted.headers['cache-control']).toBe('no-store');
    const endpoint = `${path}/operations/${input.operationId}/reconcile`;
    for (const body of [{ cursor: '' }, { cursor: 5 }, { offset: 0 }, { cursor: 'x', force: true }, []]) {
      expect((await request(f.app).post(endpoint).auth('synthetic-schedule-key', { type: 'bearer' }).send(body)).status).toBe(400);
    }
    expect((await request(f.app).post(endpoint).auth('synthetic-schedule-key', { type: 'bearer' }).send({ cursor: 'unknown' })).status).toBe(409);
    const reconciled = await request(f.app).post(endpoint).auth('synthetic-schedule-key', { type: 'bearer' }).send({});
    expect(reconciled.status).toBe(200); expect(reconciled.body).toMatchObject({ state: 'unknown', recovery: { scanned: 0, truncated: false } });
    expect(vi.mocked(f.manager.request).mock.calls.filter(call => call[0] === 'cron.add')).toHaveLength(1);
    expect(JSON.stringify(reconciled.body)).not.toMatch(/Private synthetic prompt|declaration|digest|synthetic-device/);
  });
  it('authenticates_before_lazy_management_and_returns_no_store_without_a_session', async () => {
    const f = fixture(true, true);
    for (const endpoint of [path, `${path}/operations`]) {
      const locked = await request(f.app).get(endpoint).auth('wrong-key', { type: 'bearer' });
      expect(locked.status).toBe(401); expect(locked.headers['cache-control']).toBe('no-store');
    }
    expect(f.manager.start).not.toHaveBeenCalled(); expect(f.reader.request).not.toHaveBeenCalled();
    const operations = await request(f.app).get(`${path}/operations`).auth('synthetic-schedule-key', { type: 'bearer' });
    expect(operations.body).toEqual({ agentId: 'main', operations: [] }); expect(operations.headers['cache-control']).toBe('no-store'); expect(f.manager.start).not.toHaveBeenCalled();
    const result = await request(f.app).get(path).auth('synthetic-schedule-key', { type: 'bearer' });
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ agentId: 'main', jobs: [], management: { state: 'pairing-required', canManage: false } });
    expect(result.headers['cache-control']).toBe('no-store'); expect(f.manager.start).toHaveBeenCalledTimes(1);
    expect(f.reader.request).toHaveBeenCalledWith('cron.list', expect.objectContaining({ agentId: 'main' }), expect.any(AbortSignal));
    expect(fs.readdirSync(f.directory)).toEqual([]);
  });
  it('retains_literal_parent_identity_and_rejects_unknown_agents_and_invalid_cursors', async () => {
    const f = fixture();
    expect((await request(f.app).get('/api/control/agents/missing/schedules').auth('synthetic-schedule-key', { type: 'bearer' })).status).toBe(404);
    expect((await request(f.app).get('/api/control/agents/Upper/schedules').auth('synthetic-schedule-key', { type: 'bearer' })).body.code).toBe('schedule-denied');
    for (const query of ['cursor=', 'cursor=a&cursor=b', `cursor=${'x'.repeat(2049)}`, 'offset=1']) {
      expect((await request(f.app).get(`${path}?${query}`).auth('synthetic-schedule-key', { type: 'bearer' })).status).toBe(400);
    }
    const expired = await request(f.app).get(`${path}?cursor=unknown`).auth('synthetic-schedule-key', { type: 'bearer' });
    expect(expired.status).toBe(409); expect(expired.body.code).toBe('schedule-changed');
    expect(f.reader.request).not.toHaveBeenCalled();
  });
  it('rejects_forwarded_transport_unconfigured_control_and_every_mutation', async () => {
    const f = fixture(); f.app.set('trust proxy', 1);
    expect((await request(f.app).get(path).set('X-Forwarded-For', '198.51.100.4').auth('synthetic-schedule-key', { type: 'bearer' })).status).toBe(403);
    const disabled = fixture(false); const result = await request(disabled.app).get(path).auth('synthetic-schedule-key', { type: 'bearer' });
    expect(result.status).toBe(503); expect(result.body.code).toBe('disabled'); expect(disabled.reader.request).not.toHaveBeenCalled();
    for (const endpoint of [path, `${path}/create`, `${path}/rpc`, `${path}/operations`]) expect((await request(f.app).post(endpoint).auth('synthetic-schedule-key', { type: 'bearer' }).send({})).status).toBe(404);
    expect(f.manager.request).not.toHaveBeenCalled();
  });
  it('pages_private_recovery_without_native_or_management_io_and_validates_its_cursor', async () => {
    const f = fixture(true, true); const directory = join(f.directory, 'control-schedules'); fs.mkdirSync(directory, { mode: 0o700 });
    const installationId = randomUUID(); const records = Array.from({ length: 51 }, () => {
      const operationId = randomUUID(); return { operationId, agentId: 'main', declarationKey: `pixel-agents:${installationId}:${operationId}`,
        requestDigest: 'a'.repeat(64), bindingDigest: 'b'.repeat(64), createdAt: 1700000000000, state: 'uncertain' };
    });
    fs.writeFileSync(join(directory, 'journal.json'), JSON.stringify({ version: 1, installationId, records }), { mode: 0o600 });
    const first = await request(f.app).get(`${path}/operations`).auth('synthetic-schedule-key', { type: 'bearer' });
    expect(first.status).toBe(200); expect(first.body.agentId).toBe('main'); expect(first.body.operations).toHaveLength(50); expect(first.body.nextCursor).toEqual(expect.any(String));
    const last = await request(f.app).get(`${path}/operations`).query({ cursor: first.body.nextCursor }).auth('synthetic-schedule-key', { type: 'bearer' });
    expect(last.status).toBe(200); expect(last.body.operations.map((row: { operationId: string }) => row.operationId)).toEqual([records[50].operationId]); expect(last.body.nextCursor).toBeUndefined();
    expect(last.headers['cache-control']).toBe('no-store');
    for (const query of ['cursor=', 'cursor=a&cursor=b', 'offset=1', `cursor=${'x'.repeat(2049)}`]) {
      expect((await request(f.app).get(`${path}/operations?${query}`).auth('synthetic-schedule-key', { type: 'bearer' })).status).toBe(400);
    }
    expect((await request(f.app).get(`${path}/operations?cursor=unknown`).auth('synthetic-schedule-key', { type: 'bearer' })).status).toBe(409);
    expect(f.reader.request).not.toHaveBeenCalled(); expect(f.manager.start).not.toHaveBeenCalled(); expect(f.manager.request).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual(['journal.json']);
  });
  it.each([false, true])('uses_real_app_origin_and_close_wiring_without_startServer_or_real_host_configuration (disposal rejection: %s)', async failClose => {
    const f = fixture(true, true); vi.resetModules();
    const events = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'] as const;
    const listeners = new Map(events.map(event => [event, [...process.listeners(event)]])); const intervals = vi.spyOn(globalThis, 'setInterval');
    for (const [key, value] of Object.entries({ DATA_DIR: f.directory, DATA_SOURCE: 'ingest', INGEST_API_TOKEN: 'synthetic-ingest-key', AGENT_ROSTER_PATH: '',
      NODE_ENV: 'production', CORS_ORIGIN: 'https://pixel.synthetic.test', PORT: '0', LOG_LEVEL: 'silent',
      OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:9', PIXEL_CONTROL_TOKEN: 'synthetic-schedule-key', OPENCLAW_GATEWAY_TOKEN: '', OPENCLAW_GATEWAY_PASSWORD: '',
      CONTROL_SCHEDULES_MANAGE_ENABLED: 'true', OPENCLAW_SCHEDULES_GATEWAY_TOKEN: '', OPENCLAW_SCHEDULES_GATEWAY_PASSWORD: '',
      CONTROL_SEND_ENABLED: 'false', CONTROL_APPROVALS_ENABLED: 'false', CONTROL_ALLOW_TAILNET_HTTP: 'false' })) vi.stubEnv(key, value);
    const closeService = vi.spyOn(f.schedules, 'close');
    vi.doMock('./gatewayClient', async importOriginal => ({ ...await importOriginal<typeof import('./gatewayClient')>(), createControlGateway: () => f.reader, createScheduleGateway: () => f.manager }));
    vi.doMock('./scheduleService', () => ({ createScheduleService: () => f.schedules }));
    const runtime = await import('../index');
    const { logger } = await import('../logger'); const logged = vi.spyOn(logger, 'error');
    try {
      await new Promise<void>(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
      expect(f.manager.start).not.toHaveBeenCalled();
      const forbidden = await request(runtime.server).post(path).set('Origin', 'https://foreign.synthetic.test').auth('synthetic-schedule-key', { type: 'bearer' }).send({});
      expect(forbidden.status).toBe(403); expect(f.manager.start).not.toHaveBeenCalled();
      const result = await request(runtime.server).get(path).set('Origin', 'https://pixel.synthetic.test').auth('synthetic-schedule-key', { type: 'bearer' });
      expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
      if (failClose) vi.mocked(f.manager.close).mockImplementation(() => { throw Error('synthetic-private-disposal-detail'); });
      await new Promise<void>(resolve => runtime.server.close(() => resolve()));
      expect(closeService).toHaveBeenCalled();
      if (failClose) {
        await expect(closeService.mock.results[0].value).rejects.toMatchObject({ code: 'unavailable' });
        expect(logged).toHaveBeenCalledWith({ subsystem: 'control-schedules', code: 'unavailable' }, 'private scheduling disposal failed');
        expect(JSON.stringify(logged.mock.calls)).not.toContain('synthetic-private-disposal-detail');
      } else await closeService.mock.results[0].value;
      expect(f.manager.close).toHaveBeenCalledTimes(1); expect(f.reader.close).toHaveBeenCalled();
    } finally {
      await runtime.io.close(); for (const timer of intervals.mock.results) if (timer.type === 'return') clearInterval(timer.value);
      for (const event of events) for (const listener of process.listeners(event)) if (!listeners.get(event)?.includes(listener)) process.removeListener(event, listener);
      vi.doUnmock('./gatewayClient'); vi.doUnmock('./scheduleService'); vi.resetModules();
      if (failClose) services.splice(services.indexOf(f.schedules), 1);
    }
  });
});
