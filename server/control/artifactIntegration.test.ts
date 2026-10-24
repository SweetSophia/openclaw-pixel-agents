// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlGateway } from './gatewayClient';
import { loadControlConfig } from './config';
import { createTaskService } from './taskService';
import { createArtifactService } from './artifactService';
import { createControlRouter } from './routes';

type Frame = { id: string; method: string; params: Record<string, unknown> };
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 'session-1' };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function wire(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(bytes.length < 126 ? 2 : bytes.length <= 65535 ? 4 : 10); header[0] = 0x81;
  if (header.length === 2) header[1] = bytes.length; else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(bytes.length, 2); } else { header[1] = 127; header.writeBigUInt64BE(BigInt(bytes.length), 2); }
  return Buffer.concat([header, bytes]);
}
async function fixture() {
  const sockets = new Set<Duplex>(); const frames: Frame[] = []; const httpPaths: string[] = [];
  let runId = 'run-1'; let mode: 'inline' | 'http' | 'managed' | 'external' | 'escaped-link' | 'oversized' | 'mismatch' | 'expired' | 'held' = 'inline';
  let downloads = 0; let held: (() => void) | undefined;
  const ticket = 'T'.repeat(43); const attachment = '12345678-1234-4123-8123-123456789abc';
  const artifact = () => ({ id: 'artifact-1', type: 'file', title: 'report.txt', mimeType: 'text/plain', sessionKey: target.sessionKey, runId, messageSeq: 2, download: { mode: 'bytes' } });
  const http = createServer((req, res) => {
    httpPaths.push(req.url ?? '');
    if (mode === 'oversized') { res.setHeader('Content-Type', 'text/plain'); res.write(Buffer.alloc(8 * 1024 * 1024 + 1)); res.end(Buffer.alloc(8 * 1024 * 1024 + 1)); }
    else { res.setHeader('Content-Type', 'text/plain'); res.end('fixture delivered bytes'); }
  });
  http.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(wire({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture', ts: Date.now() } }));
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15; let length = buffered[1] & 127; let offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
        const masked = !!(buffered[1] & 128); const maskLength = masked ? 4 : 0;
        if (buffered.length < offset + maskLength + length) return;
        const mask = buffered.subarray(offset, offset + maskLength); offset += maskLength; const bytes = Buffer.from(buffered.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask[i % 4]; buffered = buffered.subarray(offset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; } if (opcode !== 1) continue;
        const frame = JSON.parse(bytes.toString()) as Frame; frames.push(frame);
        const reply = (payload: unknown) => socket.write(wire({ type: 'res', id: frame.id, ok: true, payload }));
        const row = { ...target, key: target.sessionKey, hasActiveRun: true, snapshotAt: 100 };
        if (frame.method === 'connect') reply({ type: 'hello-ok', protocol: 4, server: { version: 'fixture', connId: 'fixture' }, snapshot: {},
          auth: { role: 'operator', scopes: ['operator.read'] }, features: { methods: ['sessions.list', 'sessions.describe', 'sessions.subscribe', 'chat.history', 'artifacts.list', 'artifacts.get', 'artifacts.download'], events: ['sessions.changed'] },
          policy: { maxPayload: 25 * 1024 * 1024, maxBufferedBytes: 50 * 1024 * 1024, tickIntervalMs: 15000 } });
        else if (frame.method === 'sessions.describe') reply({ session: row });
        else if (frame.method === 'sessions.list') reply({ sessions: [row], hasMore: false });
        else if (frame.method === 'chat.history') reply({ sessionKey: target.sessionKey, sessionId: target.sessionId, sessionInfo: row, messages: [{ role: 'assistant', content: 'Latest fixture response', __openclaw: { id: 'm1', runId } }], inFlightRun: { runId }, hasMore: false, totalMessages: 1 });
        else if (frame.method === 'artifacts.list') reply({ artifacts: [artifact()] });
        else if (frame.method === 'artifacts.get') reply({ artifact: artifact() });
        else if (frame.method === 'artifacts.download') {
          downloads++;
          const inline = () => reply({ artifact: artifact(), encoding: 'base64', data: Buffer.from('fixture delivered bytes').toString('base64') });
          if (mode === 'held') { held = inline; continue; }
          if (mode === 'inline') inline();
          else if (mode === 'mismatch') reply({ artifact: { ...artifact(), sessionKey: 'agent:other:private' }, encoding: 'base64', data: 'cHJpdmF0ZQ==' });
          else if (mode === 'external') reply({ artifact: { ...artifact(), download: { mode: 'url' } }, url: 'https://example.com/report' });
          else if (mode === 'escaped-link') reply({ artifact: { ...artifact(), download: { mode: 'url' } }, url: `${origin}/%61pi/artifacts/download/fixture/${ticket}` });
          else reply({ artifact: { ...artifact(), download: { mode: 'url' } }, expiresAt: new Date(Date.now() + (mode === 'expired' && downloads === 1 ? -1000 : 60000)).toISOString(),
            url: mode === 'managed' ? `/api/chat/media/outgoing/${encodeURIComponent(target.sessionKey)}/${attachment}/full?mediaTicket=v1.Zml4dHVyZQ.${ticket}` : `/api/artifacts/download/fixture/${ticket}` });
        } else reply({});
      }
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve)); const address = http.address(); if (!address || typeof address === 'string') throw Error();
  const origin = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(join(tmpdir(), 'pixel-artifact-integration-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: origin.replace('http:', 'ws:'), PIXEL_CONTROL_TOKEN: 'fixture-key', OPENCLAW_GATEWAY_TOKEN: 'fixture-bootstrap' }, dir);
  const gateway = createControlGateway(config); const tasks = createTaskService(gateway, () => new Set(['cylena'])); const artifacts = createArtifactService(gateway, tasks);
  cleanups.push(() => { artifacts.close(); tasks.close(); gateway.close(); }); gateway.start(); await vi.waitFor(() => expect(gateway.status().canRead).toBe(true));
  const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway, tasks, artifacts, config }));
  const file = () => request(app).post('/api/control/agents/cylena/results/file').auth('fixture-key', { type: 'bearer' }).send({ target, scope: { kind: 'run', runId: 'run-1' }, artifactId: 'artifact-1', intent: 'download' });
  return { app, gateway, file, frames, httpPaths, setMode: (value: typeof mode) => { mode = value; }, changeRun: () => { runId = 'run-2'; }, release: () => held?.(), disconnect: () => { for (const socket of sockets) socket.destroy(); } };
}
describe('real private adapter → service → route transfer', () => {
  it.each(['inline', 'http', 'managed', 'expired'] as const)('discovers and transfers %s content using only assistant read filters', async mode => {
    const f = await fixture(); f.setMode(mode);
    const metadata = await request(f.app).post('/api/control/agents/cylena/results').auth('fixture-key', { type: 'bearer' }).send(target);
    expect(metadata.status).toBe(200); expect(metadata.body).toMatchObject({ responseKind: 'latest', artifacts: [{ id: 'artifact-1' }] });
    const file = await f.file(); expect(file.status).toBe(200); expect(file.text).toBe('fixture delivered bytes'); expect(file.headers['x-pixel-control-file']).toBe('bytes');
    for (const frame of f.frames.filter(row => row.method.startsWith('artifacts.'))) expect(frame.params).toMatchObject({ agentId: target.agentId, sessionKey: target.sessionKey, runId: 'run-1', messageRole: 'assistant' });
    expect(f.frames[0].params.scopes).toEqual(['operator.read']); expect(f.frames.some(row => row.method === 'chat.send')).toBe(false);
    expect(f.httpPaths.length).toBe(mode === 'inline' ? 0 : 1);
    if (mode === 'expired') expect(f.frames.filter(row => row.method === 'artifacts.download')).toHaveLength(2);
  });
  it('keeps external references explicit and performs no external HTTP fetch', async () => {
    const f = await fixture(); f.setMode('external'); const result = await f.file(); expect(result.body).toMatchObject({ kind: 'external', host: 'example.com' }); expect(f.httpPaths).toHaveLength(0);
  });
  it('does not expose an encoded native grant as an external browser link when its expiry is missing', async () => {
    const f = await fixture(); f.setMode('escaped-link'); const result = await f.file(); expect(result.status).toBe(503); expect(result.body.code).toBe('invalid-source'); expect(result.headers['x-pixel-control-file']).toBeUndefined();
  });
  it.each(['oversized', 'mismatch'] as const)('rejects %s content without an inline escape or successful byte response', async mode => {
    const f = await fixture(); f.setMode(mode); const result = await f.file(); expect(result.status).toBe(mode === 'oversized' ? 413 : 503);
    expect(result.headers['x-pixel-control-file']).toBeUndefined(); expect(f.frames.filter(row => row.method === 'artifacts.download')).toHaveLength(1);
  });
  it.each(['run', 'disconnect'] as const)('rejects a held transfer after %s changes', async change => {
    const f = await fixture(); f.setMode('held'); const pending = f.file().then(response => response);
    await vi.waitFor(() => expect(f.frames.some(row => row.method === 'artifacts.download')).toBe(true));
    if (change === 'run') { f.changeRun(); f.release(); } else f.disconnect();
    const result = await pending; expect(result.status).not.toBe(200); expect(result.headers['x-pixel-control-file']).toBeUndefined();
  });
});
