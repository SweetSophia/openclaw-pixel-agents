import { CONTROL_LIMITS, controlByteSize, controlRecord, isControlCommand, parseControlTarget, type ControlTarget } from './control';

export const ATTACHMENT_LIMITS = {
  images: 1, maxBytes: 4_194_304, maxDimension: 8_192, maxPixels: 16_777_216, jpegHeaderBytes: 65_536,
  message: 8_000, filename: 128, bodyBytes: 6_291_456, slots: 2, preparationsPerMinute: 10,
  bodyTimeoutMs: 30_000, nativeTimeoutMs: 30_000, preparedTtlMs: 300_000, receiptTtlMs: 600_000, receipts: 128,
} as const;

export type AttachmentMime = 'image/png' | 'image/jpeg';
export interface AttachmentImage { filename: string; mimeType: AttachmentMime; bytes: number; width: number; height: number; sha256: string }
export interface AttachmentPrepareRequest { target: ControlTarget; message: string; image: { filename: string; mimeType: AttachmentMime; contentBase64: string } }
export interface AttachmentConfirmRequest { operationId: string; reviewToken: string; sharingAcknowledged: true }
export interface AttachmentOperationRequest { operationId: string }
export interface AttachmentStatus {
  enabled: boolean; canPrepare: boolean; reason: 'disabled' | 'permission' | 'unsupported' | 'unavailable' | null;
  epoch: string | null; maxBytes: number | null;
}
export interface AttachmentReview {
  operationId: string; reviewToken: string; target: ControlTarget; message: string; image: AttachmentImage; manifestDigest: string; expiresInMs: number;
}
export type AttachmentImageEvidence = 'unverified' | 'reference-recorded' | 'omitted';
export interface AttachmentReceipt {
  operationId: string; target: ControlTarget; phase: 'prepared' | 'not-dispatched' | 'sending' | 'accepted' | 'recorded' | 'rejected' | 'unknown';
  nativeInvoked: boolean; imageEvidence: AttachmentImageEvidence; runId?: string; messageId?: string; messageSeq?: number;
  reason?: 'changed' | 'expired' | 'permission' | 'unsupported' | 'unavailable' | 'uploads-disabled';
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const row = controlRecord(value);
  return row && Object.keys(row).every(key => keys.includes(key)) ? row : null;
}
const opaque = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const operation = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const positive = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const mime = (value: unknown): value is AttachmentMime => value === 'image/png' || value === 'image/jpeg';
const message = (value: unknown): value is string => typeof value === 'string' && value.length <= ATTACHMENT_LIMITS.message && Boolean(value.trim()) && !isControlCommand(value);

function target(value: unknown): ControlTarget | null {
  return closed(value, ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'branchId', 'activeLeafEntryId']) ? parseControlTarget(value) : null;
}

// Check length and unused pad bits before decoding; permissive native decoders accept aliases.
export function isCanonicalAttachmentBase64(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > 4 * Math.ceil(ATTACHMENT_LIMITS.maxBytes / 3)
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length / 4 * 3 - padding > ATTACHMENT_LIMITS.maxBytes) return false;
  const last = alphabet.indexOf(value[value.length - padding - 1]);
  return padding === 0 || (last & (padding === 2 ? 15 : 3)) === 0;
}

export function parseAttachmentImageInput(value: unknown): AttachmentPrepareRequest['image'] | null {
  const row = closed(value, ['filename', 'mimeType', 'contentBase64']);
  if (!row || typeof row.filename !== 'string' || row.filename.length > 1024 || !mime(row.mimeType)
    || !isCanonicalAttachmentBase64(row.contentBase64)) return null;
  return { filename: row.filename, mimeType: row.mimeType, contentBase64: row.contentBase64 };
}

export function parseAttachmentPrepareRequest(value: unknown): AttachmentPrepareRequest | null {
  const row = closed(value, ['target', 'message', 'image']);
  if (!row || !message(row.message) || controlByteSize(row) > ATTACHMENT_LIMITS.bodyBytes) return null;
  const parsedTarget = target(row.target), image = parseAttachmentImageInput(row.image);
  return parsedTarget && image ? { target: parsedTarget, message: row.message, image } : null;
}
export function parseAttachmentConfirmRequest(value: unknown): AttachmentConfirmRequest | null {
  const row = closed(value, ['operationId', 'reviewToken', 'sharingAcknowledged']);
  return row && operation(row.operationId) && opaque(row.reviewToken) && row.sharingAcknowledged === true
    ? { operationId: row.operationId, reviewToken: row.reviewToken, sharingAcknowledged: true } : null;
}
export function parseAttachmentOperationRequest(value: unknown): AttachmentOperationRequest | null {
  const row = closed(value, ['operationId']);
  return row && operation(row.operationId) ? { operationId: row.operationId } : null;
}
export function parseAttachmentStatus(value: unknown): AttachmentStatus | null {
  const row = closed(value, ['enabled', 'canPrepare', 'reason', 'epoch', 'maxBytes']);
  if (!row || typeof row.enabled !== 'boolean' || typeof row.canPrepare !== 'boolean'
    || (row.reason !== null && !['disabled', 'permission', 'unsupported', 'unavailable'].includes(row.reason as string))
    || (row.epoch !== null && !opaque(row.epoch)) || (row.maxBytes !== null && !positive(row.maxBytes, ATTACHMENT_LIMITS.maxBytes))
    || (row.canPrepare ? !row.enabled || row.reason !== null || row.epoch === null || row.maxBytes === null : row.reason === null)
    || (!row.enabled && row.reason !== 'disabled')) return null;
  return { enabled: row.enabled, canPrepare: row.canPrepare, reason: row.reason as AttachmentStatus['reason'], epoch: row.epoch, maxBytes: row.maxBytes };
}

