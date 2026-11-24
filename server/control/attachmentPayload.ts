import { createHash } from 'node:crypto';
import { ATTACHMENT_LIMITS, parseAttachmentImageInput, type AttachmentImage, type AttachmentPrepareRequest } from '../../shared/controlAttachments';
import { inspectAttachmentImage, normalizeAttachmentFilename } from '../../shared/imageAttachment';
import { ControlError } from './errors';

export interface ValidatedAttachmentPayload { contentBase64: string; image: AttachmentImage }

export function validateAttachmentPayload(input: AttachmentPrepareRequest['image'], maxBytes: number): ValidatedAttachmentPayload {
  const image = parseAttachmentImageInput(input);
  if (!image || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new ControlError('invalid-request');
  const maximum = Math.min(ATTACHMENT_LIMITS.maxBytes, maxBytes);
  const padding = image.contentBase64.endsWith('==') ? 2 : image.contentBase64.endsWith('=') ? 1 : 0;
  const length = image.contentBase64.length / 4 * 3 - padding;
  if (length <= 0 || length > maximum) throw new ControlError('file-too-large');
  const bytes = Buffer.from(image.contentBase64, 'base64');
  try {
    const detected = inspectAttachmentImage(bytes);
    if (detected.mimeType !== image.mimeType || bytes.length !== length) throw new ControlError('invalid-request');
    return { contentBase64: image.contentBase64, image: { filename: normalizeAttachmentFilename(image.filename, detected.mimeType), ...detected,
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  } catch { throw new ControlError('invalid-request'); }
  // The decoded buffer is never retained: descriptors and the canonical source alone escape.
}
