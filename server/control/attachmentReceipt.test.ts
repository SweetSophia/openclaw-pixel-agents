// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectAttachmentEvidence } from './attachmentReceipt';
import { attachmentImage, attachmentMessage, attachmentTextDigest, durableOmission, limitOmission, nativeImageMessage } from './fixtures/attachments';

describe('bounded native attachment projection', () => {
  it.each(['inline', 'offloaded'] as const)('projects only the matching canonical %s image reference', kind => {
    const message = nativeImageMessage('operation-1', kind);
    expect(projectAttachmentEvidence(message, attachmentImage, attachmentTextDigest)).toBe('reference-recorded');
  });
  it('recorded_text_is_not_image_success', () => {
    expect(projectAttachmentEvidence({ role: 'user', content: attachmentMessage, __openclaw: { id: 'user-1', seq: 7, runId: 'operation-1' } },
      attachmentImage, attachmentTextDigest)).toBe('unverified');
  });
  it.each([durableOmission, limitOmission])('recognizes only the exact added omission suffix: %s', marker => {
    expect(projectAttachmentEvidence({ role: 'user', content: `${attachmentMessage}\n${marker}` }, attachmentImage, attachmentTextDigest)).toBe('omitted');
    const supplied = `${attachmentMessage}\n${marker}`;
    const suppliedDigest = createHash('sha256').update(supplied).digest('hex');
    expect(projectAttachmentEvidence({ role: 'user', content: supplied }, attachmentImage, suppliedDigest)).toBe('unverified');
    expect(projectAttachmentEvidence({ role: 'user', content: `${supplied}\n${marker}` }, attachmentImage, suppliedDigest)).toBe('unverified');
    for (const content of [`${attachmentMessage} \n${marker}`, `${attachmentMessage}\n${marker} `, `${attachmentMessage}\n${marker.toUpperCase()}`]) {
      expect(projectAttachmentEvidence({ role: 'user', content }, attachmentImage, attachmentTextDigest)).toBe('unverified');
    }
  });
  it('rejects an omission guess with malformed native metadata', () => {
    for (const __openclaw of [[], 'clipped', null]) {
      expect(projectAttachmentEvidence({ role: 'user', content: `${attachmentMessage}\n${durableOmission}`, __openclaw }, attachmentImage, attachmentTextDigest)).toBe('unverified');
    }
  });
  it.each([
    ['missing media', (m: ReturnType<typeof nativeImageMessage>) => { delete (m.__openclaw as Record<string, unknown>).media; }],
    ['missing layout', m => { delete (m.__openclaw as Record<string, unknown>).mediaImageLayout; }],
    ['duplicate facts', m => { m.__openclaw.media.push({ ...m.__openclaw.media[0] }); }],
    ['foreign filename', m => { m.__openclaw.media[0].fileName = 'other.png'; }],
    ['foreign mime', m => { m.__openclaw.media[0].contentType = 'image/jpeg'; }],
    ['foreign size', m => { m.__openclaw.media[0].sizeBytes = 69; }],
    ['foreign dimension', m => { m.__openclaw.media[0].width = 2; }],
    ['foreign kind', m => { m.__openclaw.media[0].kind = 'audio'; }],
    ['suppressed fact', m => { Object.assign(m.__openclaw.media[0], { hydrationSuppressed: true }); }],
    ['suppressed index', m => { Object.assign(m.__openclaw.mediaImageLayout, { suppressedFactIndexes: [0] }); }],
    ['unknown layout kind', m => { Object.assign(m.__openclaw.mediaImageLayout.slots[0], { kind: 'unknown' }); }],
    ['wrong fact index', m => { m.__openclaw.mediaImageLayout.slots[0].factIndex = 1; }],
    ['duplicate slots', m => { m.__openclaw.mediaImageLayout.slots.push({ kind: 'inline', factIndex: 0 }); }],
    ['local path', m => { Object.assign(m.__openclaw.media[0], { path: '/private/fixture.png' }); }],
    ['unknown media field', m => { Object.assign(m.__openclaw.media[0], { guessedHash: attachmentImage.sha256 }); }],
    ['clipped text', m => { m.content = 'Describe…'; }],
    ['clipped flag', m => { Object.assign(m, { truncated: true }); }],
    ['non-string content', m => { Object.assign(m, { content: [{ type: 'text', text: attachmentMessage }] }); }],
    ['wrong role', m => { m.role = 'assistant'; }],
    ['omission contradicting media', m => { m.content += `\n${durableOmission}`; }],
  ] as [string, (message: ReturnType<typeof nativeImageMessage>) => void][])('keeps %s unverified', (_label, change) => {
    const message = nativeImageMessage(); change(message);
    expect(projectAttachmentEvidence(message, attachmentImage, attachmentTextDigest)).toBe('unverified');
  });
  it.each(['https://example.test/image.png', 'media://outbound/image.png', 'media://inbound/a/b.png', 'media://inbound/a%2fb.png',
    'media://inbound/a%5cb.png', 'media://inbound/a%00b.png', 'media://inbound/%2e%2e', 'media://inbound//image.png',
    'media://inbound/image.png?token=secret', 'media://inbound/image.png#fragment', 'media://user@inbound/image.png',
    'MEDIA://inbound/image.png', ' MEDIA: media://inbound/image.png', ' media://inbound/image.png', 'media://inbound/%69mage.png'])('rejects noncanonical reference %s', url => {
    const message = nativeImageMessage(); message.__openclaw.media[0].url = url;
    expect(projectAttachmentEvidence(message, attachmentImage, attachmentTextDigest)).toBe('unverified');
  });
});
