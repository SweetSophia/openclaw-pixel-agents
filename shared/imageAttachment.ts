import { ATTACHMENT_LIMITS, type AttachmentMime } from './controlAttachments';

export function normalizeAttachmentFilename(name: string, mime: AttachmentMime): string {
  const extension = mime === 'image/png' ? '.png' : '.jpg';
  let stem = (name.split(/[/\\]/).pop() ?? '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '')
    .replace(/\.[^.]*$/, '').trim().replace(/^[. ]+|[. ]+$/g, '');
  // Slice code points without splitting surrogate pairs, while bounding UTF-16 length.
  stem = Array.from(stem).reduce((text, point) => text.length + point.length <= ATTACHMENT_LIMITS.filename - extension.length ? text + point : text, '').replace(/[. ]+$/g, '');
  if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = 'image';
  return stem + extension;
}

export function inspectAttachmentImage(bytes: Uint8Array): { mimeType: AttachmentMime; width: number; height: number } {
  const invalid = () => { throw Error('Invalid attachment image header'); };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = (mimeType: AttachmentMime, width: number, height: number) => {
    if (!width || !height || width > ATTACHMENT_LIMITS.maxDimension || height > ATTACHMENT_LIMITS.maxDimension
      || width * height > ATTACHMENT_LIMITS.maxPixels) return invalid();
    return { mimeType, width, height };
  };
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return invalid();
    const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) return invalid();
    return dimensions('image/png', view.getUint32(16), view.getUint32(20));
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return invalid();
  const limit = Math.min(bytes.length, ATTACHMENT_LIMITS.jpegHeaderBytes);
  let offset = 2;
  while (offset < limit) {
    if (bytes[offset++] !== 0xff) return invalid();
    while (offset < limit && bytes[offset] === 0xff) offset++;
    if (offset >= limit) return invalid();
    const marker = bytes[offset++];
    if (marker === 0x01) continue;
    if (marker === 0 || marker === 0xd8 || marker === 0xd9 || marker === 0xda || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > limit) return invalid();
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > limit) return invalid();
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (![0xc0, 0xc2].includes(marker) || length < 11 || bytes[offset + 2] !== 8) return invalid();
      const components = bytes[offset + 7];
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) return invalid();
      const ids = new Set<number>();
      for (let i = 0; i < components; i++) {
        const start = offset + 8 + 3 * i, sampling = bytes[start + 1];
        if (ids.has(bytes[start]) || (sampling >> 4) < 1 || (sampling >> 4) > 4 || (sampling & 15) < 1 || (sampling & 15) > 4 || bytes[start + 2] > 3) return invalid();
        ids.add(bytes[start]);
      }
      return dimensions('image/jpeg', view.getUint16(offset + 5), view.getUint16(offset + 3));
    }
    offset += length;
  }
  return invalid();
}
