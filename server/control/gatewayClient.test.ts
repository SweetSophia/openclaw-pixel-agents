// @vitest-environment node
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadControlConfig } from './config';
import { createControlGateway, gatewayReconnectDelay, type ControlGateway } from './gatewayClient';

type Frame = { type: string; id: string; method: string; params: Record<string, any> };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); });
function encode(value: unknown): Buffer {
  const text = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(text.length < 126 ? 2 : text.length <= 65535 ? 4 : 10); header[0] = 0x81;
  if (header.length === 2) header[1] = text.length;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(text.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(text.length), 2); }
  return Buffer.concat([header, text]);
}
const hello = (id: string, changes = {}) => ({ type: 'res', id, ok: true, payload: {
  type: 'hello-ok', protocol: 4, server: { version: 'fixture', connId: 'fixture' },
  features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe'], events: ['sessions.changed'] },
  snapshot: {}, auth: { role: 'operator', scopes: ['operator.read'], deviceToken: 'fixture-scoped-device-token' },
  policy: { maxPayload: 25 * 1024 * 1024, maxBufferedBytes: 50 * 1024 * 1024, tickIntervalMs: 15000 }, ...changes,
} });

async function fixture(onFrame?: (frame: Frame, socket: Duplex) => void, challenge: unknown = { nonce: 'fixture-nonce', ts: 123 }) {
  const sockets = new Set<Duplex>(); const frames: Frame[] = [];
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(encode({ type: 'event', event: 'connect.challenge', payload: challenge }));
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
        else if (frame.method === 'connect') socket.write(encode(hello(frame.id)));
        else socket.write(encode({ type: 'res', id: frame.id, ok: true, payload: { sessions: [] } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture address missing');
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `ws://127.0.0.1:${address.port}`, frames, sockets };
}
function client(url?: string): ControlGateway {
  const dir = mkdtempSync(join(tmpdir(), 'pixel-gateway-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadControlConfig(url ? { OPENCLAW_GATEWAY_URL: url, PIXEL_CONTROL_TOKEN: 'fixture-control-key', OPENCLAW_GATEWAY_TOKEN: 'fixture-bootstrap-token' } : {}, dir);
  const gateway = createControlGateway(config); cleanups.push(() => gateway.close()); return gateway;
}
const ready = async (gateway: ControlGateway) => { gateway.start(); await vi.waitFor(() => expect(gateway.status().state).toBe('ready'), { timeout: 1500, interval: 10 }); };

describe('scoped task Gateway client', () => {
  it('does not connect when task configuration is disabled', () => {
    const gateway = client(); gateway.start();
    expect(gateway.status()).toEqual({ configured: false, state: 'disabled', canRead: false, canSend: false });
  });
  it('signs the actual challenge and requests only read authority over native WebSocket frames', async () => {
    const host = await fixture(); const gateway = client(host.url); await ready(gateway);
    const connect = host.frames.find(frame => frame.method === 'connect')!; const p = connect.params;
    expect(p).toMatchObject({ minProtocol: 4, maxProtocol: 4, client: { id: 'cli', mode: 'backend' }, role: 'operator', scopes: ['operator.read'] });
    expect(p.device.signedAt).toBe(123);
    const raw = Buffer.from(p.device.publicKey, 'base64url');
    expect(p.device.id).toBe(createHash('sha256').update(raw).digest('hex'));
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), type: 'spki', format: 'der' });
    const payload = ['v3', p.device.id, 'cli', 'backend', 'operator', 'operator.read', '123', 'fixture-bootstrap-token', 'fixture-nonce', process.platform, ''].join('|');
    expect(verify(null, Buffer.from(payload), key, Buffer.from(p.device.signature, 'base64url'))).toBe(true);
    expect(await gateway.request('sessions.list', { agentId: 'cylena' })).toEqual({ sessions: [] });
    expect(gateway.status().canSend).toBe(false);
    await expect(gateway.request('chat.send' as never, {})).rejects.toThrow();
    expect(host.frames.some(frame => frame.method === 'chat.send')).toBe(false);
  });
  it.each([
    ['pairing-required', 'PAIRING_REQUIRED'], ['auth-error', 'AUTH_TOKEN_MISMATCH'], ['auth-error', 'AUTH_SCOPE_MISMATCH'],
  ])('surfaces %s without exposing raw credential diagnostics', async (state, code) => {
    const host = await fixture((frame, socket) => { if (frame.method === 'connect') socket.write(encode({ type: 'res', id: frame.id, ok: false, error: { message: 'fixture-secret', details: { code } } })); });
    const gateway = client(host.url); gateway.start();
    await vi.waitFor(() => expect(gateway.status().state).toBe(state), { timeout: 1500 });
    expect(JSON.stringify(gateway.status())).not.toContain('fixture-secret');
  });
  it.each([{ nonce: 'fixture', ts: -1 }, { nonce: '', ts: 123 }, { nonce: 'fixture' }])('rejects malformed challenges: %j', async challenge => {
    const host = await fixture(undefined, challenge); const gateway = client(host.url); gateway.start();
    await vi.waitFor(() => expect(gateway.status().state).toBe('unsupported'), { timeout: 1500 });
    expect(host.frames).toHaveLength(0);
  });
  it.each([{ protocol: 3 }, { auth: { role: 'operator', scopes: [] } }, { features: { methods: [], events: [] } }])('rejects unsupported negotiated authority or features: %j', async changes => {
    const host = await fixture((frame, socket) => socket.write(encode(hello(frame.id, changes)))); const gateway = client(host.url); gateway.start();
    await vi.waitFor(() => expect(['unsupported', 'auth-error']).toContain(gateway.status().state), { timeout: 1500 });
    expect(gateway.status().canRead).toBe(false);
  });
  it('rejects the ninth pending request and releases pending work on close', async () => {
    const host = await fixture((frame, socket) => { if (frame.method === 'connect') socket.write(encode(hello(frame.id))); });
    const gateway = client(host.url); await ready(gateway);
    const pending = Array.from({ length: 8 }, () => gateway.request('sessions.list', {}).catch(error => error));
    await expect(gateway.request('sessions.list', {})).rejects.toThrow('Too many pending');
    gateway.close();
    expect((await Promise.all(pending)).every(value => value instanceof Error)).toBe(true);
  });
  it('expires a source read after five seconds without replaying it', async () => {
    const host = await fixture((frame, socket) => { if (frame.method === 'connect') socket.write(encode(hello(frame.id))); });
    const gateway = client(host.url); await ready(gateway); vi.useFakeTimers();
    const pending = expect(gateway.request('sessions.list', {})).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5000); await pending;
    gateway.close();
  });
  it('invalidates a generation on an event gap and ignores an old socket response', async () => {
    const host = await fixture((frame, socket) => { if (frame.method === 'connect') socket.write(encode(hello(frame.id))); });
    const gateway = client(host.url); await ready(gateway); const events: string[] = [];
    gateway.onEvent(event => events.push(event.event));
    const result = gateway.request('sessions.list', {}).catch(error => error);
    await vi.waitFor(() => expect(host.frames.some(frame => frame.method === 'sessions.list')).toBe(true));
    const socket = [...host.sockets][0]; const req = host.frames.find(frame => frame.method === 'sessions.list')!;
    socket.write(encode({ type: 'event', event: 'sessions.changed', seq: 1, payload: {} }));
    socket.write(encode({ type: 'event', event: 'sessions.changed', seq: 3, payload: {} }));
    socket.write(encode({ type: 'res', id: req.id, ok: true, payload: { unsafeOld: true } }));
    expect(await result).toBeInstanceOf(Error);
    expect(events).toContain('source.invalidated'); gateway.close();
  });
  it('rejects oversized or malformed source frames', async () => {
    const host = await fixture(); const gateway = client(host.url); await ready(gateway);
    [...host.sockets][0].write(encode({ type: 'event', event: 'sessions.changed', payload: 'x'.repeat(2 * 1024 * 1024) }));
    await vi.waitFor(() => expect(gateway.status().canRead).toBe(false), { timeout: 1500 }); gateway.close();
  });
  it('rejects invalid JSON and never treats it as a source update', async () => {
    const host = await fixture(); const gateway = client(host.url); await ready(gateway);
    [...host.sockets][0].write(Buffer.from([0x81, 1, 0x7b]));
    await vi.waitFor(() => expect(gateway.status().state).toBe('unsupported'), { timeout: 1500 });
  });
  it('backs reconnects off without exceeding thirty seconds', async () => {
    const delays = Array.from({ length: 20 }, (_, attempt) => gatewayReconnectDelay(attempt, () => 1));
    expect(delays.slice(0, 5)).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(delays[19]).toBe(30000);
    expect(gatewayReconnectDelay(0, () => 0)).toBe(250);
    const host = await fixture(); const gateway = client(host.url); await ready(gateway);
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(1);
    const scheduled = vi.spyOn(globalThis, 'setTimeout');
      [...host.sockets].forEach(socket => socket.destroy());
      // Yield to real network callbacks while the retry clock remains paused.
      await vi.waitFor(() => expect(gateway.status().canRead).toBe(false), { timeout: 1000 });
      const retryCalls = scheduled.mock.calls.filter(call => Number(call[1]) >= 250 && Number(call[1]) <= 30000);
      expect(retryCalls.length).toBeGreaterThan(0);
      expect(Number(retryCalls[retryCalls.length - 1][1])).toBe(500);
    gateway.close(); vi.restoreAllMocks();
  });
});
