import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS, parseAttachmentPrepareRequest, parseAttachmentConfirmRequest, parseAttachmentOperationRequest,
  parseAttachmentStatus, parseAttachmentReview, parseAttachmentReceipt } from './controlAttachments';
import { parseSendRequest } from '../server/control/validation';

const target = { agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'session-1', activeLeafEntryId: 'leaf-1' };
const image = { filename: 'test.png', mimeType: 'image/png', contentBase64: 'AAAA' };
const prepare = { target, message: 'Describe this image', image };
const operationId = 'operation-1', reviewToken = 'review-token-1';
const descriptor = { filename: 'test.png', mimeType: 'image/png', bytes: 3, width: 1, height: 1, sha256: 'a'.repeat(64) };
const review = { operationId, reviewToken, target, message: prepare.message, image: descriptor, manifestDigest: 'b'.repeat(64), expiresInMs: 300_000 };

describe('strict_image_contracts', () => {
  it('pins the approved resource ceilings', () => {
    expect(ATTACHMENT_LIMITS).toMatchObject({ maxBytes: 4_194_304, maxDimension: 8_192, maxPixels: 16_777_216,
      jpegHeaderBytes: 65_536, bodyBytes: 6_291_456, slots: 2, preparationsPerMinute: 10,
      bodyTimeoutMs: 30_000, nativeTimeoutMs: 30_000, preparedTtlMs: 300_000, receiptTtlMs: 600_000, receipts: 128 });
  });
  it('accepts one closed image, without coercion or hidden native fields', () => {
    expect(parseAttachmentPrepareRequest(prepare)).toEqual(prepare);
    for (const extra of ['bytes', 'sha256', 'path', 'url', 'mediaUrl', 'reference', 'idempotencyKey', 'deliver', 'queueMode', 'images']) {
      expect(parseAttachmentPrepareRequest({ ...prepare, [extra]: 'foreign' })).toBeNull();
      expect(parseAttachmentPrepareRequest({ ...prepare, image: { ...image, [extra]: 'foreign' } })).toBeNull();
      expect(parseAttachmentPrepareRequest({ ...prepare, target: { ...target, [extra]: 'foreign' } })).toBeNull();
    }
    for (const bad of [[], [image], null, 'path', { filename: 'x.png', mimeType: 'image/png', path: '/tmp/image' }]) {
      expect(parseAttachmentPrepareRequest({ ...prepare, image: bad })).toBeNull();
    }
    for (const key of ['__proto__', 'prototype', 'constructor']) {
      expect(parseAttachmentPrepareRequest(JSON.parse(JSON.stringify(prepare).replace('"message":', `"${key}":1,"message":`)))).toBeNull();
    }
  });
  it('requires nonempty ordinary text with the unchanged 8000-character ceiling', () => {
    expect(parseAttachmentPrepareRequest({ ...prepare, message: 'x'.repeat(8000) })).not.toBeNull();
    for (const message of ['', '  ', 'x'.repeat(8001), '/reset', '!command', 'STOP!!!', 'please stop', '\u0000/abort', '停止']) {
      expect(parseAttachmentPrepareRequest({ ...prepare, message })).toBeNull();
    }
    expect(parseSendRequest('main', { target, message: 'ordinary text', idempotencyKey: 'key-1', newConversation: false, image })).toBeNull();
  });
  it('rejects noncanonical base64 before server decoding', () => {
    for (const contentBase64 of ['', 'AA', 'AAA', 'AA=A', 'AAAA=', 'AAAA\n', '____', 'AB==', 'AAB=', 'data:image/png;base64,AAAA']) {
      expect(parseAttachmentPrepareRequest({ ...prepare, image: { ...image, contentBase64 } })).toBeNull();
    }
    for (const contentBase64 of ['AA==', 'AAA=', 'AAAA']) expect(parseAttachmentPrepareRequest({ ...prepare, image: { ...image, contentBase64 } })).not.toBeNull();
  });
  it('requires affirmative acknowledgment and only issued operation selectors', () => {
    expect(parseAttachmentConfirmRequest({ operationId, reviewToken, sharingAcknowledged: true })).toEqual({ operationId, reviewToken, sharingAcknowledged: true });
    expect(parseAttachmentConfirmRequest({ operationId, reviewToken, sharingAcknowledged: false })).toBeNull();
    for (const bad of [{ operationId, reviewToken }, { operationId, reviewToken, sharingAcknowledged: true, target }, { operationId: '', reviewToken, sharingAcknowledged: true }]) {
      expect(parseAttachmentConfirmRequest(bad)).toBeNull();
    }
    expect(parseAttachmentOperationRequest({ operationId })).toEqual({ operationId });
    expect(parseAttachmentOperationRequest({ operationId, reviewToken })).toBeNull();
    expect(parseAttachmentOperationRequest({ operationId: 'x\u0000' })).toBeNull();
  });
  it('bounds closed status/review metadata and rejects contradictory availability', () => {
    const status = { enabled: true, canPrepare: true, reason: null, epoch: 'epoch-1', maxBytes: 4096 };
    expect(parseAttachmentStatus(status)).toEqual(status);
    expect(parseAttachmentStatus({ enabled: false, canPrepare: false, reason: 'disabled', epoch: null, maxBytes: null })).not.toBeNull();
    for (const bad of [{ ...status, enabled: false }, { ...status, reason: 'unsupported' }, { ...status, epoch: null }, { ...status, maxBytes: 0 }, { ...status, maxBytes: 4_194_305 }, { ...status, extra: true }]) expect(parseAttachmentStatus(bad)).toBeNull();
    expect(parseAttachmentReview(review)).toEqual(review);
    for (const filename of ['.png', '..png', 'CON .png', 'name .png']) expect(parseAttachmentReview({ ...review, image: { ...descriptor, filename } })).toBeNull();
    for (const bad of [{ ...review, expiresInMs: 300_001 }, { ...review, manifestDigest: 'hash' }, { ...review, contentBase64: 'AAAA' }, { ...review, target: { ...target, foreign: true } }, { ...review, image: { ...descriptor, contentBase64: 'AAAA' } }, { ...review, image: { ...descriptor, width: 8193 } }, { ...review, image: { ...descriptor, width: 8192, height: 8192 } }, { ...review, image: { ...descriptor, filename: '../x.png' } }]) expect(parseAttachmentReview(bad)).toBeNull();
  });
  it('makes receipt phase and invocation evidence consistent without private payloads', () => {
    const receipt = { operationId, target, phase: 'prepared', nativeInvoked: false, imageEvidence: 'unverified' };
    expect(parseAttachmentReceipt(receipt)).toEqual(receipt);
    for (const phase of ['accepted', 'recorded', 'rejected', 'unknown']) expect(parseAttachmentReceipt({ ...receipt, phase })).toBeNull();
    expect(parseAttachmentReceipt({ ...receipt, phase: 'sending' })).not.toBeNull();
    expect(parseAttachmentReceipt({ ...receipt, nativeInvoked: true })).toBeNull();
    expect(parseAttachmentReceipt({ ...receipt, imageEvidence: 'reference-recorded' })).toBeNull();
    expect(parseAttachmentReceipt({ ...receipt, imageEvidence: 'omitted' })).toBeNull();
    expect(parseAttachmentReceipt({ ...receipt, reason: 'uploads-disabled' })).toBeNull();
    expect(parseAttachmentReceipt({ ...receipt, phase: 'recorded', nativeInvoked: true, runId: operationId, messageId: 'message-1', messageSeq: 1, imageEvidence: 'reference-recorded' })).not.toBeNull();
    for (const extra of [{ messageSeq: 0 }, { messageId: '' }, { runId: 'foreign' }]) expect(parseAttachmentReceipt({ ...receipt, phase: 'recorded', nativeInvoked: true, runId: operationId, messageId: 'message-1', messageSeq: 1, ...extra })).toBeNull();
    for (const key of ['message', 'reviewToken', 'filename', 'contentBase64']) expect(parseAttachmentReceipt({ ...receipt, [key]: 'private' })).toBeNull();
  });
});