function parseImage(value: unknown): AttachmentImage | null {
  const row = closed(value, ['filename', 'mimeType', 'bytes', 'width', 'height', 'sha256']);
  if (!row || !mime(row.mimeType) || !opaque(row.filename, ATTACHMENT_LIMITS.filename)
    || /[<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/.test(row.filename)
    || row.filename.startsWith('.') || /[. ]\.(png|jpg)$/.test(row.filename)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(row.filename)
    || !row.filename.endsWith(row.mimeType === 'image/png' ? '.png' : '.jpg')
    || !positive(row.bytes, ATTACHMENT_LIMITS.maxBytes) || !positive(row.width, ATTACHMENT_LIMITS.maxDimension)
    || !positive(row.height, ATTACHMENT_LIMITS.maxDimension) || row.width * row.height > ATTACHMENT_LIMITS.maxPixels || !digest(row.sha256)) return null;
  return { filename: row.filename, mimeType: row.mimeType, bytes: row.bytes, width: row.width, height: row.height, sha256: row.sha256 };
}
export function parseAttachmentReview(value: unknown): AttachmentReview | null {
  const row = closed(value, ['operationId', 'reviewToken', 'target', 'message', 'image', 'manifestDigest', 'expiresInMs']);
  if (!row || controlByteSize(row) > CONTROL_LIMITS.responseBytes || !operation(row.operationId) || !opaque(row.reviewToken)
    || !message(row.message) || !digest(row.manifestDigest) || !positive(row.expiresInMs, ATTACHMENT_LIMITS.preparedTtlMs)) return null;
  const parsedTarget = target(row.target), image = parseImage(row.image);
  return parsedTarget && image ? { operationId: row.operationId, reviewToken: row.reviewToken, target: parsedTarget, message: row.message, image, manifestDigest: row.manifestDigest, expiresInMs: row.expiresInMs } : null;
}
export function parseAttachmentReceipt(value: unknown): AttachmentReceipt | null {
  const row = closed(value, ['operationId', 'target', 'phase', 'nativeInvoked', 'imageEvidence', 'runId', 'messageId', 'messageSeq', 'reason']);
  if (!row || controlByteSize(row) > CONTROL_LIMITS.responseBytes || !operation(row.operationId) || typeof row.nativeInvoked !== 'boolean'
    || !['prepared', 'not-dispatched', 'sending', 'accepted', 'recorded', 'rejected', 'unknown'].includes(row.phase as string)
    || !['unverified', 'reference-recorded', 'omitted'].includes(row.imageEvidence as string)
    || (row.runId !== undefined && row.runId !== row.operationId)
    || (row.messageId !== undefined && !opaque(row.messageId))
    || (row.messageSeq !== undefined && !positive(row.messageSeq, Number.MAX_SAFE_INTEGER))
    || (row.reason !== undefined && !['changed', 'expired', 'permission', 'unsupported', 'unavailable', 'uploads-disabled'].includes(row.reason as string))) return null;
  if ((['accepted', 'recorded', 'rejected', 'unknown'].includes(row.phase as string) && !row.nativeInvoked)
    || (['prepared', 'not-dispatched'].includes(row.phase as string) && row.nativeInvoked)
    || (row.imageEvidence !== 'unverified' && !row.nativeInvoked)
    || (row.reason === 'uploads-disabled' && row.phase !== 'rejected')
    || (row.phase === 'recorded' && (!row.messageId || !row.messageSeq))) return null;
  const parsedTarget = target(row.target);
  return parsedTarget ? { operationId: row.operationId, target: parsedTarget, phase: row.phase as AttachmentReceipt['phase'], nativeInvoked: row.nativeInvoked,
    imageEvidence: row.imageEvidence as AttachmentImageEvidence, ...(row.runId !== undefined ? { runId: row.runId as string } : {}),
    ...(row.messageId !== undefined ? { messageId: row.messageId as string } : {}), ...(row.messageSeq !== undefined ? { messageSeq: row.messageSeq as number } : {}),
    ...(row.reason !== undefined ? { reason: row.reason as AttachmentReceipt['reason'] } : {}) } : null;
}
