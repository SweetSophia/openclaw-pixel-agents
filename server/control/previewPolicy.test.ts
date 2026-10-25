// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { previewContent, safeArtifactFilename } from './previewPolicy';

const png = () => readFileSync(new URL('../../public/assets/characters/char_0.png', import.meta.url));
describe('inert delivered-file previews', () => {
  it('caps UTF-8 text without splitting a character and labels shortened bytes', () => {
    const prefix = 'a'.repeat(256 * 1024 - 1);
    const result = previewContent(Buffer.from(prefix + '€'), 'application/json');
    expect(result.mimeType).toBe('text/plain; charset=utf-8'); expect(result.truncated).toBe(true);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(result.data)).toBe(prefix);
    expect(result.data.byteLength).toBeLessThanOrEqual(256 * 1024);
  });
  it('rejects invalid UTF-8, including bytes after the visible preview window', () => {
    for (const data of [Buffer.from([0xc3, 0x28]), Buffer.concat([Buffer.alloc(256 * 1024, 97), Buffer.from([0xc3, 0x28])])]) {
      expect(() => previewContent(data, 'text/plain')).toThrowError(expect.objectContaining({ code: 'preview-unsupported' }));
    }
  });
  it.each(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/pdf', 'application/zip', 'audio/mpeg', 'video/mp4'])('keeps %s download-only', mime => {
    expect(() => previewContent(Buffer.from('<script>synthetic</script>'), mime)).toThrowError(expect.objectContaining({ code: 'preview-unsupported' }));
  });
  it('accepts a real bounded PNG without decoding it', () => {
    const data = png(); const result = previewContent(data, 'image/png');
    expect(result.data).toEqual(data); expect(result.mimeType).toBe('image/png'); expect(result.truncated).toBe(false);
  });
  it('rejects excessive source bytes, dimensions and malformed PNG containers before image display', () => {
    const huge = png(); huge.writeUInt32BE(50000, 16); huge.writeUInt32BE(50000, 20);
    expect(() => previewContent(huge, 'image/png')).toThrowError(expect.objectContaining({ code: 'file-too-large' }));
    expect(() => previewContent(Buffer.alloc(8 * 1024 * 1024 + 1), 'image/png')).toThrowError(expect.objectContaining({ code: 'file-too-large' }));
    for (const data of [Buffer.from('not png'), png().subarray(0, 25), Buffer.concat([png(), Buffer.from('trailing')])]) {
      expect(() => previewContent(data, 'image/png')).toThrowError(expect.objectContaining({ code: 'preview-unsupported' }));
    }
  });
  it('checks JPEG and lossless WebP header dimensions before any browser decoding', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0xff, 0xff, 0xff, 0xff, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0xff, 0xd9]);
    expect(() => previewContent(jpeg, 'image/jpeg')).toThrowError(expect.objectContaining({ code: 'file-too-large' }));
    const webp = Buffer.alloc(26); webp.write('RIFF'); webp.writeUInt32LE(18, 4); webp.write('WEBPVP8L', 8); webp.writeUInt32LE(5, 16); webp[20] = 0x2f;
    webp.writeUInt32LE(0x0fffffff, 21);
    expect(() => previewContent(webp, 'image/webp')).toThrowError(expect.objectContaining({ code: 'file-too-large' }));
    for (const mime of ['image/jpeg', 'image/webp']) expect(() => previewContent(Buffer.from('invalid'), mime)).toThrowError(expect.objectContaining({ code: 'preview-unsupported' }));
  });
  it('removes directory/header controls and Windows reserved names from download filenames', () => {
    const filename = safeArtifactFilename('../secret\\report\r\nX: injected".html');
    expect(filename).not.toMatch(/[\\/\u0000-\u001f\u007f"]/);
    expect(safeArtifactFilename('x'.repeat(500)).length).toBeLessThanOrEqual(128);
    expect(safeArtifactFilename('..')).not.toMatch(/^[. ]*$/);
    expect(safeArtifactFilename('CON.txt')).not.toMatch(/^con(?:\.|$)/i);
    for (const name of ['low\udc00.txt', 'high\ud800-mid.txt', '💫.txt', 'x'.repeat(127) + '💫.txt', 'CON.' + 'x'.repeat(116) + '💫.txt']) {
      expect(() => encodeURIComponent(safeArtifactFilename(name))).not.toThrow();
    }
    expect(safeArtifactFilename('💫.txt')).toBe('💫.txt');
  });
});
