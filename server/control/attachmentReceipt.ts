import { createHash } from 'node:crypto';
import { CONTROL_LIMITS, controlByteSize, controlRecord } from '../../shared/control';
import type { AttachmentImage, AttachmentImageEvidence } from '../../shared/controlAttachments';

// Qualified 2026.11.2 chat-attachments omission strings; never infer omission
// from a missing fact or from a marker that was already in the submitted text.
const OMISSIONS = ['[image attachment omitted: durable managed media claim unavailable]',
  '[image attachment omitted: text-only attachment limit reached]'];
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const only = (row: Record<string, unknown>, keys: string[]): boolean => Object.keys(row).every(key => keys.includes(key));
function canonicalInbound(value: unknown): boolean {
  if (typeof value !== 'string' || !value.startsWith('media://inbound/') || value.length > 2048) return false;
  try {
    const uri = new URL(value), id = decodeURIComponent(uri.pathname.slice(1));
    // The native builder validates the saved ID without adopting URI aliases.
    return uri.href === value && uri.hostname === 'inbound' && !uri.username && !uri.password && !uri.port && !uri.search && !uri.hash
      && id === value.slice('media://inbound/'.length) && Boolean(id) && id !== '.' && id !== '..'
      && !/[\/\\\u0000-\u0020\u007f-\u009f]/.test(id);
  } catch { return false; }
}

// The caller must establish native run/event identity first. A reference is not
// proof of image-byte persistence, digest equality, or provider consumption.
export function projectAttachmentEvidence(message: unknown, image: AttachmentImage, submittedTextDigest: string): AttachmentImageEvidence {
  const row = controlRecord(message), meta = controlRecord(row?.__openclaw);
  if (!row || row.role !== 'user' || typeof row.content !== 'string' || row.truncated === true
    || (row.__openclaw !== undefined && !meta) || controlByteSize(row) > CONTROL_LIMITS.responseBytes
    || !/^[a-f0-9]{64}$/.test(submittedTextDigest)) return 'unverified';
  const media = meta?.media, layout = controlRecord(meta?.mediaImageLayout);
  const noMedia = media === undefined || (Array.isArray(media) && media.length === 0);
  const noLayout = meta?.mediaImageLayout === undefined || (layout && only(layout, ['slots', 'suppressedFactIndexes'])
    && Array.isArray(layout.slots) && layout.slots.length === 0
    && (layout.suppressedFactIndexes === undefined || (Array.isArray(layout.suppressedFactIndexes) && !layout.suppressedFactIndexes.length)));
  if (noMedia && noLayout) for (const marker of OMISSIONS) {
    const suffix = `\n${marker}`;
    if (!row.content.endsWith(suffix)) continue;
    const prefix = row.content.slice(0, -suffix.length);
    if (!OMISSIONS.some(known => prefix.includes(known)) && hash(prefix) === submittedTextDigest) return 'omitted';
  }
  if (hash(row.content) !== submittedTextDigest || !Array.isArray(media) || media.length !== 1 || !layout
    || !only(layout, ['slots', 'suppressedFactIndexes']) || !Array.isArray(layout.slots) || layout.slots.length !== 1
    || (layout.suppressedFactIndexes !== undefined && (!Array.isArray(layout.suppressedFactIndexes) || layout.suppressedFactIndexes.length !== 0))) return 'unverified';
  const fact = controlRecord(media[0]), slot = controlRecord(layout.slots[0]);
  if (!fact || !slot || !only(slot, ['kind', 'factIndex']) || !['inline', 'offloaded'].includes(String(slot.kind)) || slot.factIndex !== 0
    || !only(fact, ['url', 'contentType', 'kind', 'fileName', 'origin', 'sizeBytes', 'width', 'height'])
    || fact.kind !== 'image' || fact.contentType !== image.mimeType || fact.fileName !== image.filename || fact.sizeBytes !== image.bytes
    || fact.width !== image.width || fact.height !== image.height || (fact.origin !== undefined && fact.origin !== 'file')
    || !canonicalInbound(fact.url)) return 'unverified';
  return 'reference-recorded';
}
