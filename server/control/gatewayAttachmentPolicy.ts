import { controlRecord, isControlCommand, parseControlTarget } from '../../shared/control';
import { ATTACHMENT_LIMITS, isCanonicalAttachmentBase64, type AttachmentMime } from '../../shared/controlAttachments';
import { supportsStableGatewayVersion } from './gatewayVersion';

export interface AttachmentGatewayCapabilities {
  epoch: string; sourceKey: string; maxBytes: number; maxImageBytes: number; maxPayload: number; maxBufferedBytes: number;
}
export interface NativeImageFollowup {
  agentId: string; sessionKey: string; sessionId: string; expectedLeafEntryId: string; message: string; idempotencyKey: string;
  queueMode: 'followup'; deliver: false;
  attachments: [{ mimeType: AttachmentMime; fileName: string; origin: 'file'; content: string }];
}
export interface NativeImageRequestFrame { type: 'req'; id: string; method: 'chat.send'; params: NativeImageFollowup }
export class AttachmentFrameError extends Error {
  constructor(public readonly kind: 'invalid' | 'too-large') {
    super(kind === 'invalid' ? 'Invalid image follow-up' : 'Image follow-up exceeds limits');
  }
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const opaque = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
function closed(value: unknown, keys: string[]): Record<string, unknown> | null {
  const row = controlRecord(value);
  return row && Object.keys(row).length === keys.length && Object.keys(row).every(key => keys.includes(key))
    ? Object.fromEntries(keys.map(key => [key, row[key]])) : null;
}
export function qualifyAttachmentPolicy(version: unknown, policy: unknown, epoch: string, sourceKey: string): AttachmentGatewayCapabilities | null {
  const row = controlRecord(policy), attachments = controlRecord(row?.attachments);
  if (typeof version !== 'string' || !supportsStableGatewayVersion(version, '2026.11.2') || !row || !attachments
    || !positive(attachments.maxBytes) || !positive(attachments.maxImageBytes) || !positive(row.maxPayload) || !positive(row.maxBufferedBytes)) return null;
  return { epoch, sourceKey, maxBytes: attachments.maxBytes, maxImageBytes: attachments.maxImageBytes, maxPayload: row.maxPayload, maxBufferedBytes: row.maxBufferedBytes };
}

// This is a backend-only dispatch boundary, not a browser payload parser.
export function serializeImageFollowupFrame(frame: NativeImageRequestFrame, caps: AttachmentGatewayCapabilities, bufferedBytes: number): string {
  const envelope = closed(frame, ['type', 'id', 'method', 'params']);
  const params = closed(envelope?.params, ['agentId', 'sessionKey', 'sessionId', 'expectedLeafEntryId', 'message', 'idempotencyKey', 'queueMode', 'deliver', 'attachments']);
  const images = params?.attachments;
  const image = Array.isArray(images) && images.length === ATTACHMENT_LIMITS.images ? closed(images[0], ['mimeType', 'fileName', 'origin', 'content']) : null;
  if (!envelope || envelope.type !== 'req' || envelope.method !== 'chat.send' || !opaque(envelope.id, 128) || !params
    || !parseControlTarget({ agentId: params.agentId, sessionKey: params.sessionKey, sessionId: params.sessionId })
    || !opaque(params.expectedLeafEntryId, 256) || !opaque(params.idempotencyKey, 128)
    || typeof params.message !== 'string' || !params.message.trim() || params.message.length > ATTACHMENT_LIMITS.message || isControlCommand(params.message)
    || params.queueMode !== 'followup' || params.deliver !== false || !image || image.origin !== 'file'
    || (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') || !opaque(image.fileName, ATTACHMENT_LIMITS.filename)
    || /[<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/.test(image.fileName)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(image.fileName)
    || !image.fileName.endsWith(image.mimeType === 'image/png' ? '.png' : '.jpg')
    || !isCanonicalAttachmentBase64(image.content)) throw new AttachmentFrameError('invalid');
  const padding = image.content.endsWith('==') ? 2 : image.content.endsWith('=') ? 1 : 0;
  const decodedBytes = image.content.length / 4 * 3 - padding;
  if (![caps.maxBytes, caps.maxImageBytes, caps.maxPayload, caps.maxBufferedBytes].every(positive)
    || !Number.isSafeInteger(bufferedBytes) || bufferedBytes < 0
    || decodedBytes > Math.min(ATTACHMENT_LIMITS.maxBytes, caps.maxBytes, caps.maxImageBytes)) throw new AttachmentFrameError('too-large');
  const serialized = JSON.stringify({ ...envelope, params: { ...params, attachments: [image] } }); const bytes = Buffer.byteLength(serialized);
  if (bytes > caps.maxPayload || bytes > caps.maxBufferedBytes - bufferedBytes) throw new AttachmentFrameError('too-large');
  return serialized;
}
