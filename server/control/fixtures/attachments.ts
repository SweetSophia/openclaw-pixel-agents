import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ControlTarget } from '../../../shared/control';
import type { AttachmentImage } from '../../../shared/controlAttachments';
import type { ControlGateway, GatewayEvent } from '../gatewayClient';
import { serializeImageFollowupFrame, type AttachmentGatewayCapabilities, type NativeImageRequestFrame } from '../gatewayAttachmentPolicy';

// Synthetic fixtures matching the qualified 2026.11.2 persisted user-turn shapes.
export const attachmentTarget: ControlTarget = { agentId: 'main', sessionKey: 'agent:main:fixture', sessionId: 's1',
  lifecycleRevision: 'life-1', branchId: 'branch-1', activeLeafEntryId: 'leaf-1' };
export const attachmentMessage = 'Describe this picture';
export const attachmentInput = { filename: 'picture.png', mimeType: 'image/png' as const,
  contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6w1sAAAAASUVORK5CYII=' };
export const attachmentImage: AttachmentImage = { filename: 'picture.png', mimeType: 'image/png', bytes: 68, width: 1, height: 1,
  sha256: createHash('sha256').update(Buffer.from(attachmentInput.contentBase64, 'base64')).digest('hex') };
export const attachmentTextDigest = createHash('sha256').update(attachmentMessage).digest('hex');
export const durableOmission = '[image attachment omitted: durable managed media claim unavailable]';
export const limitOmission = '[image attachment omitted: text-only attachment limit reached]';
export function nativeImageMessage(runId = 'operation-1', kind: 'inline' | 'offloaded' = 'inline') {
  return { role: 'user', content: attachmentMessage, timestamp: 123,
    __openclaw: { id: 'user-1', seq: 7, runId, media: [{ url: 'media://inbound/fixture.png', contentType: 'image/png',
      kind: 'image', fileName: 'picture.png', sizeBytes: 68, width: 1, height: 1,
      ...(kind === 'offloaded' ? { origin: 'file' } : {}) }], mediaImageLayout: { slots: [{ kind, factIndex: 0 }] } } };
}

export function attachmentGatewayFixture() {
  const listeners = new Set<(event: GatewayEvent) => void>();
  const state = {
    enabled: true, registered: new Set(['main']), canRead: true, canSend: true, sourceKey: 'source-1',
    caps: { epoch: 'epoch-1', sourceKey: 'source-1', maxBytes: 4_194_304, maxImageBytes: 4_194_304,
      maxPayload: 6_291_456, maxBufferedBytes: 6_291_456 } as AttachmentGatewayCapabilities | null,
    session: { ...attachmentTarget, key: attachmentTarget.sessionKey } as Record<string, unknown>,
    history: { messages: [] as unknown[], inputReceipts: [] as unknown[] },
    historyOverride: undefined as Record<string, unknown> | undefined,
    consumedMessages: [] as unknown[],
    afterRequest: undefined as ((method: string, params: Record<string, unknown>) => void | Promise<void>) | undefined,
    nativeResult: (async (id: string): Promise<unknown> => ({ runId: id })) as (id: string) => Promise<unknown>,
  };
  const requests: { method: string; params: Record<string, unknown> }[] = [], nativeSends: NativeImageRequestFrame[] = [];
  const gateway: ControlGateway = {
    start() {}, close() {}, status: () => ({ configured: true, state: 'ready', canRead: state.canRead, canSend: state.canSend }),
    readSourceKey: () => state.canRead ? state.sourceKey : null,
    attachmentCapabilities: () => state.caps && { ...state.caps },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async request(method, params, signal) {
      if (signal?.aborted) throw Error('Cancelled synthetic read');
      requests.push({ method, params: structuredClone(params) });
      const result = method === 'sessions.describe' ? { session: state.session }
        : method === 'chat.history' ? { sessionKey: attachmentTarget.sessionKey, sessionId: 's1',
          sessionInfo: { ...state.session, activeLeafEntryId: state.session.activeLeafEntryId }, ...state.history,
          ...(params.messageId ? { messages: state.consumedMessages } : {}), ...state.historyOverride } : {};
      const snapshot = structuredClone(result);
      await state.afterRequest?.(method, params);
      if (signal?.aborted) throw Error('Cancelled synthetic read');
      return snapshot;
    },
    async sendImageFollowup(params, epoch, markNativeInvocation) {
      if (epoch !== state.caps?.epoch) throw Error('Wrong synthetic source epoch');
      const wire = serializeImageFollowupFrame({ type: 'req', id: 'native-request-1', method: 'chat.send', params }, state.caps, 0);
      markNativeInvocation?.();
      nativeSends.push(JSON.parse(wire) as NativeImageRequestFrame);
      return state.nativeResult(params.idempotencyKey);
    },
  };
  return { state, gateway, requests, nativeSends, emit: (event: GatewayEvent) => { listeners.forEach(listener => listener(event)); } };
}

type HostFrame = { type: 'req'; id: string; method: string; params: Record<string, any> };
export interface AttachmentHostOptions {
  reply?: 'hold' | 'accepted' | 'recorded' | 'uploads-disabled';
  version?: string;
  policy?: Record<string, unknown>;
  grants?: string[];
  session?: Partial<ControlTarget>;
  history?: { messages: unknown[]; inputReceipts: unknown[] };
  beforeConnect?: () => void;
  beforeRead?: (frame: HostFrame) => void | Promise<void>;
}

// Disposable signed protocol peer, never a production route or live Gateway adapter.
// Options remain mutable so browser qualification can change native policy/replies.
export async function attachmentHost(options: AttachmentHostOptions = {}) {
  const frames: HostFrame[] = [], admissions: HostFrame[] = [], sockets = new Set<Duplex>();
  const pending: Array<{ frame: HostFrame; socket: Duplex }> = [];
  const waiters = new Set<() => void>(); let closed = false;
  function encode(value: unknown) {
    const data = Buffer.from(JSON.stringify(value));
    assert(data.length <= 262144, 'Synthetic host result exceeds the normal private result limit');
    const header = Buffer.alloc(data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10); header[0] = 0x81;
    if (header.length === 2) header[1] = data.length;
    else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(data.length, 2); }
    else { header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
    return Buffer.concat([header, data]);
  }
  const session = () => ({ ...attachmentTarget, ...options.session, key: attachmentTarget.sessionKey, displayName: 'Synthetic image conversation',
    hasActiveRun: false, activeRunIds: [], status: 'idle', updatedAt: 123, snapshotAt: 123 });
  function reply(frame: HostFrame, socket: Duplex) {
    if (socket.destroyed) return;
    socket.write(encode(options.reply === 'uploads-disabled'
      ? { type: 'res', id: frame.id, ok: false, error: { code: 'FORBIDDEN', details: { code: 'UPLOADS_DISABLED' } } }
      : { type: 'res', id: frame.id, ok: true, payload: { runId: frame.params.idempotencyKey,
        ...(options.reply === 'recorded' ? { messageId: 'synthetic-image-turn', messageSeq: 7 } : {}) } }));
  }
  async function receive(frame: HostFrame, socket: Duplex) {
    frames.push(frame); let payload: unknown;
    if (frame.method === 'connect') {
      const p = frame.params;
      assert.deepEqual(p.scopes, ['operator.read', 'operator.write']);
      assert.equal(p.minProtocol, 4); assert.equal(p.maxProtocol, 4);
      assert.equal(p.role, 'operator'); assert.equal(p.client.id, 'cli'); assert.equal(p.client.mode, 'backend');
      assert.equal(p.auth.token, 'synthetic-attachment-bootstrap');
      const raw = Buffer.from(p.device.publicKey, 'base64url');
      assert.equal(p.device.id, createHash('sha256').update(raw).digest('hex'));
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), type: 'spki', format: 'der' });
      const signed = ['v3', p.device.id, 'cli', 'backend', 'operator', p.scopes.join(','), '123',
        p.auth.token, 'attachment-nonce', process.platform, ''].join('|');
      assert.equal(verify(null, Buffer.from(signed), key, Buffer.from(p.device.signature, 'base64url')), true);
      options.beforeConnect?.();
      payload = { type: 'hello-ok', protocol: 4, server: { version: options.version ?? '2026.11.2', connId: randomUUID() },
        features: { methods: ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe', 'chat.send', 'sessions.create'], events: [] }, snapshot: {},
        auth: { role: 'operator', scopes: options.grants ?? ['operator.read', 'operator.write'], deviceToken: 'synthetic-attachment-grant' },
        policy: options.policy ?? { maxPayload: 6291456, maxBufferedBytes: 6291456, tickIntervalMs: 15000,
          attachments: { maxBytes: 4194304, maxImageBytes: 4194304 } } };
    } else if (frame.method === 'chat.send') {
      admissions.push(frame); pending.push({ frame, socket }); for (const wake of waiters) wake();
      if (options.reply !== 'hold') reply(frame, socket);
      return;
    } else {
      await options.beforeRead?.(frame);
      if (frame.method === 'sessions.describe') {
        assert.deepEqual(frame.params, { key: 'agent:main:fixture', agentId: 'main' }); payload = { session: session() };
      } else if (frame.method === 'sessions.list') payload = { sessions: frame.params.spawnedBy ? [] : [session()], hasMore: false };
      else if (frame.method === 'chat.history') {
        assert.equal(frame.params.agentId, 'main'); assert.equal(frame.params.sessionKey, 'agent:main:fixture');
        assert(Number.isSafeInteger(frame.params.limit) && frame.params.limit > 0 && frame.params.limit <= 50);
        // Ordinary run history reserves envelope headroom below the same hard result cap.
        assert(Number.isSafeInteger(frame.params.maxBytes) && frame.params.maxBytes > 0 && frame.params.maxBytes <= 262144);
        payload = { sessionKey: 'agent:main:fixture', sessionId: 's1', sessionInfo: session(), messages: [],
          inputReceipts: [], totalMessages: 0, hasMore: false, ...options.history };
      } else { assert.equal(frame.method, 'sessions.subscribe'); payload = {}; }
    }
    if (!socket.destroyed) socket.write(encode({ type: 'res', id: frame.id, ok: true, payload }));
  }
  const server = createServer(); server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(encode({ type: 'event', event: 'connect.challenge', payload: { nonce: 'attachment-nonce', ts: 123 } }));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15; let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; const size = buffer.readBigUInt64BE(2);
          if (size > 6291456n) { socket.destroy(); return; } length = Number(size); offset = 10; }
        if (!(buffer[1] & 128) || length > 6291456) { socket.destroy(); return; }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4); offset += 4;
        const data = Buffer.from(buffer.subarray(offset, offset + length));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        try { void receive(JSON.parse(data.toString()) as HostFrame, socket).catch(() => socket.destroy()); }
        catch { socket.destroy(); }
      }
    });
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const address = server.address(); assert(address && typeof address !== 'string');
  return { url: `ws://127.0.0.1:${address.port}/`, frames,
    sendCount: () => frames.filter(frame => frame.method === 'chat.send').length,
    async waitForAdmission(count = 1): Promise<HostFrame> {
      if (admissions.length >= count) return admissions[count - 1];
      return new Promise((accept, reject) => {
        const timer = setTimeout(() => { waiters.delete(wake); reject(Error('No synthetic native admission')); }, 10000);
        function wake() { if (admissions.length < count && !closed) return; clearTimeout(timer); waiters.delete(wake);
          if (closed) reject(Error('Synthetic host closed')); else accept(admissions[count - 1]); }
        waiters.add(wake);
      });
    },
    releaseReply() { for (const entry of pending.splice(0)) reply(entry.frame, entry.socket); },
    emit(event: string) { for (const socket of sockets) if (!socket.destroyed) socket.write(encode({ type: 'event', event, payload: null })); },
    disconnect() { for (const socket of sockets) socket.destroy(); },
    async close() { if (closed) return; closed = true; for (const wake of waiters) wake();
      for (const socket of sockets) socket.destroy(); await new Promise<void>(accept => server.close(() => accept())); },
  };
}
