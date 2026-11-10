// @vitest-environment node
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadControlConfig } from './config';
import { loadScheduleConfig } from './scheduleConfig';
import { createControlGateway, createScheduleGateway, type ControlMethod, type ScheduleGateway, type ScheduleMethod } from './gatewayClient';
import * as devices from './deviceIdentity';

type Frame = { type: string; id: string; method: string; params: Record<string, any> };
const methods = ['cron.list', 'cron.get', 'cron.add', 'cron.update'];
const ordinaryMethods = ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe'];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function encode(value: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10); header[0] = 0x81;
  if (header.length === 2) header[1] = data.length;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  return Buffer.concat([header, data]);
}
function hello(frame: Frame, changes = {}) {
  return { type: 'res', id: frame.id, ok: true, payload: {
    type: 'hello-ok', protocol: 4, server: { version: 'fixture', connId: 'schedule-fixture' },
    features: { methods, events: [] }, snapshot: {},
    auth: { role: 'operator', scopes: ['operator.read', 'operator.admin'], deviceToken: 'schedule-device-grant' },
    policy: { maxPayload: 25 * 1024 * 1024, maxBufferedBytes: 50 * 1024 * 1024, tickIntervalMs: 15000 }, ...changes,
  } };
}
async function fixture(onFrame?: (frame: Frame, socket: Duplex) => void) {
  const sockets = new Set<Duplex>(); const frames: Frame[] = []; const server = createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(encode({ type: 'event', event: 'connect.challenge', payload: { nonce: 'schedule-nonce', ts: 123 } }));
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15; let length = buffered[1] & 127; let offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
        const masked = Boolean(buffered[1] & 128); const maskBytes = masked ? 4 : 0;
        if (buffered.length < offset + maskBytes + length) return;
        const mask = buffered.subarray(offset, offset + maskBytes); offset += maskBytes;
        const data = Buffer.from(buffered.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buffered = buffered.subarray(offset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const frame = JSON.parse(data.toString()) as Frame; frames.push(frame);
        if (onFrame) onFrame(frame, socket);
        else socket.write(encode(frame.method === 'connect' ? hello(frame) : { type: 'res', id: frame.id, ok: true, payload: { ok: true } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture address');
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `ws://127.0.0.1:${address.port}/`, frames, sockets };
}
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'pixel-scheduling-')); cleanups.push(() => rmSync(path, { recursive: true, force: true })); return path;
}
function config(url: string, path = directory(), bootstrap = true) {
  const reader = loadControlConfig({ OPENCLAW_GATEWAY_URL: url, PIXEL_CONTROL_TOKEN: 'fixture-access', OPENCLAW_GATEWAY_TOKEN: 'ordinary-bootstrap' }, path);
  return loadScheduleConfig({ CONTROL_SCHEDULES_MANAGE_ENABLED: 'true', ...(bootstrap ? { OPENCLAW_SCHEDULES_GATEWAY_TOKEN: 'schedule-bootstrap' } : {}) }, path, reader);
}
function client(configuration: ReturnType<typeof config>): ScheduleGateway {
  const gateway = createScheduleGateway(configuration); cleanups.push(() => gateway.close()); return gateway;
}
async function ready(gateway: ScheduleGateway) {
  gateway.start(); await vi.waitFor(() => expect(gateway.status().state).toBe('ready'), { timeout: 1500, interval: 10 });
}
function checkSignature(frame: Frame, token: string) {
  const { params } = frame;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(params.device.publicKey, 'base64url')]), type: 'spki', format: 'der' });
  const payload = ['v3', params.device.id, 'cli', 'backend', 'operator', params.scopes.join(','), '123', token, 'schedule-nonce', process.platform, ''].join('|');
  expect(verify(null, Buffer.from(payload), key, Buffer.from(params.device.signature, 'base64url'))).toBe(true);
}

