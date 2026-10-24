import { CONTROL_LIMITS, controlRecord, type ControlErrorCode, type ControlTarget } from '../../shared/control';

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
};
export class ControlApiError extends Error {
  constructor(public readonly code: ControlErrorCode = 'unavailable') { super(messages[code] ?? 'Task details are temporarily unavailable.'); }
}
export function targetIdentity(target: ControlTarget): string {
  return JSON.stringify([target.agentId, target.sessionKey, target.sessionId, target.lifecycleRevision ?? null, target.branchId ?? null]);
}
export async function controlFetch(path: string, key?: string, init: RequestInit = {}): Promise<unknown> {
  const url = new URL(path, window.location.origin);
  if (!path.startsWith('/api/control/') || !url.pathname.startsWith('/api/control/') || url.origin !== window.location.origin
    || url.hash || path.includes('\\')) throw new ControlApiError('invalid-request');
  const headers = new Headers(init.headers); headers.delete('Authorization');
  if (key) headers.set('Authorization', `Bearer ${key}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  let response: Response;
  try { response = await fetch(path, { ...init, headers, redirect: 'error', cache: 'no-store', credentials: 'same-origin' }); }
  catch { throw new ControlApiError('unavailable'); }
  let value: unknown;
  try {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > CONTROL_LIMITS.responseBytes) throw Error();
    value = JSON.parse(text);
  } catch { throw new ControlApiError('invalid-source'); }
  if (!response.ok) {
    const code = controlRecord(value)?.code;
    throw new ControlApiError(typeof code === 'string' && (Object.prototype.hasOwnProperty.call(messages, code) || ['unavailable', 'invalid-source', 'outcome-unknown'].includes(code)) ? code as ControlErrorCode : 'unavailable');
  }
  return value;
}
