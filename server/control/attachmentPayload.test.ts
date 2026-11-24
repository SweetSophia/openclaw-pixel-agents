// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateAttachmentPayload } from './attachmentPayload';
import { ControlError } from './errors';

const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6w1sAAAAASUVORK5CYII=', 'base64');
const pngInput = { filename: '../cat.jpg', mimeType: 'image/png' as const, contentBase64: pngBytes.toString('base64') };

describe('actual_bytes_override_claims', () => {
  it('computes metadata and SHA-256 only from independently decoded bytes', () => {
    expect(validateAttachmentPayload(pngInput, 4_194_304)).toEqual({ contentBase64: pngInput.contentBase64,
      image: { filename: 'cat.png', mimeType: 'image/png', bytes: pngBytes.length, width: 1, height: 1,
        sha256: createHash('sha256').update(pngBytes).digest('hex') } });
    for (const field of ['bytes', 'sha256', 'width', 'height', 'url', 'path']) expect(() => validateAttachmentPayload({ ...pngInput, [field]: 1 }, 4_194_304)).toThrow(ControlError);
    expect(() => validateAttachmentPayload({ ...pngInput, mimeType: 'image/jpeg' }, 4_194_304)).toThrow(ControlError);
  });
  it('honors the exact decoded file cap and lower negotiated limits', () => {
    const large = Buffer.alloc(4_194_304); pngBytes.copy(large);
    const pngAtFileLimit = { ...pngInput, contentBase64: large.toString('base64') };
    expect(validateAttachmentPayload(pngAtFileLimit, 4_194_304).image.bytes).toBe(4_194_304);
    expect(() => validateAttachmentPayload(pngAtFileLimit, 4_194_303)).toThrow();
    expect(validateAttachmentPayload(pngInput, pngBytes.length).image.bytes).toBe(pngBytes.length);
    for (const maximum of [pngBytes.length - 1, 0, -1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1]) expect(() => validateAttachmentPayload(pngInput, maximum)).toThrow(ControlError);
    expect(() => validateAttachmentPayload({ ...pngInput, contentBase64: Buffer.concat([large, Buffer.of(0)]).toString('base64') }, 8_388_608)).toThrow(ControlError);
  });
  it('rejects decoder-tolerated nonzero pad bits, whitespace, aliases and empty data', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const index = pngInput.contentBase64.length - 2;
    const pngWithNonzeroPadBits = pngInput.contentBase64.slice(0, index) + alphabet[alphabet.indexOf(pngInput.contentBase64[index]) + 1] + '=';
    expect(Buffer.from(pngWithNonzeroPadBits, 'base64')).toEqual(pngBytes);
    expect(() => validateAttachmentPayload({ ...pngInput, contentBase64: pngWithNonzeroPadBits }, 4_194_304)).toThrow();
    for (const contentBase64 of ['', 'AA==', pngInput.contentBase64 + '\n', pngInput.contentBase64.replace(/=$/, ''), 'data:image/png;base64,' + pngInput.contentBase64]) expect(() => validateAttachmentPayload({ ...pngInput, contentBase64 }, 4_194_304)).toThrow(ControlError);
  });
});
