import { createPublicKey, randomUUID, sign } from 'node:crypto';
import { controlRecord, type ControlGatewayState, type ControlStatus } from '../../shared/control';
import type { ControlConfig } from './config';
import { loadOrCreateDeviceIdentity, readDeviceGrant, writeDeviceGrant } from './deviceIdentity';

const READ_METHODS = ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe'] as const;
const WRITE_METHODS = ['chat.send', 'sessions.create'] as const;
const STREAM_METHODS = ['sessions.messages.subscribe', 'sessions.messages.unsubscribe'] as const;
export type ControlMethod = typeof READ_METHODS[number] | typeof WRITE_METHODS[number] | typeof STREAM_METHODS[number];
export interface GatewayEvent { event: string; payload: unknown; seq?: number }
export class GatewayRequestError extends Error {
  constructor(public readonly code: 'scope-required' | 'invalid-source' | 'unavailable' | 'session-changed') { super('Task source request rejected'); }
}
export interface ControlGateway {
  start(): void; status(): ControlStatus;
  request(method: ControlMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  onEvent(listener: (event: GatewayEvent) => void): () => void; close(): void;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; cleanup(): void }
const MAX_FRAME = 2 * 1024 * 1024;
export function gatewayReconnectDelay(attempt: number, random: () => number = Math.random): number {
  return Math.round(Math.min(30000, 500 * 2 ** Math.min(attempt, 6)) * (0.5 + random() * 0.5));
}
export function createControlGateway(config: ControlConfig): ControlGateway {
  let state: ControlGatewayState = config.enabled ? 'unavailable' : 'disabled';
  let socket: WebSocket | undefined; let generation = 0; let stopped = false; let retry = 0; let sequence: number | undefined; let writeGranted = false;
  let negotiatedMethods: string[] = [];
  let reconnect: ReturnType<typeof setTimeout> | undefined; let handshake: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, Pending>(); const listeners = new Set<(event: GatewayEvent) => void>();
  const emit = (event: GatewayEvent) => { for (const listener of listeners) listener(event); };
  function rejectPending(message: string): void {
    for (const item of pending.values()) { clearTimeout(item.timer); item.cleanup(); item.reject(Error(message)); }
    pending.clear();
  }
  function fail(next: ControlGatewayState, retryable = false): void {
    generation++; state = next; writeGranted = false; negotiatedMethods = []; clearTimeout(handshake); handshake = undefined;
    const old = socket; socket = undefined;
    if (old && old.readyState < 2) old.close();
    rejectPending('Task source connection changed'); emit({ event: 'source.invalidated', payload: null });
    clearTimeout(reconnect); reconnect = undefined;
    if (retryable && !stopped) {
      reconnect = setTimeout(connect, gatewayReconnectDelay(retry++)); reconnect.unref?.();
    }
  }
  function connect(): void {
    if (stopped || !config.enabled || socket) return;
    clearTimeout(reconnect); reconnect = undefined;
    let identity: ReturnType<typeof loadOrCreateDeviceIdentity>;
    try { identity = loadOrCreateDeviceIdentity(config.deviceDirectory); } catch { fail('auth-error'); return; }
    state = 'connecting'; sequence = undefined;
    const current = ++generation; const ws = new WebSocket(config.url!); socket = ws;
    let connectId: string | undefined;
    const scopes = config.sendEnabled ? ['operator.read', 'operator.write'] : ['operator.read'];
    const storedToken = readDeviceGrant(config.deviceDirectory, config.url!, identity.deviceId, scopes);
    const signatureToken = config.token || (!config.password ? storedToken : undefined);
    handshake = setTimeout(() => { if (generation === current) fail('unavailable', true); }, 5000); handshake.unref?.();
    ws.addEventListener('error', () => { if (generation === current) fail('unavailable', true); });
    ws.addEventListener('close', () => { if (generation === current) fail('unavailable', true); });
    ws.addEventListener('message', event => {
      if (generation !== current || stopped) return;
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_FRAME) { fail('unsupported'); return; }
      let frame: Record<string, unknown> | null;
      try { frame = controlRecord(JSON.parse(event.data)); } catch { fail('unsupported'); return; }
      if (!frame) { fail('unsupported'); return; }
      if (frame.type === 'event') {
        if (typeof frame.event !== 'string' || frame.event.length > 128) { fail('unsupported'); return; }
        if (frame.event === 'connect.challenge') {
          const challenge = controlRecord(frame.payload);
          if (connectId || state !== 'connecting' || !challenge || typeof challenge.nonce !== 'string'
            || !challenge.nonce || challenge.nonce.length > 1024 || !Number.isSafeInteger(challenge.ts) || (challenge.ts as number) < 0) { fail('unsupported'); return; }
          const platform = process.platform.trim().toLowerCase();
          const payload = ['v3', identity.deviceId, 'cli', 'backend', 'operator', scopes.join(','), String(challenge.ts), signatureToken ?? '', challenge.nonce, platform, ''].join('|');
          connectId = randomUUID();
          ws.send(JSON.stringify({ type: 'req', id: connectId, method: 'connect', params: {
            minProtocol: 4, maxProtocol: 4, client: { id: 'cli', displayName: 'Pixel Agents task details', mode: 'backend', version: '1', platform },
            role: 'operator', scopes, caps: [],
            auth: { token: config.token || undefined, password: config.password || undefined, deviceToken: !config.token && !config.password ? storedToken : undefined },
            device: { id: identity.deviceId, publicKey: createPublicKey(identity.publicKeyPem).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
              signature: sign(null, Buffer.from(payload), identity.privateKeyPem).toString('base64url'), signedAt: challenge.ts, nonce: challenge.nonce },
          } })); return;
        }
        if (state !== 'ready') { fail('unsupported'); return; }
        if (frame.seq !== undefined) {
          if (!Number.isSafeInteger(frame.seq) || (frame.seq as number) < 0 || (sequence !== undefined && frame.seq !== sequence + 1)) { fail('unavailable', true); return; }
          sequence = frame.seq as number;
        }
        emit({ event: frame.event, payload: frame.payload, ...(sequence === undefined ? {} : { seq: sequence }) }); return;
      }
      if (frame.type !== 'res' || typeof frame.id !== 'string' || typeof frame.ok !== 'boolean') { fail('unsupported'); return; }
      if (frame.id === connectId && state === 'connecting') {
        if (!frame.ok) {
          const error = controlRecord(frame.error); const details = controlRecord(error?.details);
          fail(details?.code === 'PAIRING_REQUIRED' ? 'pairing-required' : 'auth-error'); return;
        }
        const hello = controlRecord(frame.payload); const auth = controlRecord(hello?.auth);
        const features = controlRecord(hello?.features); const policy = controlRecord(hello?.policy); const server = controlRecord(hello?.server);
        const methods = features?.methods; const grants = auth?.scopes;
        if (!hello || hello.type !== 'hello-ok' || hello.protocol !== 4 || !server || typeof server.version !== 'string'
          || typeof server.connId !== 'string' || !controlRecord(hello.snapshot) || !policy || typeof policy.tickIntervalMs !== 'number'
          || policy.tickIntervalMs <= 0 || typeof policy.maxPayload !== 'number' || typeof policy.maxBufferedBytes !== 'number'
          || !features || !Array.isArray(methods) || !READ_METHODS.every(method => methods.includes(method))
          || !Array.isArray(features.events)) { fail('unsupported'); return; }
        if (!auth || auth.role !== 'operator' || !Array.isArray(grants) || !grants.includes('operator.read')) { fail('auth-error'); return; }
        writeGranted = config.sendEnabled && grants.includes('operator.write') && WRITE_METHODS.every(method => methods.includes(method));
        negotiatedMethods = methods.filter((method): method is string => typeof method === 'string');
        if (typeof auth.deviceToken === 'string' && auth.deviceToken.length > 0 && auth.deviceToken.length <= 16384) {
          try { writeDeviceGrant(config.deviceDirectory, config.url!, identity.deviceId, auth.deviceToken, scopes.filter(scope => grants.includes(scope))); } catch { fail('auth-error'); return; }
        }
        clearTimeout(handshake); handshake = undefined; retry = 0; state = 'ready'; emit({ event: 'source.ready', payload: null }); return;
      }
      const item = pending.get(frame.id); if (!item) return;
      pending.delete(frame.id); clearTimeout(item.timer); item.cleanup();
      if (frame.ok) item.resolve(frame.payload);
      else {
        const error = controlRecord(frame.error);
        item.reject(new GatewayRequestError(error?.code === 'FORBIDDEN' ? 'scope-required' : error?.code === 'INVALID_REQUEST' ? 'invalid-source' : 'unavailable'));
      }
    });
  }
  return {
    start() { if (stopped || !config.enabled || socket || reconnect) return; connect(); },
    status: () => ({ configured: config.enabled, state, canRead: state === 'ready', canSend: state === 'ready' && writeGranted }),
    request(method, params, signal) {
      const allowed = (READ_METHODS as readonly string[]).includes(method)
        || ((STREAM_METHODS as readonly string[]).includes(method) && negotiatedMethods.includes(method))
        || ((WRITE_METHODS as readonly string[]).includes(method) && writeGranted);
      if (!allowed) return Promise.reject(new GatewayRequestError('scope-required'));
      if (state !== 'ready' || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(Error('Task source unavailable'));
      if (signal?.aborted) return Promise.reject(Error('Task request cancelled'));
      if (pending.size >= 8) return Promise.reject(Error('Too many pending task requests'));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const cancel = () => { const item = pending.get(id); if (!item) return; clearTimeout(item.timer); item.cleanup(); pending.delete(id); reject(Error('Task request cancelled')); };
        const timer = setTimeout(() => { const item = pending.get(id); if (!item) return; item.cleanup(); pending.delete(id); reject(Error('Task request timed out')); }, 5000);
        const cleanup = () => signal?.removeEventListener('abort', cancel);
        pending.set(id, { resolve, reject, timer, cleanup }); signal?.addEventListener('abort', cancel, { once: true });
        try { socket!.send(JSON.stringify({ type: 'req', id, method, params })); }
        catch { clearTimeout(timer); cleanup(); pending.delete(id); reject(Error('Task source unavailable')); }
      });
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { stopped = true; clearTimeout(reconnect); fail(config.enabled ? 'unavailable' : 'disabled'); listeners.clear(); },
  };
}