describe('separate signed scheduling authority', () => {
  it('optout_has_no_files_or_socket', async () => {
    const host = await fixture(); const path = directory();
    const disabled = loadScheduleConfig({}, path, loadControlConfig({ OPENCLAW_GATEWAY_URL: host.url, PIXEL_CONTROL_TOKEN: 'fixture-access' }, path));
    const gateway = client(disabled);
    expect(gateway.status()).toEqual({ configured: false, state: 'disabled', canManage: false, epoch: null, reason: 'disabled' });
    expect(gateway.connection()).toBeNull(); gateway.start(); gateway.close();
    expect(existsSync(disabled.deviceDirectory)).toBe(false); expect(host.frames).toEqual([]); expect(host.sockets.size).toBe(0);
  });
  it('defers enabled identity and socket side effects to start only', async () => {
    const host = await fixture(); const configured = config(host.url); const gateway = client(configured);
    gateway.status(); expect(gateway.connection()).toBeNull(); gateway.close(); gateway.start();
    expect(existsSync(configured.deviceDirectory)).toBe(false); expect(host.frames).toEqual([]);
  });
  it('management_only_requests_read_admin', async () => {
    const host = await fixture(); const gateway = client(config(host.url)); await ready(gateway);
    const connectFrame = host.frames[0];
    expect(connectFrame.params.scopes).toEqual(['operator.read', 'operator.admin']);
    expect(connectFrame.params.scopes).not.toContain('operator.write');
    expect(connectFrame.params.scopes).not.toContain('operator.approvals');
    expect(connectFrame.params.caps).toEqual([]); checkSignature(connectFrame, 'schedule-bootstrap');
    expect(gateway.status()).toMatchObject({ configured: true, canManage: true, epoch: expect.any(String), reason: null });
    expect(gateway.connection()).toEqual({ epoch: gateway.status().epoch, gatewayUrl: host.url, deviceId: connectFrame.params.device.id });
    for (const method of methods) await expect(gateway.request(method as ScheduleMethod, {})).resolves.toEqual({ ok: true });
    expect(host.frames.map(frame => frame.method)).toEqual(['connect', ...methods]);
  });
  it.each(methods)('requires all negotiation methods before management readiness: %s', async omitted => {
    const host = await fixture((frame, socket) => socket.write(encode(hello(frame, { features: { methods: methods.filter(method => method !== omitted), events: [] } }))));
    const gateway = client(config(host.url)); gateway.start();
    await vi.waitFor(() => expect(gateway.status()).toMatchObject({ state: 'unsupported', canManage: false, epoch: null, reason: 'unsupported' }));
    expect(gateway.connection()).toBeNull(); expect(host.frames).toHaveLength(1);
  });
  it('separate_devices_and_grants', async () => {
    const host = await fixture((frame, socket) => {
      if (frame.method !== 'connect') return;
      const scheduling = frame.params.scopes.includes('operator.admin');
      socket.write(encode(hello(frame, { auth: { role: 'operator', scopes: frame.params.scopes, deviceToken: scheduling ? 'schedule-device-grant' : 'ordinary-device-grant' }, features: { methods: scheduling ? methods : ordinaryMethods, events: [] } })));
    });
    const path = directory(); const ordinaryConfig = loadControlConfig({ OPENCLAW_GATEWAY_URL: host.url, PIXEL_CONTROL_TOKEN: 'fixture-access', OPENCLAW_GATEWAY_TOKEN: 'ordinary-bootstrap' }, path);
    const ordinary = createControlGateway(ordinaryConfig); cleanups.push(() => ordinary.close()); ordinary.start();
    await vi.waitFor(() => expect(ordinary.status().state).toBe('ready'));
    const configured = config(host.url, path); const scheduling = client(configured); await ready(scheduling);
    const [readFrame, scheduleFrame] = host.frames;
    expect(readFrame.params.device.id).not.toBe(scheduleFrame.params.device.id);
    expect(readFrame.params.auth).toEqual({ token: 'ordinary-bootstrap' }); expect(scheduleFrame.params.auth).toEqual({ token: 'schedule-bootstrap' });
    checkSignature(readFrame, 'ordinary-bootstrap'); checkSignature(scheduleFrame, 'schedule-bootstrap');
    expect(devices.readDeviceGrantDetails(ordinaryConfig.deviceDirectory, host.url, readFrame.params.device.id)).toMatchObject({ token: 'ordinary-device-grant', scopes: ['operator.read'] });
    expect(devices.readDeviceGrantDetails(configured.deviceDirectory, host.url, scheduleFrame.params.device.id)).toMatchObject({ token: 'schedule-device-grant', scopes: ['operator.read', 'operator.admin'] });
    expect(lstatSync(configured.deviceDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(configured.deviceDirectory, 'device.json')).mode & 0o777).toBe(0o600);
  });
  it('cross_profile_RPC_is_rejected_before_send', async () => {
    const host = await fixture((frame, socket) => socket.write(encode(hello(frame, { features: { methods: [...methods, ...ordinaryMethods, 'cron.run', 'cron.remove', 'agents.workspace.get', 'chat.send', 'sessions.patch', 'approval.resolve'], events: [] } }))));
    const scheduling = client(config(host.url)); await ready(scheduling);
    for (const forbidden of ['cron.run', 'cron.remove', 'agents.workspace.get', 'chat.send', 'sessions.patch', 'approval.resolve', 'sessions.list', 'connect']) {
      await expect(scheduling.request(forbidden as ScheduleMethod, {})).rejects.toMatchObject({ code: 'schedule-denied' });
    }
    const ordinary = createControlGateway(loadControlConfig({ OPENCLAW_GATEWAY_URL: host.url, PIXEL_CONTROL_TOKEN: 'fixture-access', CONTROL_SEND_ENABLED: 'true' }, directory())); cleanups.push(() => ordinary.close()); ordinary.start();
    await vi.waitFor(() => expect(ordinary.status().state).toBe('ready'));
    for (const forbidden of ['cron.add', 'cron.update', 'cron.run', 'cron.remove']) await expect(ordinary.request(forbidden as ControlMethod, {})).rejects.toMatchObject({ code: 'scope-required' });
    expect(host.frames.every(frame => frame.method === 'connect')).toBe(true);
  });
  it('never retains send or approval scopes in the scheduling grant', async () => {
    const host = await fixture(); const configured = config(host.url, directory(), false);
    const identity = devices.loadOrCreateDeviceIdentity(configured.deviceDirectory);
    devices.writeDeviceGrant(configured.deviceDirectory, host.url, identity.deviceId, 'schedule-device-grant', ['operator.read', 'operator.admin', 'operator.write', 'operator.approvals']);
    const gateway = client(configured); await ready(gateway);
    expect(devices.readDeviceGrantDetails(configured.deviceDirectory, host.url, identity.deviceId)?.scopes).toEqual(['operator.read', 'operator.admin']);
  });
  it('device_only_reconnect_never_upgrades', async () => {
    const host = await fixture((frame, socket) => socket.write(encode(hello(frame, { auth: { role: 'operator', scopes: frame.params.scopes, deviceToken: 'schedule-device-grant' } }))));
    const path = directory(); const first = client(config(host.url, path)); await ready(first); const firstId = host.frames[0].params.device.id; first.close();
    const second = client(config(host.url, path, false)); await ready(second);
    const reconnectFrame = host.frames[1]; expect(reconnectFrame.params.auth).toEqual({ deviceToken: 'schedule-device-grant' });
    expect(reconnectFrame.params.device.id).toBe(firstId); expect(reconnectFrame.params.scopes).toEqual(['operator.read', 'operator.admin']); checkSignature(reconnectFrame, 'schedule-device-grant'); second.close();
    devices.writeDeviceGrant(join(path, 'control-schedules'), host.url, firstId, 'schedule-device-grant', ['operator.read']);
    const partial = client(config(host.url, path, false)); await ready(partial);
    expect(host.frames[2].params.scopes).toEqual(['operator.read']); expect(host.frames[2].params.auth).toEqual({ deviceToken: 'schedule-device-grant' });
    expect(partial.status()).toMatchObject({ canManage: false, epoch: null, reason: 'permission' });
    await expect(partial.request('cron.add', {})).rejects.toMatchObject({ code: 'schedule-denied' }); expect(host.frames).toHaveLength(3);
  });
  it('revocation_invalidates_epoch', async () => {
    let connections = 0;
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect'
      ? ++connections === 1 ? hello(frame) : { type: 'res', id: frame.id, ok: false, error: { code: 'FORBIDDEN' } }
      : { type: 'res', id: frame.id, ok: false, error: { code: 'FORBIDDEN', message: 'private denial' } })));
    const gateway = client(config(host.url)); await ready(gateway); const epoch = gateway.status().epoch; expect(epoch).not.toBeNull();
    await expect(gateway.request('cron.update', {})).rejects.toMatchObject({ code: 'schedule-denied' });
    expect(gateway.status()).toMatchObject({ canManage: false, epoch: null, reason: 'permission' }); expect(gateway.connection()).toBeNull();
  });
  it.each([
    [{ code: 'INVALID_REQUEST', details: { code: 'CRON_JOB_CHANGED' } }, 'schedule-changed'],
    [{ code: 'INVALID_REQUEST', details: { code: 'OTHER' } }, 'invalid-request'],
    [{ code: 'CRON_JOB_CHANGED' }, 'schedule-changed'],
    [{ code: 'UNAVAILABLE' }, 'schedule-outcome-unknown'],
  ])('native_revision_conflict_is_preserved: %j', async (error, code) => {
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame) : { type: 'res', id: frame.id, ok: false, error: { ...error, message: 'private definition' } })));
    const gateway = client(config(host.url)); await ready(gateway);
    const failure = await gateway.request('cron.update', { expectedConfigRevision: 'native-revision' }).catch(error => error);
    expect(failure).toMatchObject({ code }); expect((failure as Error).message).not.toContain('private definition');
    expect(host.frames.filter(frame => frame.method === 'cron.update')).toHaveLength(1);
  });
  it('invalidates connection epochs on disconnect without replaying ambiguous mutations', async () => {
    const host = await fixture((frame, socket) => { if (frame.method === 'connect') socket.write(encode(hello(frame))); });
    const gateway = client(config(host.url)); await ready(gateway); const epoch = gateway.status().epoch;
    const pending = gateway.request('cron.add', {}).catch(error => error);
    await vi.waitFor(() => expect(host.frames).toHaveLength(2)); for (const socket of host.sockets) socket.destroy();
    expect(await pending).toMatchObject({ code: 'schedule-outcome-unknown' }); expect(gateway.connection()).toBeNull();
    await vi.waitFor(() => expect(gateway.status().canManage).toBe(true), { timeout: 2000 });
    expect(gateway.status().epoch).not.toBe(epoch); expect(host.frames.filter(frame => frame.method === 'cron.add')).toHaveLength(1);
  });
  it('bounds pending requests and keeps the five-second mutation deadline ambiguous', async () => {
    const host = await fixture((frame, socket) => { if (frame.method === 'connect') socket.write(encode(hello(frame))); });
    const gateway = client(config(host.url)); await ready(gateway); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = Array.from({ length: 8 }, () => gateway.request('cron.update', {}).catch(error => error));
    await expect(gateway.request('cron.update', {})).rejects.toThrow('Too many pending');
    await vi.advanceTimersByTimeAsync(5000);
    for (const error of await Promise.all(pending)) expect(error).toMatchObject({ code: 'schedule-outcome-unknown' });
  });
  it('refuses oversized management frames and invalidates the epoch', async () => {
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame) : { type: 'res', id: frame.id, ok: true, payload: 'x'.repeat(2 * 1024 * 1024) })));
    const gateway = client(config(host.url)); await ready(gateway);
    await expect(gateway.request('cron.update', {})).rejects.toMatchObject({ code: 'schedule-outcome-unknown' });
    expect(gateway.status()).toMatchObject({ state: 'unsupported', canManage: false, epoch: null });
  });
});
