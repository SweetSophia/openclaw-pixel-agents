import { controlRecord } from '../../shared/control';
import { CONTROL_RESULT_LIMITS, parseControlExternalFile, type ControlExternalFile, type ControlFileRequest } from '../../shared/controlResults';
import { artifactQuery, nativeArtifactSummary } from './artifactProtocol';
import { ControlError } from './errors';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';
import { artifactMime, previewContent, safeArtifactFilename } from './previewPolicy';

export type ArtifactContent = { kind: 'bytes'; data: Uint8Array; mimeType: string; filename: string; truncated: boolean } | ControlExternalFile;
type Connection = NonNullable<ReturnType<NonNullable<ControlGateway['artifactConnection']>>>;
interface Grant { url: URL; expiresAt: number }
function invalid(): never { throw new ControlError('invalid-source'); }

function grantOrLink(raw: unknown, expires: unknown, connection: Connection, input: ControlFileRequest, title: string): Grant | ControlExternalFile {
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || raw.trim() !== raw || /[\\\u0000-\u001f\u007f-\u009f]/.test(raw)) invalid();
  const configured = new URL(connection.gatewayUrl);
  if (!['ws:', 'wss:'].includes(configured.protocol) || configured.username || configured.password || configured.search || configured.hash) invalid();
  configured.protocol = configured.protocol === 'wss:' ? 'https:' : 'http:';
  const absolute = /^https?:\/\//i.test(raw);
  let url: URL; try { url = new URL(raw, configured.origin); } catch { return invalid(); }
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) invalid();
  if (expires === undefined && absolute) {
    let decodedPath: string; try { decodedPath = decodeURIComponent(url.pathname); } catch { return invalid(); }
    if (decodedPath.startsWith('/api/artifacts/download/') || decodedPath.startsWith('/api/chat/media/outgoing/') || url.searchParams.has('mediaTicket')) invalid();
    const external = parseControlExternalFile({ kind: 'external', url: raw, host: url.host, title });
    return external ?? invalid();
  }
  if (url.hash || url.origin !== configured.origin || typeof expires !== 'string' || expires.length > 128 || !Number.isFinite(Date.parse(expires))) invalid();
  const match = absolute ? /^https?:\/\/[^/?#]+(\/[^?#]*)?(?:\?[^#]*)?$/i.exec(raw) : null;
  const rawPath = absolute ? match?.[1] : raw.split('?')[0];
  if (!rawPath || !rawPath.startsWith('/') || rawPath !== url.pathname || rawPath.includes('\\')) invalid();
  const inline = /^\/api\/artifacts\/download\/([^/]+)\/([A-Za-z0-9_-]{43})$/.exec(rawPath);
  if (inline) {
    if (inline[1] !== encodeURIComponent(connection.id) || url.searchParams.size > 1
      || (url.search && (url.searchParams.get('variant') !== 'thumbnail' || url.searchParams.toString() !== 'variant=thumbnail'))) invalid();
    return { url, expiresAt: Date.parse(expires) };
  }
  const managed = /^\/api\/chat\/media\/outgoing\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(full|thumbnail)$/i.exec(rawPath);
  const mediaTicket = url.searchParams.get('mediaTicket');
  if (!managed || managed[1] !== encodeURIComponent(input.target.sessionKey) || url.searchParams.size !== 1 || !mediaTicket
    || mediaTicket.length > 2048 || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(mediaTicket)
    || url.search.slice(1) !== url.searchParams.toString()) invalid();
  const selectedId = /^artifact_managed_(?:image|media)_([0-9a-f-]+)$/i.exec(input.artifactId)?.[1];
  if (selectedId && selectedId.toLowerCase() !== managed[2].toLowerCase()) invalid();
  return { url, expiresAt: Date.parse(expires) };
}
async function boundedBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get('Content-Length');
  if (length && /^\d+$/.test(length) && Number(length) > CONTROL_RESULT_LIMITS.transferBytes) {
    void response.body?.cancel().catch(() => {}); throw new ControlError('file-too-large');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let lengthRead = 0;
  try {
    while (true) {
      if (signal.aborted) throw new ControlError('unavailable');
      const { value, done } = await reader.read(); if (done) break;
      if (!(value instanceof Uint8Array)) invalid(); lengthRead += value.byteLength;
      if (lengthRead > CONTROL_RESULT_LIMITS.transferBytes) throw new ControlError('file-too-large'); chunks.push(value);
    }
    const data = new Uint8Array(lengthRead); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; } return data;
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
export async function downloadArtifact(gateway: ControlGateway, input: ControlFileRequest, signal: AbortSignal): Promise<ArtifactContent> {
  const connection = gateway.artifactConnection?.(); if (!connection) throw new ControlError('file-unavailable');
  const controller = new AbortController(); const combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), CONTROL_RESULT_LIMITS.contentDeadlineMs); timer.unref?.();
  const unsubscribe = gateway.onEvent(event => { if (event.event === 'source.invalidated' || event.event === 'source.ready') controller.abort(); });
  function current(): void {
    const now = gateway.artifactConnection?.();
    if (!now || now.id !== connection!.id || now.generation !== connection!.generation || now.gatewayUrl !== connection!.gatewayUrl) throw new ControlError('session-changed');
    if (combined.aborted) throw new ControlError('unavailable');
  }
  const query = { ...artifactQuery(input.target, input.scope), artifactId: input.artifactId };
  async function rpc(http: boolean): Promise<unknown> {
    current();
    try { const result = await gateway.request('artifacts.download', { ...query, ...(http ? { transport: 'http' } : {}) }, combined); current(); return result; }
    catch (error) {
      current(); if (error instanceof ControlError) throw error;
      if (error instanceof GatewayRequestError) throw new ControlError(error.code); throw new ControlError('file-unavailable');
    }
  }
  let inlineFallback = false;
  async function fallback(): Promise<ArtifactContent> {
    if (inlineFallback) throw new ControlError('file-unavailable'); inlineFallback = true;
    return resolve(await rpc(false), false, false);
  }
  function content(data: Uint8Array, mime: string, title: string): ArtifactContent {
    current();
    if (data.byteLength > CONTROL_RESULT_LIMITS.transferBytes) throw new ControlError('file-too-large');
    const checked = input.intent === 'preview' ? previewContent(data, mime) : { data, mimeType: artifactMime(mime), truncated: false };
    return { kind: 'bytes', ...checked, filename: safeArtifactFilename(title) };
  }
  async function resolve(value: unknown, http: boolean, refresh: boolean): Promise<ArtifactContent> {
    current(); const row = controlRecord(value); if (!row) invalid();
    const summary = nativeArtifactSummary(row.artifact, input.target, input.scope); if (summary.id !== input.artifactId) invalid();
    if (row.encoding === 'base64') {
      if (row.url !== undefined || summary.download !== 'bytes' || typeof row.data !== 'string') invalid();
      if (row.data.length > Math.ceil(CONTROL_RESULT_LIMITS.transferBytes / 3) * 4) throw new ControlError('file-too-large');
      if (row.data.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.data)) invalid();
      return content(Buffer.from(row.data, 'base64'), summary.mimeType ?? 'application/octet-stream', summary.title);
    }
    if (row.encoding !== undefined || row.data !== undefined || summary.download !== 'link') invalid();
    const resolved = grantOrLink(row.url, row.expiresAt, connection!, input, summary.title);
    if ('kind' in resolved) return resolved;
    if (!http) throw new ControlError('file-unavailable');
    if (resolved.expiresAt <= Date.now()) return refresh ? resolve(await rpc(true), true, false) : fallback();
    if (input.intent === 'preview' && summary.type === 'image' && resolved.url.pathname.startsWith('/api/artifacts/download/')) resolved.url.searchParams.set('variant', 'thumbnail');
    let response: Response;
    try {
      response = await fetch(resolved.url, { redirect: 'error', credentials: 'omit', cache: 'no-store', signal: combined }); current();
      if (response.status === 410 && refresh) { void response.body?.cancel().catch(() => {}); return resolve(await rpc(true), true, false); }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return fallback(); }
      const data = await boundedBytes(response, combined); current();
      return content(data, response.headers.get('Content-Type') ?? summary.mimeType ?? 'application/octet-stream', summary.title);
    } catch (error) {
      current(); if (error instanceof ControlError) throw error; return fallback();
    }
  }
  try {
    current(); let value: unknown;
    try { value = await gateway.request('artifacts.get', query, combined); }
    catch (error) { current(); if (error instanceof GatewayRequestError) throw new ControlError(error.code); throw new ControlError('file-unavailable'); }
    current(); const summary = nativeArtifactSummary(controlRecord(value)?.artifact, input.target, input.scope);
    if (summary.id !== input.artifactId) invalid(); if (summary.download === 'unavailable') throw new ControlError('file-unavailable');
    try { value = await rpc(true); }
    catch (error) { if (error instanceof ControlError && ['unsupported', 'file-unavailable'].includes(error.code)) return await fallback(); throw error; }
    return await resolve(value, true, true);
  } finally { clearTimeout(timer); unsubscribe(); }
}
