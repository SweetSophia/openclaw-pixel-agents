import { CONTROL_RESULT_LIMITS } from '../../shared/controlResults';
import { ControlError } from './errors';

const unsupported = (): never => { throw new ControlError('preview-unsupported'); };
function dimensions(width: number, height: number): void {
  if (!width || !height) unsupported();
  if (width * height > CONTROL_RESULT_LIMITS.imagePixels) throw new ControlError('file-too-large');
}
function png(data: Buffer): void {
  if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) unsupported();
  let offset = 8; let header = false; let pixels = false;
  while (offset + 12 <= data.length) {
    const size = data.readUInt32BE(offset); const end = offset + size + 12; const type = data.toString('ascii', offset + 4, offset + 8);
    if (end > data.length || (!header && type !== 'IHDR')) unsupported();
    if (type === 'IHDR') {
      if (header || size !== 13) unsupported(); header = true;
      dimensions(data.readUInt32BE(offset + 8), data.readUInt32BE(offset + 12));
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[data[offset + 17]]?.includes(data[offset + 16]) || data[offset + 18] !== 0 || data[offset + 19] !== 0 || data[offset + 20] > 1) unsupported();
    }
    if (type === 'acTL') unsupported();
    if (type === 'IDAT') pixels = true;
    if (type === 'IEND') { if (size !== 0 || end !== data.length || !pixels) unsupported(); return; }
    offset = end;
  }
  unsupported();
}
function jpeg(data: Buffer): void {
  if (data.length < 4 || data[0] !== 255 || data[1] !== 216 || data[data.length - 2] !== 255 || data[data.length - 1] !== 217) unsupported();
  let offset = 2; let frame = false;
  while (offset + 4 <= data.length) {
    if (data[offset++] !== 255) unsupported(); while (data[offset] === 255) offset++;
    const marker = data[offset++];
    if (marker === 218) { if (!frame) unsupported(); return; }
    if (!marker || marker === 216 || marker === 217 || (marker >= 208 && marker <= 215) || offset + 2 > data.length) unsupported();
    const length = data.readUInt16BE(offset); if (length < 2 || offset + length > data.length) unsupported();
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (frame || length < 8 || data[offset + 2] !== 8) unsupported();
      dimensions(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3));
      const components = data[offset + 7]; if (!components || components > 4 || length !== 8 + components * 3) unsupported(); frame = true;
    }
    offset += length;
  }
  unsupported();
}
function webp(data: Buffer): void {
  if (data.length < 20 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP' || data.readUInt32LE(4) + 8 !== data.length) unsupported();
  let offset = 12; let canvas: [number, number] | undefined; let image: [number, number] | undefined;
  while (offset + 8 <= data.length) {
    const type = data.toString('ascii', offset, offset + 4); const size = data.readUInt32LE(offset + 4); const start = offset + 8;
    const end = start + size + (size % 2); if (end > data.length) unsupported();
    if (type === 'ANIM' || type === 'ANMF') unsupported();
    if (type === 'VP8X') {
      if (canvas || size !== 10 || (data[start] & 2)) unsupported();
      canvas = [1 + data.readUIntLE(start + 4, 3), 1 + data.readUIntLE(start + 7, 3)]; dimensions(...canvas);
    }
    if (type === 'VP8L') {
      if (image || size < 5 || data[start] !== 0x2f) unsupported(); const bits = data.readUInt32LE(start + 1);
      if (bits >>> 29) unsupported(); image = [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)]; dimensions(...image);
    }
    if (type === 'VP8 ') {
      if (image || size < 10 || (data[start] & 1) || !data.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))) unsupported();
      image = [data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff]; dimensions(...image);
    }
    offset = end;
  }
  if (offset !== data.length || !image || (canvas && (canvas[0] !== image[0] || canvas[1] !== image[1]))) unsupported();
}
export function safeArtifactFilename(title: string): string {
  const filename = title.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 128).replace(/[\ud800-\udbff]$/, '');
  return !filename ? 'shared-file' : /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename) ? `shared-${filename}`.slice(0, 128) : filename;
}
export function artifactMime(value?: string): string {
  const mime = value?.split(';')[0].trim().toLowerCase();
  return mime && mime.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}
export function previewContent(input: Uint8Array, mimeType: string): { data: Uint8Array; mimeType: string; truncated: boolean } {
  const mime = artifactMime(mimeType);
  if (input.byteLength > CONTROL_RESULT_LIMITS.transferBytes) throw new ControlError('file-too-large');
  if (['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
    if (input.byteLength > CONTROL_RESULT_LIMITS.imageBytes) throw new ControlError('file-too-large');
    const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (mime === 'image/png') png(data); else if (mime === 'image/jpeg') jpeg(data); else webp(data);
    return { data: input, mimeType: mime, truncated: false };
  }
  if (['text/html', 'application/xhtml+xml', 'image/svg+xml'].includes(mime)
    || !(mime.startsWith('text/') || /^application\/(json|[^/]+\+json|javascript|x-javascript|typescript|xml|[^/]+\+xml|toml|yaml|x-yaml)$/.test(mime))) unsupported();
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (let offset = 0; offset < input.byteLength; offset += 32768) decoder.decode(input.subarray(offset, offset + 32768), { stream: true });
    decoder.decode();
  } catch { unsupported(); }
  let end = Math.min(input.byteLength, CONTROL_RESULT_LIMITS.previewBytes);
  if (end < input.byteLength) while (end > 0 && (input[end] & 0xc0) === 0x80) end--;
  return { data: input.slice(0, end), mimeType: 'text/plain; charset=utf-8', truncated: end < input.byteLength };
}
