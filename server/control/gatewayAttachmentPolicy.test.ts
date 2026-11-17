// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { qualifyAttachmentPolicy, serializeImageFollowupFrame, type AttachmentGatewayCapabilities, type NativeImageRequestFrame } from './gatewayAttachmentPolicy';

const caps: AttachmentGatewayCapabilities = { epoch: 'epoch', sourceKey: 'source', maxBytes: 100, maxImageBytes: 100, maxPayload: 1000, maxBufferedBytes: 2000 };
const frame = (): NativeImageRequestFrame => ({ type: 'req', id: 'real-request-id', method: 'chat.send', params: {
  agentId: 'main', sessionKey: 'agent:main:fixture', sessionId: 'session', expectedLeafEntryId: 'leaf',
  message: 'Look at 雪\n"\\', idempotencyKey: 'operation', queueMode: 'followup', deliver: false,
  attachments: [{ mimeType: 'image/png', fileName: '雪.png', origin: 'file', content: 'AQ==' }],
} });
describe('bounded native image policy', () => {
  it.each([undefined, null, {}, { maxBytes: 0, maxImageBytes: 10 }, { maxBytes: 10, maxImageBytes: -1 }, { maxBytes: 10.5, maxImageBytes: 10 }, { maxBytes: Number.MAX_SAFE_INTEGER + 1, maxImageBytes: 10 }])('requires positive safe-integer attachment limits: %j', attachments => {
    expect(qualifyAttachmentPolicy('2026.11.2', { maxPayload: 1000, maxBufferedBytes: 2000, attachments }, 'epoch', 'source')).toBeNull();
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100'])('requires positive safe frame/buffer limits: %j', limit => {
    for (const key of ['maxPayload', 'maxBufferedBytes']) expect(qualifyAttachmentPolicy('2026.11.2', { maxPayload: 1000, maxBufferedBytes: 2000, attachments: { maxBytes: 100, maxImageBytes: 100 }, [key]: limit }, 'epoch', 'source')).toBeNull();
  });
  it('retains negotiated limits without fabricating them from the version', () => {
    expect(qualifyAttachmentPolicy('2026.11.2', { maxPayload: 1000, maxBufferedBytes: 2000, attachments: { maxBytes: 100, maxImageBytes: 100 } }, 'epoch', 'source')).toEqual(caps);
    expect(qualifyAttachmentPolicy('2026.11.1', { maxPayload: 1000, maxBufferedBytes: 2000, attachments: { maxBytes: 100, maxImageBytes: 100 } }, 'epoch', 'source')).toBeNull();
  });
  it('checks complete encoded JSON bytes including real ID, multibyte labels and escapes', () => {
    const value = frame(); const encoded = JSON.stringify(value); const bytes = Buffer.byteLength(encoded);
    expect(bytes).toBeGreaterThan(encoded.length);
    expect(serializeImageFollowupFrame(value, { ...caps, maxPayload: bytes, maxBufferedBytes: bytes + 17 }, 17)).toBe(encoded);
    expect(() => serializeImageFollowupFrame(value, { ...caps, maxPayload: bytes - 1 }, 0)).toThrow();
    expect(() => serializeImageFollowupFrame(value, { ...caps, maxBufferedBytes: bytes + 16 }, 17)).toThrow();
    value.id = 'a'.repeat(100);
    expect(() => serializeImageFollowupFrame(value, { ...caps, maxPayload: bytes }, 0)).toThrow();
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid live buffered byte counts: %j', buffered => {
    expect(() => serializeImageFollowupFrame(frame(), caps, buffered)).toThrow();
  });
  it('enforces the smaller decoded ceiling and canonical base64, not encoded character count', () => {
    const value = frame(); value.params.attachments[0].content = 'AQID';
    expect(serializeImageFollowupFrame(value, { ...caps, maxBytes: 3, maxImageBytes: 3 }, 0)).toContain('AQID');
    for (const limits of [{ maxBytes: 2 }, { maxImageBytes: 2 }]) expect(() => serializeImageFollowupFrame(value, { ...caps, ...limits }, 0)).toThrow();
    value.params.attachments[0].content = 'AR==';
    expect(() => serializeImageFollowupFrame(value, caps, 0)).toThrow();
  });
  it('does not serialize non-enumerable toJSON overrides outside the qualified envelope', () => {
    const value = frame();
    Object.defineProperty(value.params, 'toJSON', { value: () => ({ model: 'unapproved' }) });
    const sent = JSON.parse(serializeImageFollowupFrame(value, caps, 0));
    expect(sent.params.message).toBe('Look at 雪\n"\\');
    expect(sent.params).not.toHaveProperty('model');
  });
  it.each([
    (value: NativeImageRequestFrame) => { Object.assign(value.params, { model: 'override' }); },
    (value: NativeImageRequestFrame) => { Object.assign(value.params, { deliver: true }); },
    (value: NativeImageRequestFrame) => { Object.assign(value.params, { queueMode: 'steer' }); },
    (value: NativeImageRequestFrame) => { value.params.message = '/abort'; },
    (value: NativeImageRequestFrame) => { value.params.attachments.push(value.params.attachments[0]); },
    (value: NativeImageRequestFrame) => { Object.assign(value.params.attachments[0], { path: '/tmp/image' }); },
  ])('rejects runtime envelope widening', mutate => {
    const value = frame(); mutate(value); expect(() => serializeImageFollowupFrame(value, caps, 0)).toThrow();
  });
});
