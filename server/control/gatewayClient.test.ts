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
import * as devices from './deviceIdentity';
import express from 'express';
import request from 'supertest';
import { createWorkspaceService } from './workspaceService';
import { createTaskService } from './taskService';
import { createControlRouter } from './routes';
import { createUsageService } from './usageService';
import { createRunControlService } from './runControlService';

type Frame = { type: string; id: string; method: string; params: Record<string, any> };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
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
function client(url?: string, sendEnabled = false, options?: { directory: string; deviceOnly: boolean; approvalsEnabled?: boolean }): ControlGateway {
  const dir = options?.directory ?? mkdtempSync(join(tmpdir(), 'pixel-gateway-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadControlConfig(url ? { OPENCLAW_GATEWAY_URL: url, PIXEL_CONTROL_TOKEN: 'fixture-control-key', OPENCLAW_GATEWAY_TOKEN: 'fixture-bootstrap-token' } : {}, dir);
  config.sendEnabled = sendEnabled;
  config.approvalsEnabled = options?.approvalsEnabled ?? false;
  if (options?.deviceOnly) { config.token = undefined; config.password = undefined; }
  const gateway = createControlGateway(config); cleanups.push(() => gateway.close()); return gateway;
}
const ready = async (gateway: ControlGateway) => { gateway.start(); await vi.waitFor(() => expect(gateway.status().state).toBe('ready'), { timeout: 1500, interval: 10 }); };
const existingGrant = 'fixture-existing-read-write-grant';
const writableHello = (id: string) => hello(id, { auth: { role: 'operator', scopes: ['operator.read', 'operator.write'], deviceToken: existingGrant }, features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'chat.send', 'sessions.create'], events: [] } });
const startupRefusal = (id: string) => ({ type: 'res', id, ok: false, error: { code: 'UNAVAILABLE', retryable: true, retryAfterMs: 500, details: { reason: 'startup-sidecars' } } });
function pairedClient(url: string) {
  const directory = mkdtempSync(join(tmpdir(), 'pixel-paired-restart-'));
  const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: url, PIXEL_CONTROL_TOKEN: 'fixture-key' }, directory);
  const identity = devices.loadOrCreateDeviceIdentity(config.deviceDirectory);
  devices.writeDeviceGrant(config.deviceDirectory, config.url!, identity.deviceId, existingGrant, ['operator.read', 'operator.write']);
  return client(url, true, { directory, deviceOnly: true });
}

