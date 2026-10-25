import { CONTROL_LIMITS, controlRecord, type ControlErrorCode, type ControlTarget } from '../../shared/control';
import { CONTROL_RESULT_LIMITS, parseControlExternalFile, type ControlExternalFile } from '../../shared/controlResults';

const messages: Partial<Record<ControlErrorCode, string>> = {
  disabled: 'Task access is not connected. Ask the office operator to configure the Gateway connection.',
  locked: 'Unlock task details to continue.', 'transport-required': 'Task access requires HTTPS or the configured private Tailnet connection.',
  'pairing-required': 'The office task device needs approval in OpenClaw.', 'scope-required': 'OpenClaw has not granted the required task access.',
  unsupported: 'This Gateway does not support the required task controls.', 'session-changed': 'This conversation changed. Select it again.',
  'invalid-target': 'This conversation is no longer available. Select another conversation.',
  'invalid-request': 'This history window changed or expired. Refresh to load current records.',
  'rate-limited': 'Too many requests. Wait a moment before retrying.',
  'outcome-unknown': 'The submission outcome is unknown. Keep your draft and use Retry original submission; do not create a replacement submission.',
  'command-not-supported': 'This composer accepts messages, not slash commands, shell commands or stop phrases. Your draft is kept.',
  'file-unavailable': 'This shared file is no longer available. Refresh the file list.',
  'file-too-large': 'This file exceeds the supported transfer or preview size.',
  'preview-unsupported': 'This file cannot be previewed safely. Download it instead.',
  'workspace-changed': 'This workspace selection changed. Refresh the directory.',
  'timed-out': 'The request timed out. Try again.',
};
// Browser-only error copy must not expand the server's rejection vocabulary.
const serverCodes: ReadonlySet<string> = new Set<ControlErrorCode>([
  'disabled', 'locked', 'transport-required', 'pairing-required', 'scope-required', 'unsupported',
  'session-changed', 'invalid-target', 'invalid-request', 'rate-limited', 'outcome-unknown',
  'command-not-supported', 'file-unavailable', 'file-too-large', 'preview-unsupported',
  'workspace-changed', 'unavailable', 'invalid-source',
]);
export class ControlApiError extends Error {
  constructor(public readonly code: ControlErrorCode = 'unavailable') { super(messages[code] ?? 'Task details are temporarily unavailable.'); }
}
export function targetIdentity(target: ControlTarget): string {
  return JSON.stringify([target.agentId, target.sessionKey, target.sessionId, target.lifecycleRevision ?? null, target.branchId ?? null]);
}
async function privateFetch(path: string, key?: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, window.location.origin);
  if (!path.startsWith('/api/control/') || !url.pathname.startsWith('/api/control/') || url.origin !== window.location.origin
    || url.hash || path.includes('\\')) throw new ControlApiError('invalid-request');
  const headers = new Headers(init.headers); headers.delete('Authorization');
  if (key) headers.set('Authorization', `Bearer ${key}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  try { return await fetch(path, { ...init, headers, redirect: 'error', cache: 'no-store', credentials: 'same-origin' }); }
  catch { throw new ControlApiError('unavailable'); }
}
async function readBytes(response: Response, limit: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new ControlApiError('file-too-large');
  if (Number(response.headers.get('Content-Length')) > limit) { void response.body?.cancel(); throw tooLarge(); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new ControlApiError('unavailable');
      const next = await reader.read();
      if (signal?.aborted) throw new ControlApiError('unavailable');
      if (next.done) break;
      size += next.value.byteLength; if (size > limit) throw tooLarge(); chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } catch (error) { cancel(); throw error instanceof ControlApiError ? error : new ControlApiError('invalid-source'); }
  finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}
async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(response, CONTROL_LIMITS.responseBytes, signal))); }
  catch { throw new ControlApiError('invalid-source'); }
  if (!response.ok) {
    const code = controlRecord(value)?.code;
    throw new ControlApiError(typeof code === 'string' && serverCodes.has(code) ? code as ControlErrorCode : 'unavailable');
  }
  return value;
}
export async function controlFetch(path: string, key?: string, init: RequestInit = {}): Promise<unknown> {
  return readJson(await privateFetch(path, key, init), init.signal ?? undefined);
}
export type ControlFileResponse = { kind: 'bytes'; blob: Blob; filename: string; truncated: boolean } | ControlExternalFile;
function responseFilename(response: Response): string {
  const disposition = response.headers.get('Content-Disposition') ?? '';
  if (!/^attachment(?:;|$)/i.test(disposition)) throw new ControlApiError('invalid-source');
  const encoded = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i.exec(disposition);
  let name: string;
  try { name = encoded ? decodeURIComponent(encoded[1]) : /(?:^|;)\s*filename=(?:"([^"]*)"|([^;]*))/i.exec(disposition)?.slice(1).find(value => value !== undefined)?.trim() ?? ''; }
  catch { throw new ControlApiError('invalid-source'); }
  if (!name || name.length > 128 || /[\x00-\x1f\x7f-\x9f/\\:*?"<>|]/.test(name) || /^[. ]|[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new ControlApiError('invalid-source');
  return name;
}
export async function controlFetchFile(path: string, key: string | undefined, init: RequestInit = {}): Promise<ControlFileResponse> {
  const response = await privateFetch(path, key, init);
  if (!response.ok) { await readJson(response, init.signal ?? undefined); throw new ControlApiError(); }
  const kind = response.headers.get('X-Pixel-Control-File');
  if (kind === 'link') {
    const link = parseControlExternalFile(await readJson(response, init.signal ?? undefined));
    if (!link) throw new ControlApiError('invalid-source'); return link;
  }
  if (kind !== 'bytes') { void response.body?.cancel(); throw new ControlApiError('invalid-source'); }
  let filename: string;
  const mimeType = response.headers.get('Content-Type') ?? 'application/octet-stream';
  try {
    filename = responseFilename(response);
    if (mimeType.length > 160 || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;\s*charset=utf-8)?$/i.test(mimeType)) throw new ControlApiError('invalid-source');
  } catch (error) { void response.body?.cancel(); throw error; }
  const bytes = await readBytes(response, CONTROL_RESULT_LIMITS.transferBytes, init.signal ?? undefined);
  return { kind: 'bytes', blob: new Blob([bytes], { type: mimeType }), filename, truncated: response.headers.get('X-Pixel-Preview-Truncated') === 'true' };
}
