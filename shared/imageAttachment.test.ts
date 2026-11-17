import { describe, expect, it } from 'vitest';
import { inspectAttachmentImage, normalizeAttachmentFilename } from './imageAttachment';

function png(width = 1, height = 1) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}
function jpeg(marker = 0xc0, width = 1, height = 1) {
  return Uint8Array.from([0xff, 0xd8, 0xff, marker, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
}

describe('bounded image header screening', () => {
  it('reads actual PNG and baseline/progressive JPEG dimensions, including subarrays', () => {
    expect(inspectAttachmentImage(png(8192, 2048))).toEqual({ mimeType: 'image/png', width: 8192, height: 2048 });
    for (const marker of [0xc0, 0xc2]) expect(inspectAttachmentImage(jpeg(marker, 32, 24))).toEqual({ mimeType: 'image/jpeg', width: 32, height: 24 });
    const padded = new Uint8Array(40); padded.set(png(), 7);
    expect(inspectAttachmentImage(padded.subarray(7))).toMatchObject({ width: 1 });
  });
  it('fails closed for empty, truncated, contradictory and excessive dimensions', () => {
    for (const bytes of [new Uint8Array(), png().slice(0, 32), png(0), png(8193), png(8192, 2049), jpeg().slice(0, 14), jpeg(0xc1), jpeg(0xc0, 0), Uint8Array.of(0xff, 0xd8, 0xff, 0xda, 0, 2)]) expect(() => inspectAttachmentImage(bytes)).toThrow();
    for (const [offset, value] of [[0, 0], [11, 12], [12, 0], [24, 0], [25, 7], [26, 1], [27, 1], [28, 2]]) {
      const bytes = png(); bytes[offset] = value;
      expect(() => inspectAttachmentImage(bytes)).toThrow();
    }
  });
  it('limits JPEG header scans to 64 KiB and bounds declared segment lengths', () => {
    const frame = jpeg().subarray(2);
    const bounded = new Uint8Array(65_536);
    bounded.set([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xec]);
    bounded.set(frame, 65_520);
    expect(inspectAttachmentImage(bounded)).toMatchObject({ width: 1 });
    const late = new Uint8Array(65_554);
    late.set([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]); late.set(frame, 65_539);
    expect(() => inspectAttachmentImage(late)).toThrow();
    expect(() => inspectAttachmentImage(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff))).toThrow();
  });
});

describe('plain bounded image labels', () => {
  it('keeps Unicode as plain text while removing paths, controls, and wrong extensions', () => {
    expect(normalizeAttachmentFilename('C:\\private\\猫\u0000.jpg', 'image/png')).toBe('猫.png');
    expect(normalizeAttachmentFilename('/tmp/café.jpeg', 'image/jpeg')).toBe('café.jpg');
    for (const name of ['', '.', '..', 'CON', 'nul.jpg', 'com1.png', 'AUX.txt', 'LPT9.jpeg']) expect(normalizeAttachmentFilename(name, 'image/png')).toBe('image.png');
    for (const name of ['x'.repeat(300), '\u202eimage.png', '<image>:?.png', '../name\n.png']) {
      const normalized = normalizeAttachmentFilename(name, 'image/png');
      expect(normalized.length).toBeLessThanOrEqual(128);
      expect(normalized).toMatch(/\.png$/);
      expect(normalized).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e<>:"/\\|?*]/);
    }
  });
  it('rechecks unsafe trailing characters and reserved basenames after truncation', () => {
    expect(normalizeAttachmentFilename('a'.repeat(123) + ' rest.png', 'image/png')).toBe('a'.repeat(123) + '.png');
    expect(normalizeAttachmentFilename('CON' + ' '.repeat(200) + 'x.png', 'image/png')).toBe('image.png');
  });
});