describe('scoped task Gateway client', () => {
  it('reads, inspects and resolves through signed approval scope and protected HTTP without sending standing grants', async () => {
    const target = { agentId: 'cylena', sessionKey: 'agent:cylena:approval-fixture', sessionId: 'approval-session' };
    const pending = { id: 'exact-full-approval', status: 'pending', createdAtMs: 1, expiresAtMs: Date.now() + 60000,
      presentation: { kind: 'exec', commandText: 'synthetic command', warningText: 'Synthetic warning', allowedDecisions: ['allow-once', 'deny'] } };
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id, {
      auth: { role: 'operator', scopes: ['operator.read', 'operator.approvals'], deviceToken: 'fixture-approval-grant' },
      features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'sessions.messages.subscribe', 'sessions.messages.unsubscribe', 'approval.get', 'approval.resolve'], events: ['session.approval'] },
    }) : { type: 'res', id: frame.id, ok: true, payload: frame.method === 'sessions.describe' ? { session: { ...target, key: target.sessionKey } }
      : frame.method === 'sessions.messages.subscribe' ? { subscribed: true, key: target.sessionKey, agentId: target.agentId, approvalReplay: { sessionKey: target.sessionKey, updatedAtMs: 10, approvals: [pending], truncated: false } }
        : frame.method === 'approval.get' ? { approval: pending }
          : frame.method === 'approval.resolve' ? { applied: false, approval: { ...pending, status: 'denied', resolvedAtMs: 20 } } : {} })));
    const directory = mkdtempSync(join(tmpdir(), 'pixel-approval-flow-'));
    const gateway = client(host.url, false, { directory, deviceOnly: false, approvalsEnabled: true }); await ready(gateway);
    expect(gateway.status()).toMatchObject({ canReviewApprovals: true, canSend: false, canStop: false });
    const tasks = createTaskService(gateway, () => new Set(['cylena']));
    const { createApprovalService } = await import('./approvalService'); const approvals = createApprovalService(gateway, tasks);
    cleanups.push(() => { approvals.close(); tasks.close(); });
    const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: host.url, PIXEL_CONTROL_TOKEN: 'fixture-key', CONTROL_APPROVALS_ENABLED: 'true' }, '/tmp/approval-fixture');
    const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway, tasks, config, approvals }));
    const inspect = await request(app).post('/api/control/agents/cylena/approvals/inspect').auth('fixture-key', { type: 'bearer' }).send({ target, id: pending.id });
    expect(inspect.status).toBe(200); expect(inspect.body.observationId).toEqual(expect.any(String));
    expect(inspect.body.approval.details).toContain('Warning: Synthetic warning');
    const resolved = await request(app).post('/api/control/agents/cylena/approvals/resolve').auth('fixture-key', { type: 'bearer' }).send({ target, id: pending.id, kind: 'exec', decision: 'allow-once', observationId: inspect.body.observationId });
    expect(resolved.status).toBe(200); expect(resolved.body).toMatchObject({ applied: false, approval: { status: 'denied' } });
    expect(host.frames.filter(frame => frame.method === 'approval.resolve').map(frame => frame.params)).toEqual([{ id: pending.id, kind: 'exec', decision: 'allow-once' }]);
    expect(host.frames[0].params.scopes).toEqual(['operator.read', 'operator.approvals']);
    expect(host.frames.some(frame => ['chat.send', 'chat.abort', 'approval.list', 'approval.history'].includes(frame.method))).toBe(false);
  });
  it.each(['missing-method', 'binding-denied'] as const)('keeps approval %s local while ordinary reads stay ready', async variant => {
    const methods = ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'sessions.messages.subscribe', 'sessions.messages.unsubscribe', 'approval.get', ...(variant === 'missing-method' ? [] : ['approval.resolve'])];
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id, {
      auth: { role: 'operator', scopes: ['operator.read', 'operator.approvals'] }, features: { methods, events: [] },
    }) : { type: 'res', id: frame.id, ok: false, error: { code: 'FORBIDDEN', message: 'private binding information' } })));
    const gateway = client(host.url, false, { directory: mkdtempSync(join(tmpdir(), 'pixel-approval-denial-')), deviceOnly: false, approvalsEnabled: true }); await ready(gateway);
    expect(gateway.status().canRead).toBe(true);
    await expect(gateway.request('approval.get', { id: 'synthetic-id' })).rejects.toMatchObject({ code: variant === 'missing-method' ? 'unsupported' : 'approvals-denied' });
    expect(gateway.status().canRead).toBe(true);
  });
  it('negotiates approval scope separately and keeps reads available without that grant', async () => {
    const host = await fixture(); const directory = mkdtempSync(join(tmpdir(), 'pixel-approvals-'));
    const gateway = client(host.url, false, { directory, deviceOnly: false, approvalsEnabled: true }); await ready(gateway);
    expect(host.frames[0].params.scopes).toEqual(['operator.read', 'operator.approvals']);
    expect(gateway.status()).toMatchObject({ canRead: true, canSend: false, canReviewApprovals: false, approvalsDisabledReason: 'scope-required' });
    await expect(gateway.request('approval.get', { id: 'id' })).rejects.toMatchObject({ code: 'approvals-denied' });
  });
  it('falls back to a stored read grant without requesting an approval upgrade', async () => {
    const host = await fixture(); const directory = mkdtempSync(join(tmpdir(), 'pixel-approvals-stored-'));
    const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: host.url, PIXEL_CONTROL_TOKEN: 'fixture-key' }, directory);
    const identity = devices.loadOrCreateDeviceIdentity(config.deviceDirectory);
    devices.writeDeviceGrant(config.deviceDirectory, config.url!, identity.deviceId, 'existing-read-grant', ['operator.read']);
    const gateway = client(host.url, true, { directory, deviceOnly: true, approvalsEnabled: true }); await ready(gateway);
    expect(host.frames[0].params.scopes).toEqual(['operator.read']);
    expect(host.frames[0].params.auth.deviceToken).toBe('existing-read-grant');
    expect(gateway.status()).toMatchObject({ canRead: true, canReviewApprovals: false, approvalsDisabledReason: 'scope-required' });
  });
  it('reports unsupported Stop rather than missing scope when granted write but neither send/create nor abort is advertised', async () => {
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id, {
      auth: { role: 'operator', scopes: ['operator.read', 'operator.write'] },
    }) : { type: 'res', id: frame.id, ok: true, payload: {} })));
    const gateway = client(host.url, true); await ready(gateway);
    expect(gateway.status()).toMatchObject({ canSend: false, canStop: false, stopDisabledReason: 'unsupported' });
    const tasks = createTaskService(gateway, () => new Set(['cylena'])); const controls = createRunControlService(gateway, tasks);
    cleanups.push(() => { controls.close(); tasks.close(); });
    await expect(controls.stop({ target: { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 's1' }, runId: 'run1' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(host.frames.some(frame => frame.method === 'chat.abort')).toBe(false);
  });
  it('keeps exact Stop uncertain without replay after a lost native response and signed reconnect', async () => {
    const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 'stop-instance' };
    const host = await fixture((frame, socket) => {
      if (frame.method === 'connect') {
        const response = writableHello(frame.id); response.payload.features.methods.push('chat.abort'); socket.write(encode(response)); return;
      }
      if (frame.method === 'chat.abort') { socket.destroy(); return; }
      socket.write(encode({ type: 'res', id: frame.id, ok: true, payload: frame.method === 'sessions.describe'
        ? { session: { ...target, key: target.sessionKey, hasActiveRun: true, activeRunIds: ['run1'] } }
        : frame.method === 'chat.history' ? { sessionKey: target.sessionKey, sessionId: target.sessionId, messages: [], hasMore: false, inFlightRun: { runId: 'run1' } }
          : { sessions: [], hasMore: false } }));
    });
    const gateway = client(host.url, true); await ready(gateway);
    const tasks = createTaskService(gateway, () => new Set(['cylena'])); const controls = createRunControlService(gateway, tasks);
    cleanups.push(() => { controls.close(); tasks.close(); });
    const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: host.url, PIXEL_CONTROL_TOKEN: 'fixture-key', CONTROL_SEND_ENABLED: 'true' }, '/tmp/stop-fixture');
    const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway, tasks, config, runControls: controls }));
    const body = { target, runId: 'run1' }; const url = '/api/control/agents/cylena/stop';
    const first = await request(app).post(url).auth('fixture-key', { type: 'bearer' }).send(body);
    expect(first.status).toBe(200); expect(first.body).toEqual({ ...body, phase: 'unknown' });
    await vi.waitFor(() => expect(host.frames.filter(frame => frame.method === 'connect')).toHaveLength(2), { timeout: 2000, interval: 10 });
    await vi.waitFor(() => expect(gateway.status().canStop).toBe(true));
    const second = await request(app).post(url).auth('fixture-key', { type: 'bearer' }).send(body);
    expect(second.body).toEqual({ ...body, phase: 'unknown' });
    expect(host.frames.filter(frame => frame.method === 'chat.abort').map(frame => frame.params)).toEqual([{ agentId: 'cylena', sessionKey: target.sessionKey, runId: 'run1' }]);
    expect(host.frames.filter(frame => frame.method === 'connect').every(frame => JSON.stringify(frame.params.scopes) === '["operator.read","operator.write"]')).toBe(true);
  });
  it('negotiates exact Stop independently of send methods and preserves scoped ownership denial', async () => {
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id, {
      auth: { role: 'operator', scopes: ['operator.read', 'operator.write'] },
      features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'chat.abort'], events: [] },
    }) : { type: 'res', id: frame.id, ok: false, error: { code: 'FORBIDDEN', message: 'private ownership diagnostics' } })));
    const gateway = client(host.url, true); await ready(gateway);
    expect(gateway.status()).toMatchObject({ canStop: true, canSend: false });
    await expect(gateway.request('chat.abort', { agentId: 'a', sessionKey: 'agent:a:fixture', runId: 'run1' })).rejects.toMatchObject({ code: 'stop-denied' });
    expect(host.frames[0].params.scopes).toEqual(['operator.read', 'operator.write']);
    gateway.close(); expect(gateway.status().canStop).toBe(false);
  });
  it.each([false, true])('does not send unadvertised Stop with send enabled=%s', async enabled => {
    const host = await fixture((frame, socket) => socket.write(encode(writableHello(frame.id))));
    const gateway = client(host.url, enabled); await ready(gateway);
    expect(gateway.status().canStop).toBe(false);
    await expect(gateway.request('chat.abort', { runId: 'run1' })).rejects.toMatchObject({ code: enabled ? 'unsupported' : 'scope-required' });
    expect(host.frames.some(frame => frame.method === 'chat.abort')).toBe(false);
  });
  it('denies advertised Stop without a negotiated write grant', async () => {
    const host = await fixture((frame, socket) => socket.write(encode(hello(frame.id, {
      features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'chat.abort'], events: [] },
    }))));
    const gateway = client(host.url, true); await ready(gateway); expect(gateway.status().canStop).toBe(false);
    await expect(gateway.request('chat.abort', { runId: 'run1' })).rejects.toMatchObject({ code: 'scope-required' });
    expect(host.frames.some(frame => frame.method === 'chat.abort')).toBe(false);
  });
  it('only permits the optional historical outcome reader when advertised, without changing scopes', async () => {
    const old = await fixture(); const legacy = client(old.url); await ready(legacy);
    await expect(legacy.request('audit.activity.list', { agentId: 'a', sessionKey: 'agent:a:x', runId: 'run', kind: 'agent_run', limit: 50 })).rejects.toMatchObject({ code: 'unsupported' });
    expect(old.frames.some(frame => frame.method === 'audit.activity.list')).toBe(false); expect(legacy.status().canRead).toBe(true);
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id, { features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'audit.activity.list'], events: [] } })
      : { type: 'res', id: frame.id, ok: true, payload: { events: [] } })));
    const gateway = client(host.url); await ready(gateway); const params = { agentId: 'a', sessionKey: 'agent:a:x', runId: 'run', kind: 'agent_run', limit: 50 };
    await expect(gateway.request('audit.activity.list', params)).resolves.toEqual({ events: [] });
    expect(host.frames.find(frame => frame.method === 'audit.activity.list')?.params).toEqual(params); expect(host.frames.find(frame => frame.method === 'connect')?.params.scopes).toEqual(['operator.read']);
  });
  it('recovers a signed device-only connection after a native startup refusal without replacing its grant or scopes', async () => {
    let connections = 0;
    const host = await fixture((frame, socket) => { if (frame.method === 'connect') socket.write(encode(++connections === 1 ? startupRefusal(frame.id) : writableHello(frame.id))); });
    const gateway = pairedClient(host.url); gateway.start();
    await vi.waitFor(() => expect(connections).toBe(2), { timeout: 2000, interval: 10 });
    await vi.waitFor(() => expect(gateway.status()).toMatchObject({ state: 'ready', canRead: true, canSend: true }));
    const connects = host.frames.filter(frame => frame.method === 'connect');
    for (const { params } of connects) {
      expect(params.auth).toEqual({ deviceToken: existingGrant }); expect(params.scopes).toEqual(['operator.read', 'operator.write']);
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(params.device.publicKey, 'base64url')]), type: 'spki', format: 'der' });
      const payload = ['v3', params.device.id, 'cli', 'backend', 'operator', params.scopes.join(','), '123', existingGrant, 'fixture-nonce', process.platform, ''].join('|');
      expect(verify(null, Buffer.from(payload), key, Buffer.from(params.device.signature, 'base64url'))).toBe(true);
    }
    expect(connects[1].params.device.id).toBe(connects[0].params.device.id);
  });
  it('recovers read/write after a ready connection restarts through native startup refusal without replaying a pending read', async () => {
    let connections = 0;
    const host = await fixture((frame, socket) => { if (frame.method === 'connect') socket.write(encode(++connections === 2 ? startupRefusal(frame.id) : writableHello(frame.id))); });
    const gateway = pairedClient(host.url); await ready(gateway);
    const pending = gateway.request('sessions.describe', { key: 'agent:cylena:fixture' }).catch(error => error);
    await vi.waitFor(() => expect(host.frames.filter(frame => frame.method === 'sessions.describe')).toHaveLength(1));
    [...host.sockets].forEach(socket => socket.destroy()); expect(await pending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(connections).toBe(3), { timeout: 2500, interval: 10 });
    await vi.waitFor(() => expect(gateway.status()).toMatchObject({ state: 'ready', canRead: true, canSend: true }));
    expect(host.frames.filter(frame => frame.method === 'sessions.describe')).toHaveLength(1);
    expect(host.frames.some(frame => ['chat.send', 'sessions.create'].includes(frame.method))).toBe(false);
    for (const frame of host.frames.filter(frame => frame.method === 'connect')) expect(frame.params.auth).toEqual({ deviceToken: existingGrant });
  });
  it('cancels a scheduled startup retry when the office closes', async () => {
    const host = await fixture((frame, socket) => socket.write(encode(startupRefusal(frame.id))));
    const gateway = pairedClient(host.url); gateway.start();
    await vi.waitFor(() => expect(host.frames).toHaveLength(1));
    await vi.waitFor(() => expect(gateway.status().state).toBe('unavailable'));
    gateway.close(); await new Promise(resolve => setTimeout(resolve, 650)); expect(host.frames).toHaveLength(1);
  });
  it('honors bounded native retry hints without weakening the reconnect cap', () => {
    expect(gatewayReconnectDelay(0, () => 0, 500)).toBe(500);
    expect(gatewayReconnectDelay(0, () => 0, 750)).toBe(1000);
    expect(gatewayReconnectDelay(0, () => 0, 16001)).toBe(30000);
    expect(gatewayReconnectDelay(0, () => 0, 60000)).toBe(30000);
    for (const hint of [-1, NaN, Infinity, '500', undefined]) expect(gatewayReconnectDelay(0, () => 0, hint)).toBe(250);
  });
  it('distinguishes an optional Usage method refusal from loss of base read authority', async () => {
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id)
      : { type: 'res', id: frame.id, ok: false, error: { code: 'FORBIDDEN' } })));
    const gateway = client(host.url); await ready(gateway);
    await expect(gateway.request('sessions.usage', { key: 'agent:cylena:fixture', agentId: 'cylena' })).rejects.toMatchObject({ code: 'usage-denied' });
    await expect(gateway.request('sessions.describe', { key: 'agent:cylena:fixture', agentId: 'cylena' })).rejects.toMatchObject({ code: 'scope-required' });
  });
  it('keeps usage optional without breaking the existing read-only task connection', async () => {
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id)
      : { type: 'res', id: frame.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'unknown method: sessions.usage' } })));
    const gateway = client(host.url); await ready(gateway);
    await expect(gateway.request('sessions.usage', { agentId: 'cylena', key: 'agent:cylena:fixture' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(gateway.status().canRead).toBe(true); expect(host.frames.filter(frame => frame.method === 'sessions.usage')).toHaveLength(1);
  });
  it('reads exact usage through the real signed adapter, service and protected HTTP route', async () => {
    const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 'usage-instance' };
    let denyUsage = false;
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id, {
      features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe'], events: [] },
    }) : frame.method === 'sessions.usage' && denyUsage ? { type: 'res', id: frame.id, ok: false, error: { code: 'FORBIDDEN' } }
      : { type: 'res', id: frame.id, ok: true, payload: frame.method === 'sessions.describe'
      ? { session: { ...target, key: target.sessionKey, model: 'fixture', contextTokens: 64000 } }
      : frame.method === 'sessions.usage' ? { sessions: [{ key: target.sessionKey, agentId: target.agentId, sessionId: target.sessionId, scope: 'instance', usage: { input: 0, output: 42, totalCost: 0, missingCostEntries: 0, computedAt: 100 } }] } : {} })));
    const gateway = client(host.url); await ready(gateway);
    const tasks = createTaskService(gateway, () => new Set(['cylena'])); const usage = createUsageService(gateway, tasks);
    cleanups.push(() => { usage.close(); tasks.close(); });
    const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: host.url, PIXEL_CONTROL_TOKEN: 'fixture-key' }, '/tmp/usage-fixture');
    const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway, tasks, usage, config }));
    const path = '/api/control/agents/cylena/usage';
    expect((await request(app).post(path).send(target)).status).toBe(401);
    expect((await request(app).post(path).auth('fixture-key', { type: 'bearer' }).send({ ...target, url: 'http://private' })).status).toBe(400);
    expect(host.frames.some(frame => frame.method === 'sessions.usage')).toBe(false);
    const result = await request(app).post(path).auth('fixture-key', { type: 'bearer' }).send(target);
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ target, tokens: { input: 0, output: 42 }, cost: { usd: 0 }, computedAt: 100 });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(host.frames.filter(frame => frame.method === 'sessions.usage')[0].params).toEqual({ key: target.sessionKey, agentId: target.agentId, range: 'all', groupBy: 'instance', limit: 1, includeContextWeight: false });
    expect(host.frames[0].params.scopes).toEqual(['operator.read']);
    denyUsage = true;
    const usageDenied = await request(app).post(path).auth('fixture-key', { type: 'bearer' }).send(target);
    expect(usageDenied.status).toBe(403); expect(usageDenied.body.code).toBe('usage-denied');
    expect(usageDenied.headers['cache-control']).toBe('no-store');
    expect(gateway.status().canRead).toBe(true);
    await expect(gateway.request('sessions.describe', { key: target.sessionKey })).resolves.toHaveProperty('session');
    app.set('trust proxy', 1);
    const denied = await request(app).post(path).set('X-Forwarded-For', '198.51.100.1').auth('fixture-key', { type: 'bearer' }).send(target);
    expect(denied.status).toBe(403); expect(denied.body.code).toBe('transport-required');
  });
  it('keeps workspace methods optional and old task connections usable', async () => {
    const host = await fixture(); const gateway = client(host.url); await ready(gateway);
    for (const method of ['agents.workspace.list', 'agents.workspace.get'] as const) await expect(gateway.request(method, { agentId: 'cylena', path: '' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(gateway.status().canRead).toBe(true); expect(host.frames.some(frame => frame.method.startsWith('agents.workspace.'))).toBe(false);
  });
  it('reads native workspace bytes through the real adapter, service and authenticated router without sessions', async () => {
    const entry = { path: 'report.txt', name: 'report.txt', kind: 'file', size: 5, updatedAtMs: 100 };
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id, {
      features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'agents.workspace.list', 'agents.workspace.get'], events: [] },
    }) : { type: 'res', id: frame.id, ok: true, payload: frame.method === 'agents.workspace.list'
      ? { agentId: 'cylena', path: '', entries: [entry], offset: 0, totalEntries: 1 }
      : { agentId: 'cylena', file: { ...entry, encoding: 'utf8', mimeType: 'text/plain', content: 'hello' } } })));
    const gateway = client(host.url); await ready(gateway);
    const tasks = createTaskService(gateway, () => new Set(['cylena'])); const workspace = createWorkspaceService(gateway, () => new Set(['cylena']));
    cleanups.push(() => { workspace.close(); tasks.close(); });
    const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: host.url, PIXEL_CONTROL_TOKEN: 'fixture-key' }, '/tmp/workspace-fixture');
    const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway, tasks, workspace, config }));
    const page = await request(app).post('/api/control/agents/cylena/workspace').auth('fixture-key', { type: 'bearer' }).send({ path: '', offset: 0 });
    expect(page.status).toBe(200);
    const file = await request(app).post('/api/control/agents/cylena/workspace/file').auth('fixture-key', { type: 'bearer' }).send({ path: 'report.txt', offset: 0, sourceRevision: page.body.sourceRevision, expected: { size: 5, updatedAtMs: 100 }, intent: 'download' });
    expect(file.status).toBe(200); expect(file.text).toBe('hello'); expect(file.headers['cache-control']).toBe('no-store');
    expect(host.frames.map(frame => frame.method).filter(method => method !== 'sessions.subscribe')).toEqual(['connect', 'agents.workspace.list', 'agents.workspace.list', 'agents.workspace.get']);
    expect(host.frames[0].params.scopes).toEqual(['operator.read']);
  });
  it.each([['workspace_file_too_large', 'file-too-large'], ['workspace_file_unsupported', 'preview-unsupported'], ['workspace_path_not_found', 'file-unavailable'], ['workspace_path_invalid', 'invalid-request'], ['future_workspace_error', 'invalid-request'], ['workspace_path_invalid', 'invalid-request', 'FORBIDDEN'], ['future_grant_denied', 'scope-required', 'FORBIDDEN'], [undefined, 'scope-required', 'FORBIDDEN']])('normalizes native workspace %s without raw diagnostics', async (type, code, nativeCode?: string) => {
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id, {
      features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'agents.workspace.get'], events: [] },
    }) : { type: 'res', id: frame.id, ok: false, error: { code: nativeCode ?? 'INVALID_REQUEST', message: 'private-host-path', details: { type } } })));
    const gateway = client(host.url); await ready(gateway);
    const error = await gateway.request('agents.workspace.get', { agentId: 'cylena', path: 'file' }).catch(error => error);
    expect(error).toMatchObject({ code }); expect((error as Error).message).not.toContain('private-host-path');
  });
  const assistantSelection = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', runId: 'run-1', messageRole: 'assistant' };
  const artifactMethods = ['artifacts.list', 'artifacts.get', 'artifacts.download'] as const;
  it.each([['artifact_not_found', 'file-unavailable'], ['artifact_download_unsupported', 'file-unavailable'], ['artifact_scope_not_found', 'session-changed']])('preserves native %s as %s without private diagnostics', async (type, code) => {
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id, {
      features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', ...artifactMethods], events: [] },
    }) : { type: 'res', id: frame.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'synthetic-private-path', details: { type } } })));
    const gateway = client(host.url); await ready(gateway);
    const error = await gateway.request('artifacts.download', { ...assistantSelection, artifactId: 'artifact-1' }).catch(error => error);
    expect(error).toMatchObject({ code }); expect(error).toBeInstanceOf(Error); expect((error as Error).message).not.toContain('synthetic-private-path');
  });
  it('keeps old Gateway task reads available when optional artifact methods are absent', async () => {
    const host = await fixture(); const gateway = client(host.url); await ready(gateway);
    for (const method of artifactMethods) await expect(gateway.request(method, assistantSelection)).rejects.toMatchObject({ code: 'unsupported' });
    expect(gateway.status().canRead).toBe(true);
    expect(await gateway.request('sessions.list', { agentId: 'cylena' })).toEqual({ sessions: [] });
    expect(host.frames.filter(frame => frame.method.startsWith('artifacts.'))).toHaveLength(0);
  });
  it('treats rejected assistant filtering as optional unsupported functionality without unfiltered retries', async () => {
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id, {
      features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', ...artifactMethods], events: [] },
    }) : frame.method.startsWith('artifacts.') ? { type: 'res', id: frame.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'synthetic-filter-rejected' } }
      : { type: 'res', id: frame.id, ok: true, payload: { sessions: [] } })));
    const gateway = client(host.url); await ready(gateway);
    await expect(gateway.request('artifacts.list', assistantSelection)).rejects.toMatchObject({ code: 'unsupported' });
    expect(host.frames.filter(frame => frame.method === 'artifacts.list').map(frame => frame.params)).toEqual([assistantSelection]);
    expect(gateway.status().canRead).toBe(true);
    await expect(gateway.request('sessions.list', {})).resolves.toEqual({ sessions: [] });
  });
  it('preserves genuine scope rejection and exposes connection identity only while that generation is ready', async () => {
    const host = await fixture((frame, socket) => socket.write(encode(frame.method === 'connect' ? hello(frame.id, {
      features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', ...artifactMethods], events: [] },
    }) : { type: 'res', id: frame.id, ok: false, error: { code: 'FORBIDDEN' } })));
    const gateway = client(host.url);
    expect(gateway.artifactConnection?.()).toBeNull(); await ready(gateway);
    expect(gateway.artifactConnection?.()).toEqual({ id: 'fixture', generation: expect.any(Number), gatewayUrl: host.url + '/' });
    await expect(gateway.request('artifacts.get', { ...assistantSelection, artifactId: 'artifact-1' })).rejects.toMatchObject({ code: 'scope-required' });
    gateway.close(); expect(gateway.artifactConnection?.()).toBeNull();
  });
  it('reports disconnected writes as unavailable rather than revoked authority', async () => {
    const host = await fixture(); const gateway = client(host.url, true);
    await expect(gateway.request('chat.send', {})).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('reconnects with read authority when a partial grant cannot support configured writes', async () => {
    let connections = 0; const token = 'synthetic-scoped-read-token';
    const host = await fixture((frame, socket) => {
      if (frame.method !== 'connect') return;
      connections++;
      if (connections > 1 && (frame.params.auth.deviceToken !== token || frame.params.scopes.join() !== 'operator.read')) {
        socket.write(encode({ type: 'res', id: frame.id, ok: false, error: { details: { code: 'AUTH_SCOPE_MISMATCH' } } })); return;
      }
      socket.write(encode(hello(frame.id, { auth: { role: 'operator', scopes: ['operator.read'], deviceToken: token } })));
    });
    const directory = mkdtempSync(join(tmpdir(), 'pixel-partial-grant-')); const first = client(host.url, true, { directory, deviceOnly: false }); await ready(first); first.close();
    const second = client(host.url, true, { directory, deviceOnly: true }); await ready(second); expect(second.status()).toMatchObject({ canRead: true, canSend: false });
  });
  it('reuses a broader token for read-only connections without overwriting its known grant', async () => {
    const token = 'synthetic-own-scoped-token'; let connections = 0;
    const host = await fixture((frame, socket) => {
      if (frame.method !== 'connect') return; connections++;
      if (connections > 1 && frame.params.auth.deviceToken !== token) { socket.write(encode({ type: 'res', id: frame.id, ok: false, error: { details: { code: 'AUTH_TOKEN_MISMATCH' } } })); return; }
      socket.write(encode(hello(frame.id, { auth: { role: 'operator', scopes: frame.params.scopes, deviceToken: token }, features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'chat.send', 'sessions.create'], events: [] } })));
    });
    const directory = mkdtempSync(join(tmpdir(), 'pixel-scope-downgrade-'));
    const first = client(host.url, true, { directory, deviceOnly: false }); await ready(first); first.close();
    const second = client(host.url, false, { directory, deviceOnly: true }); await ready(second); expect(second.status().canSend).toBe(false); second.close();
    const third = client(host.url, true, { directory, deviceOnly: true }); await ready(third); expect(third.status().canSend).toBe(true);
  });
  it('keeps a freshly rotated token in memory when persistence fails and retries storage without old-token auth', async () => {
    const token = 'synthetic-rotated-device-token'; let connections = 0;
    const host = await fixture((frame, socket) => {
      if (frame.method !== 'connect') return; connections++;
      if (connections > 1 && frame.params.auth.deviceToken !== token) { socket.write(encode({ type: 'res', id: frame.id, ok: false, error: { details: { code: 'AUTH_TOKEN_MISMATCH' } } })); return; }
      socket.write(encode(hello(frame.id, { auth: { role: 'operator', scopes: ['operator.read'], deviceToken: token } })));
    });
    const directory = mkdtempSync(join(tmpdir(), 'pixel-device-io-')); const identity = devices.loadOrCreateDeviceIdentity(join(directory, 'control'));
    devices.writeDeviceGrant(join(directory, 'control'), host.url+'/', identity.deviceId, 'synthetic-old-token', ['operator.read']);
    vi.spyOn(devices, 'writeDeviceGrant').mockImplementationOnce(() => { throw Object.assign(Error('synthetic storage full'), { code: 'ENOSPC' }); });
    const gateway = client(host.url, false, { directory, deviceOnly: true }); await ready(gateway); expect(connections).toBe(2);
  });
  it('retries transient identity I/O but keeps malformed identities terminal', async () => {
    const host = await fixture(); const original = devices.loadOrCreateDeviceIdentity;
    vi.spyOn(devices, 'loadOrCreateDeviceIdentity').mockImplementationOnce(() => { throw Object.assign(Error('synthetic I/O failure'), { code: 'EIO' }); }).mockImplementation(original);
    const gateway = client(host.url); await ready(gateway); expect(gateway.status().canRead).toBe(true);
  });
  it.each([true, false])('requires explicit opt-in and negotiated write scope: %s', async grant => {
    const host = await fixture((frame, socket) => {
      socket.write(encode(frame.method === 'connect' ? hello(frame.id, {
        auth: { role: 'operator', scopes: grant ? ['operator.read', 'operator.write'] : ['operator.read'] },
        features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'chat.send', 'sessions.create'], events: [] },
      }) : { type: 'res', id: frame.id, ok: true, payload: { runId: 'send-fixture' } }));
    });
    const gateway = client(host.url, true); await ready(gateway);
    expect(host.frames[0].params.scopes).toEqual(['operator.read', 'operator.write']);
    expect(gateway.status()).toMatchObject({ canRead: true, canSend: grant });
    if (grant) await expect(gateway.request('chat.send', {})).resolves.toEqual({ runId: 'send-fixture' });
    else { await expect(gateway.request('chat.send', {})).rejects.toMatchObject({ code: 'scope-required' }); expect(host.frames).toHaveLength(1); }
    await expect(gateway.request('chat.inject' as never, {})).rejects.toThrow();
  });
  it('does not connect when task configuration is disabled', () => {
    const gateway = client(); gateway.start();
    expect(gateway.status()).toEqual({ configured: false, state: 'disabled', canRead: false, canSend: false, canStop: false });
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
    const host = await fixture((frame, socket) => { if (frame.method === 'connect') socket.write(encode({ type: 'res', id: frame.id, ok: false, error: { code: 'UNAUTHORIZED', retryable: true, message: 'fixture-secret', details: { code } } })); });
    const gateway = client(host.url); gateway.start();
    await vi.waitFor(() => expect(gateway.status().state).toBe(state), { timeout: 1500 });
    expect(JSON.stringify(gateway.status())).not.toContain('fixture-secret');
    await new Promise(resolve => setTimeout(resolve, 650)); expect(host.frames).toHaveLength(1);
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
