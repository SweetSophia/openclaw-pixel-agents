import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { loadControlConfig } from '../config';
import { loadAgentDocumentConfig } from '../agentDocumentConfig';

export interface DocumentFrame { type: string; id: string; method: string; params: Record<string, unknown> }
export const documentHash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
export function nativeDocument(content = 'original', changes: Record<string, unknown> = {}) {
  return { agentId: 'main', workspace: '/fixture/workspace', file: { name: 'AGENTS.md', path: '/fixture/workspace/AGENTS.md', missing: false, size: Buffer.byteLength(content), updatedAtMs: 123, hash: documentHash(content), content }, ...changes };
}
export function encodeDocumentFrame(value: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10); header[0] = 0x81;
  if (header.length === 2) header[1] = data.length;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  return Buffer.concat([header, data]);
}
export async function documentFixture(options: { version?: string; methods?: string[]; scopes?: string[]; onRequest?: (frame: DocumentFrame, socket: Duplex) => boolean | void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pixel-documents-fixture-'));
  const sockets = new Set<Duplex>(); const frames: DocumentFrame[] = []; const server = createServer();
  let content: string | null = 'original'; let workspace = '/fixture/workspace';
  const currentDocument = () => ({ ...nativeDocument(content ?? '', { workspace }), file: { ...nativeDocument(content ?? '').file, path: `${workspace}/AGENTS.md`, missing: content === null } });
  const respond = (frame: DocumentFrame, socket: Duplex, payload: unknown) => socket.write(encodeDocumentFrame({ type: 'res', id: frame.id, ok: true, payload }));
  server.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(encodeDocumentFrame({ type: 'event', event: 'connect.challenge', payload: { nonce: 'document-nonce', ts: 123 } }));
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15; let length = buffered[1] & 127; let offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
        const masked = Boolean(buffered[1] & 128); const maskSize = masked ? 4 : 0;
        if (buffered.length < offset + maskSize + length) return;
        const mask = buffered.subarray(offset, offset + maskSize); offset += maskSize;
        const data = Buffer.from(buffered.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buffered = buffered.subarray(offset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const frame = JSON.parse(data.toString()) as DocumentFrame; frames.push(frame);
        if (options.onRequest?.(frame, socket) === true) continue;
        if (frame.method === 'connect') respond(frame, socket, { type: 'hello-ok', protocol: 4, server: { version: options.version ?? '2026.11.2', connId: 'document-connection' }, features: { methods: options.methods ?? ['agents.files.get', 'agents.files.set'], events: [] }, snapshot: {}, auth: { role: 'operator', scopes: options.scopes ?? frame.params.scopes, deviceToken: 'document-fixture-grant' }, policy: { maxPayload: 25 * 1024 * 1024, maxBufferedBytes: 50 * 1024 * 1024, tickIntervalMs: 15000 } });
        else if (frame.method === 'agents.files.get') respond(frame, socket, currentDocument());
        else if (frame.params.expectedWorkspace !== workspace || content === null || frame.params.expectedHash !== documentHash(content)) socket.write(encodeDocumentFrame({ type: 'res', id: frame.id, ok: false, error: { code: 'INVALID_REQUEST', details: { type: 'agent_file_conflict' } } }));
        else { content = String(frame.params.content); respond(frame, socket, { ok: true, ...currentDocument() }); }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture address');
  const url = `ws://127.0.0.1:${address.port}/`;
  const control = loadControlConfig({ OPENCLAW_GATEWAY_URL: url, PIXEL_CONTROL_TOKEN: 'document-access-fixture', OPENCLAW_GATEWAY_TOKEN: 'ordinary-fixture' }, directory);
  const config = loadAgentDocumentConfig({ CONTROL_DOCUMENTS_EDIT_ENABLED: 'true', OPENCLAW_DOCUMENTS_GATEWAY_TOKEN: 'document-bootstrap-fixture' }, directory, control);
  return { directory, url, frames, sockets, control, config, respond,
    setDocument(next: string | null, nextWorkspace = workspace) { content = next; workspace = nextWorkspace; },
    event(event: string) { for (const socket of sockets) socket.write(encodeDocumentFrame({ type: 'event', event, payload: {} })); },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); },
  };
}
