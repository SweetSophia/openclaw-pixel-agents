import { createPublicKey, randomUUID, sign } from 'node:crypto';
import { controlRecord, type ControlGatewayState, type ControlStatus } from '../../shared/control';
import type { ControlConfig } from './config';
import { loadOrCreateDeviceIdentity, readDeviceGrantDetails, writeDeviceGrant, type DeviceGrant } from './deviceIdentity';
import { isDeviceStorageError } from './errors';

const READ_METHODS = ['sessions.list', 'sessions.describe', 'chat.history', 'sessions.subscribe'] as const;
const WRITE_METHODS = ['chat.send', 'sessions.create'] as const;
const STOP_METHOD = 'chat.abort' as const;
const STREAM_METHODS = ['sessions.messages.subscribe', 'sessions.messages.unsubscribe'] as const;
const ARTIFACT_METHODS = ['artifacts.list', 'artifacts.get', 'artifacts.download'] as const;
const WORKSPACE_METHODS = ['agents.workspace.list', 'agents.workspace.get'] as const;
const USAGE_METHODS = ['sessions.usage'] as const;
const HISTORY_METHODS = ['audit.activity.list'] as const;
export type ControlMethod = typeof READ_METHODS[number] | typeof WRITE_METHODS[number] | typeof STOP_METHOD | typeof STREAM_METHODS[number] | typeof ARTIFACT_METHODS[number] | typeof WORKSPACE_METHODS[number] | typeof USAGE_METHODS[number] | typeof HISTORY_METHODS[number];
export interface GatewayEvent { event: string; payload: unknown; seq?: number }
export class GatewayRequestError extends Error {
  constructor(public readonly code: 'scope-required' | 'invalid-request' | 'invalid-source' | 'unavailable' | 'session-changed' | 'unsupported' | 'file-unavailable' | 'file-too-large' | 'preview-unsupported' | 'usage-denied' | 'stop-denied') { super('Task source request rejected'); }
}
export interface ControlGateway {
  start(): void; status(): ControlStatus;
  request(method: ControlMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  onEvent(listener: (event: GatewayEvent) => void): () => void; close(): void;
  artifactConnection?(): { id: string; generation: number; gatewayUrl: string } | null;
}
interface Pending { method: ControlMethod; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; cleanup(): void }
const MAX_FRAME = 2 * 1024 * 1024;
function retryHintDelay(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 0;
  // Native hints select a fixed policy delay, never an arbitrary timer duration.
  for (const delay of [0, 500, 1000, 2000, 4000, 8000, 16000, 30000]) if (value <= delay) return delay;
  return 30000;
}
export function gatewayReconnectDelay(attempt: number, random: () => number = Math.random, retryAfterMs?: unknown): number {
  return Math.max(retryHintDelay(retryAfterMs), Math.round(Math.min(30000, 500 * 2 ** Math.min(attempt, 6)) * (0.5 + random() * 0.5)));
}
export function createControlGateway(config: ControlConfig): ControlGateway {
  let state: ControlGatewayState = config.enabled ? 'unavailable' : 'disabled';
  let socket: WebSocket | undefined; let generation = 0; let stopped = false; let retry = 0; let sequence: number | undefined; let writeGranted = false;
  let negotiatedMethods: string[] = [];
  let stopGranted = false; let writeScopeGranted = false;
  let connectionId: string | undefined;
  let memoryGrant: DeviceGrant | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined; let handshake: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, Pending>(); const listeners = new Set<(event: GatewayEvent) => void>();
  const emit = (event: GatewayEvent) => { for (const listener of listeners) listener(event); };
  function rejectPending(message: string): void {
    for (const item of pending.values()) { clearTimeout(item.timer); item.cleanup(); item.reject(Error(message)); }
    pending.clear();
  }
  function fail(next: ControlGatewayState, retryable = false, retryAfterMs?: unknown): void {
    generation++; state = next; writeGranted = false; stopGranted = false; writeScopeGranted = false; negotiatedMethods = []; connectionId = undefined; clearTimeout(handshake); handshake = undefined;
    const old = socket; socket = undefined;
    if (old && old.readyState < 2) old.close();
    rejectPending('Task source connection changed'); emit({ event: 'source.invalidated', payload: null });
    clearTimeout(reconnect); reconnect = undefined;
    if (retryable && !stopped) {
      reconnect = setTimeout(connect, gatewayReconnectDelay(retry++, Math.random, retryAfterMs)); reconnect.unref?.();
    }
  }
  function connect(): void {
    if (stopped || !config.enabled || socket) return;
    clearTimeout(reconnect); reconnect = undefined;
    let identity: ReturnType<typeof loadOrCreateDeviceIdentity>;
    let cached: DeviceGrant | undefined;
    try {
      identity = loadOrCreateDeviceIdentity(config.deviceDirectory);
      cached = memoryGrant?.deviceId === identity.deviceId && memoryGrant.endpoint === config.url ? memoryGrant
        : readDeviceGrantDetails(config.deviceDirectory, config.url!, identity.deviceId);
    } catch (error) { const retryable = isDeviceStorageError(error); fail(retryable ? 'unavailable' : 'auth-error', retryable); return; }
    state = 'connecting'; sequence = undefined;
    const current = ++generation; const ws = new WebSocket(config.url!); socket = ws;
    let connectId: string | undefined;
    const readOnlyFallback = !config.token && !config.password && cached?.scopes.includes('operator.read') && !cached.scopes.includes('operator.write');
    const scopes = config.sendEnabled && !readOnlyFallback ? ['operator.read', 'operator.write'] : ['operator.read'];
    const storedToken = cached && scopes.every(scope => cached.scopes.includes(scope)) ? cached.token : undefined;
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
          if (details?.code === 'PAIRING_REQUIRED') fail('pairing-required');
          else if (error?.code === 'UNAVAILABLE' && error.retryable === true) fail('unavailable', true, error.retryAfterMs);
          else fail('auth-error');
          return;
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
        writeScopeGranted = config.sendEnabled && scopes.includes('operator.write') && grants.includes('operator.write');
        writeGranted = writeScopeGranted && WRITE_METHODS.every(method => methods.includes(method));
        stopGranted = writeScopeGranted && methods.includes(STOP_METHOD);
        negotiatedMethods = methods.filter((method): method is string => typeof method === 'string');
        connectionId = server.connId.length > 0 && server.connId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(server.connId) ? server.connId : undefined;
        if (typeof auth.deviceToken === 'string' && auth.deviceToken.length > 0 && auth.deviceToken.length <= 16384) {
          const actualScopes = ['operator.read', 'operator.write'].filter(scope => grants.includes(scope));
          const retainedScopes = cached?.token === auth.deviceToken ? [...new Set([...cached.scopes, ...actualScopes])] : actualScopes;
          // A rotated token may immediately invalidate the old disk token. Keep it for safe I/O retries.
          memoryGrant = { deviceId: identity.deviceId, endpoint: config.url!, token: auth.deviceToken, scopes: retainedScopes };
          try { writeDeviceGrant(config.deviceDirectory, config.url!, identity.deviceId, memoryGrant.token, memoryGrant.scopes); }
          catch (error) { const retryable = isDeviceStorageError(error); fail(retryable ? 'unavailable' : 'auth-error', retryable); return; }
        }
        clearTimeout(handshake); handshake = undefined; retry = 0; state = 'ready'; emit({ event: 'source.ready', payload: null }); return;
      }
      const item = pending.get(frame.id); if (!item) return;
      pending.delete(frame.id); clearTimeout(item.timer); item.cleanup();
      if (frame.ok) item.resolve(frame.payload);
      else {
        const error = controlRecord(frame.error); const details = controlRecord(error?.details);
        const artifact = (ARTIFACT_METHODS as readonly string[]).includes(item.method);
        if (item.method === STOP_METHOD) {
          item.reject(new GatewayRequestError(error?.code === 'FORBIDDEN' ? 'stop-denied' : error?.code === 'INVALID_REQUEST' ? 'session-changed' : 'unavailable')); return;
        }
        if ((USAGE_METHODS as readonly string[]).includes(item.method)) {
          item.reject(new GatewayRequestError(error?.code === 'FORBIDDEN' ? 'usage-denied' : error?.code === 'INVALID_REQUEST' ? 'unsupported' : 'unavailable')); return;
        }
        if ((WORKSPACE_METHODS as readonly string[]).includes(item.method)) {
          item.reject(new GatewayRequestError(error?.code === 'FORBIDDEN' ? details?.type === 'workspace_path_invalid' ? 'invalid-request' : 'scope-required' : error?.code !== 'INVALID_REQUEST' ? 'unavailable'
            : details?.type === 'workspace_file_too_large' ? 'file-too-large' : details?.type === 'workspace_file_unsupported' ? 'preview-unsupported'
              : ['workspace_path_not_found', 'workspace_file_not_found'].includes(String(details?.type)) ? 'file-unavailable' : 'invalid-request'));
          return;
        }
        item.reject(new GatewayRequestError(error?.code === 'FORBIDDEN' ? 'scope-required' : error?.code === 'INVALID_REQUEST'
          ? !artifact ? 'invalid-source' : details?.type === 'artifact_scope_not_found' ? 'session-changed'
            : details?.type === 'artifact_not_found' || details?.type === 'artifact_download_unsupported' ? 'file-unavailable' : 'unsupported'
          : 'unavailable'));
      }
    });
  }
  return {
    start() { if (stopped || !config.enabled || socket || reconnect) return; connect(); },
    status: () => ({ configured: config.enabled, state, canRead: state === 'ready', canSend: state === 'ready' && writeGranted, canStop: state === 'ready' && stopGranted,
      ...(state === 'ready' && !stopGranted ? { stopDisabledReason: writeScopeGranted ? 'unsupported' as const : 'scope-required' as const } : {}) }),
    artifactConnection: () => state === 'ready' && socket?.readyState === WebSocket.OPEN && connectionId && config.url
      ? { id: connectionId, generation, gatewayUrl: config.url } : null,
    request(method, params, signal) {
      if (state !== 'ready' || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new GatewayRequestError('unavailable'));
      if (method === STOP_METHOD && !writeScopeGranted) return Promise.reject(new GatewayRequestError('scope-required'));
      if (method === STOP_METHOD && !stopGranted) return Promise.reject(new GatewayRequestError('unsupported'));
      const artifact = (ARTIFACT_METHODS as readonly string[]).includes(method);
      const workspace = (WORKSPACE_METHODS as readonly string[]).includes(method);
      const usage = (USAGE_METHODS as readonly string[]).includes(method);
      const history = (HISTORY_METHODS as readonly string[]).includes(method);
      if ((artifact || workspace || history) && !negotiatedMethods.includes(method)) return Promise.reject(new GatewayRequestError('unsupported'));
      // OpenClaw's read-scoped compatibility usage method is deliberately unadvertised.
      // Keep this one allowlisted probe optional and normalize an unsupported contract.
      const allowed = (READ_METHODS as readonly string[]).includes(method)
        || artifact || workspace || usage || history || (method === STOP_METHOD && stopGranted)
        || ((STREAM_METHODS as readonly string[]).includes(method) && negotiatedMethods.includes(method))
        || ((WRITE_METHODS as readonly string[]).includes(method) && writeGranted);
      if (!allowed) return Promise.reject(new GatewayRequestError('scope-required'));
      if (signal?.aborted) return Promise.reject(Error('Task request cancelled'));
      if (pending.size >= 8) return Promise.reject(Error('Too many pending task requests'));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const cancel = () => { const item = pending.get(id); if (!item) return; clearTimeout(item.timer); item.cleanup(); pending.delete(id); reject(Error('Task request cancelled')); };
        const timer = setTimeout(() => { const item = pending.get(id); if (!item) return; item.cleanup(); pending.delete(id); reject(Error('Task request timed out')); }, 5000);
        const cleanup = () => signal?.removeEventListener('abort', cancel);
        pending.set(id, { method, resolve, reject, timer, cleanup }); signal?.addEventListener('abort', cancel, { once: true });
        try { socket!.send(JSON.stringify({ type: 'req', id, method, params })); }
        catch { clearTimeout(timer); cleanup(); pending.delete(id); reject(Error('Task source unavailable')); }
      });
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { stopped = true; memoryGrant = undefined; clearTimeout(reconnect); fail(config.enabled ? 'unavailable' : 'disabled'); listeners.clear(); },
  };
}
