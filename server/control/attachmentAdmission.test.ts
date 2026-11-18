// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlTarget } from '../../shared/control';
import type { AttachmentConfirmRequest, AttachmentReceipt, AttachmentReview } from '../../shared/controlAttachments';
import { createAttachmentAdmission, type AttachmentDispatch } from './attachmentAdmission';
import { validateAttachmentPayload } from './attachmentPayload';

const target: ControlTarget = { agentId: 'main', sessionKey: 'agent:main:test', sessionId: 'session-1',
  lifecycleRevision: 'lifecycle-1', branchId: 'branch-1', activeLeafEntryId: 'leaf-1' };
const connection = { epoch: 'epoch-1', sourceKey: 'source-1', maxBytes: 4_194_304, maxImageBytes: 4_194_304,
  maxPayload: 8_388_608, maxBufferedBytes: 8_388_608 };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6w1sAAAAASUVORK5CYII=';
const payload = () => validateAttachmentPayload({ filename: 'sample.png', mimeType: 'image/png', contentBase64: png }, 4_194_304);
const confirmation = (review: AttachmentReview): AttachmentConfirmRequest => ({ operationId: review.operationId,
  reviewToken: review.reviewToken, sharingAcknowledged: true });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let now = 0;
  const admission = createAttachmentAdmission({ now: () => now });
  const prepare = (message = 'Please describe this image') => admission.prepare({ target: { ...target }, message,
    payload: payload(), connection: { ...connection }, lease: admission.acquire() });
  return { admission, prepare, advance: (ms: number) => { now += ms; } };
}
const accepted = (operation: AttachmentDispatch): AttachmentReceipt => ({ operationId: operation.review.operationId,
  target: { ...operation.review.target }, phase: 'accepted', nativeInvoked: true, imageEvidence: 'unverified', runId: operation.review.operationId });
const sendAccepted = (operation: AttachmentDispatch) => operation.attempt(async () => accepted(operation));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('duplicate_confirmation_has_one_attempt', () => {
  it('reserves before preflight awaits and invokes native send only once', async () => {
    const { admission, prepare } = fixture(); const review = prepare();
    const preflight = deferred<void>(), native = deferred<void>(); let starts = 0, sends = 0;
    const start = async (operation: AttachmentDispatch) => {
      starts++; await preflight.promise;
      return operation.attempt(async () => { sends++; await native.promise; return accepted(operation); });
    };
    const first = admission.confirm('main', confirmation(review), start);
    const second = admission.confirm('main', confirmation(review), start);
    expect(admission.read('main', review.operationId)?.receipt).toMatchObject({ phase: 'sending', nativeInvoked: false });
    await Promise.resolve(); expect(starts).toBe(1); expect(sends).toBe(0);
    preflight.resolve(); await Promise.resolve(); expect(sends).toBe(1);
    expect(admission.read('main', review.operationId)?.receipt.nativeInvoked).toBe(true);
    native.resolve(); expect(await first).toEqual(await second);
    expect((await admission.confirm('main', confirmation(review), start)).phase).toBe('accepted');
    expect(starts).toBe(1); expect(sends).toBe(1);
  });

  it('latches before synchronous callback entry and never retries thrown native work', async () => {
    const { admission, prepare } = fixture(); const review = prepare(); let sends = 0, invokedAtEntry = false;
    let secondError: unknown, nativeError: unknown;
    const result = await admission.confirm('main', confirmation(review), async operation => {
      try { await operation.attempt(async () => {
        sends++; invokedAtEntry = operation.nativeInvoked;
        try { await operation.attempt(async () => { sends++; }); } catch (error) { secondError = error; }
        throw Error('private native error');
      }); } catch (error) { nativeError = error; }
      throw Error('private dispatch error');
    });
    expect(invokedAtEntry).toBe(true); expect(secondError).toMatchObject({ message: 'attachment-changed' });
    expect(nativeError).toMatchObject({ message: 'private native error' });
    expect(result).toMatchObject({ phase: 'unknown', nativeInvoked: true });
    expect(await admission.confirm('main', confirmation(review), sendAccepted)).toEqual(result);
    expect(sends).toBe(1);
  });

  it('rejects foreign agents, tokens and changed acknowledgment even during pending work', async () => {
    const { admission, prepare } = fixture(); const review = prepare(); const wait = deferred<void>();
    const pending = admission.confirm('main', confirmation(review), async operation => { await wait.promise; return sendAccepted(operation); });
    for (const [agent, request] of [ ['other', confirmation(review)], ['main', { ...confirmation(review), reviewToken: 'foreign' }],
      ['main', { ...confirmation(review), sharingAcknowledged: false }] ] as const) {
      await expect(admission.confirm(agent, request as AttachmentConfirmRequest, sendAccepted)).rejects.toThrow();
    }
    expect(admission.read('other', review.operationId)).toBeNull();
    admission.discard('other', review.operationId);
    wait.resolve(); expect((await pending).phase).toBe('accepted');
  });

  it('discards unconfirmed bytes but cannot cancel or replay an admitted confirmation', async () => {
    const { admission, prepare } = fixture(); const discarded = prepare(); admission.discard('main', discarded.operationId);
    expect((await admission.confirm('main', confirmation(discarded), sendAccepted)).phase).toBe('not-dispatched');
    const review = prepare(); const wait = deferred<void>(); let sends = 0;
    const pending = admission.confirm('main', confirmation(review), async operation => {
      await wait.promise; return operation.attempt(async () => { sends++; return accepted(operation); });
    });
    admission.discard('main', review.operationId); wait.resolve();
    expect((await pending).phase).toBe('accepted'); expect(sends).toBe(1);
  });
});

describe('monotonic_expiry_releases_orphan_slots', () => {
  it('transfers a live receiving lease to preparing custody without restarting the body deadline or minting a review', () => {
    vi.useFakeTimers(); const { admission, advance } = fixture(); const preparing = admission.acquire();
    advance(29_999); vi.advanceTimersByTime(29_999);
    admission.beginPreparation(preparing);
    expect(vi.getTimerCount()).toBe(0);
    const receiving = admission.acquire(); advance(2); vi.advanceTimersByTime(2);
    expect(() => admission.acquire()).toThrow('rate-limited');
    // Only the unrelated, still-receiving lease retains its original deadline.
    advance(29_998); vi.advanceTimersByTime(29_998);
    const replacement = admission.acquire(); expect(() => admission.acquire()).toThrow('rate-limited');
    preparing.release(); replacement.release(); receiving.release(); admission.close();
  });

  it('does not revive expired, released, foreign or already-owned preparation leases', () => {
    const { admission, advance } = fixture(), foreign = createAttachmentAdmission();
    const expired = admission.acquire(); advance(30_000);
    expect(() => admission.beginPreparation(expired)).toThrow('attachment-expired');
    const released = admission.acquire(); released.release();
    expect(() => admission.beginPreparation(released)).toThrow('attachment-expired');
    const foreignLease = foreign.acquire();
    expect(() => admission.beginPreparation(foreignLease)).toThrow('attachment-expired');
    const preparing = admission.acquire(); admission.beginPreparation(preparing);
    expect(() => admission.beginPreparation(preparing)).toThrow('attachment-expired');
    const review = admission.prepare({ target, message: 'Read it', payload: payload(), connection, lease: preparing });
    expect(() => admission.beginPreparation(preparing)).toThrow('attachment-expired');
    admission.discard('main', review.operationId); foreignLease.release(); foreign.close(); admission.close();
    expect(() => admission.beginPreparation(expired)).toThrow('unavailable');
  });

  it('releases preparing custody idempotently and preserves staged ownership against the old finally release', () => {
    const { admission, advance } = fixture(); const released = admission.acquire(); admission.beginPreparation(released);
    released.release(); released.release(); const preparing = admission.acquire(); admission.beginPreparation(preparing);
    advance(30_001);
    const review = admission.prepare({ target, message: 'Read it', payload: payload(), connection, lease: preparing });
    preparing.release(); preparing.release(); const other = admission.acquire();
    expect(() => admission.acquire()).toThrow('rate-limited');
    admission.discard('main', review.operationId); const freed = admission.acquire(); other.release(); freed.release(); admission.close();
  });

  it('expires preparation at five minutes independently of a backwards wall clock', async () => {
    const { admission, prepare, advance } = fixture(); const review = prepare(); prepare();
    const wall = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    advance(299_999); expect(admission.read('main', review.operationId)?.receipt.phase).toBe('prepared');
    advance(1); wall.mockReturnValue(-85_400_000);
    expect(admission.read('main', review.operationId)).toBeNull();
    await expect(admission.confirm('main', confirmation(review), sendAccepted)).rejects.toThrow('attachment-expired');
    const first = admission.acquire(), second = admission.acquire(); expect(() => admission.acquire()).toThrow('rate-limited');
    first.release(); second.release();
  });

  it('releases abandoned receiving leases at the body deadline and release is idempotent', () => {
    const { admission, advance } = fixture(); const first = admission.acquire(), second = admission.acquire();
    advance(29_999); expect(() => admission.acquire()).toThrow('rate-limited');
    advance(1); const replacement = admission.acquire();
    first.release(); first.release(); second.release();
    const last = admission.acquire(); expect(() => admission.acquire()).toThrow('rate-limited');
    replacement.release(); last.release();
    expect(() => admission.prepare({ target, message: 'Read it', payload: payload(), connection, lease: first })).toThrow();
  });

  it('keeps slots through preflight and native settlement, not just the preparation deadline', async () => {
    const { admission, prepare, advance } = fixture(); const review = prepare(), other = prepare(); const wait = deferred<void>();
    const pending = admission.confirm('main', confirmation(review), operation => operation.attempt(async () => { await wait.promise; return accepted(operation); }));
    await Promise.resolve(); advance(300_001); expect(admission.read('main', other.operationId)).toBeNull();
    const receiving = admission.acquire(); expect(() => admission.acquire()).toThrow('rate-limited');
    wait.resolve(); await pending; const released = admission.acquire(); receiving.release(); released.release();
  });

  it('expires metadata after ten minutes without extending it on reads, confirms or records', async () => {
    const { admission, prepare, advance } = fixture(); const review = prepare();
    advance(100); const receipt = await admission.confirm('main', confirmation(review), sendAccepted);
    advance(599_999); expect(admission.read('main', review.operationId)?.receipt.phase).toBe('accepted');
    admission.record(receipt); await admission.confirm('main', confirmation(review), sendAccepted);
    advance(1); expect(admission.read('main', review.operationId)).toBeNull();
    expect(() => admission.record(receipt)).toThrow('attachment-expired');
  });

  it('expires invalidated preflight metadata while callbacks hang and restores bounded capacity', async () => {
    vi.useFakeTimers();
    const { admission, prepare, advance } = fixture(); const gate = deferred<void>();
    const pending: Promise<AttachmentReceipt>[] = []; const reviews: AttachmentReview[] = [];
    for (let i = 0; i < 128; i++) {
      const review = prepare(); reviews.push(review);
      pending.push(admission.confirm('main', confirmation(review), async () => { await gate.promise; throw Error('cancelled preflight'); }));
      await Promise.resolve(); admission.invalidatePrepared();
    }
    expect(() => admission.acquire()).toThrow('rate-limited'); expect(vi.getTimerCount()).toBe(1);
    advance(600_001); vi.advanceTimersByTime(600_001); expect(vi.getTimerCount()).toBe(0);
    try {
      expect(admission.read('main', reviews[0].operationId)).toBeNull();
      const lease = admission.acquire(); lease.release();
      await expect(admission.confirm('main', confirmation(reviews[0]), sendAccepted)).rejects.toThrow('attachment-expired');
    } finally { gate.resolve(); await Promise.all(pending); }
    expect(admission.read('main', reviews[0].operationId)).toBeNull(); admission.close();
  });

  it('does not restart an invalidated preflight terminal deadline when its callback settles', async () => {
    const { admission, prepare, advance } = fixture(); const review = prepare(); const gate = deferred<void>();
    const pending = admission.confirm('main', confirmation(review), async () => { await gate.promise; throw Error('cancelled preflight'); });
    await Promise.resolve(); admission.invalidatePrepared(); advance(599_999); gate.resolve();
    expect((await pending).phase).toBe('not-dispatched');
    expect(admission.read('main', review.operationId)?.receipt.phase).toBe('not-dispatched');
    advance(1); expect(admission.read('main', review.operationId)).toBeNull(); admission.close();
  });
});

describe('capacity_never_evicts_live_operation', () => {
  it('reserves only two slots across receiving and prepared states without transferred-lease bypass', () => {
    const { admission } = fixture(); const lease = admission.acquire();
    const review = admission.prepare({ target, message: 'Read it', payload: payload(), connection, lease });
    lease.release(); lease.release(); const receiving = admission.acquire();
    expect(() => admission.acquire()).toThrow('rate-limited');
    expect(() => admission.prepare({ target, message: 'Other', payload: payload(), connection, lease })).toThrow();
    admission.discard('main', review.operationId); const released = admission.acquire();
    receiving.release(); released.release();
  });

  it('refuses the 129th record rather than evicting retained or pending operations', async () => {
    const { admission, prepare } = fixture(); const first = prepare(); const gate = deferred<void>();
    const pending = admission.confirm('main', confirmation(first), operation => operation.attempt(async () => { await gate.promise; return accepted(operation); }));
    for (let i = 0; i < 127; i++) { const review = prepare(); await admission.confirm('main', confirmation(review), sendAccepted); }
    expect(() => admission.acquire()).toThrow('rate-limited');
    expect(admission.read('main', first.operationId)?.receipt.phase).toBe('sending');
    gate.resolve(); expect((await pending).phase).toBe('accepted');
  });

  it('reserves metadata capacity for receiving leases as well', async () => {
    const { admission, prepare } = fixture();
    for (let i = 0; i < 127; i++) { const review = prepare(); await admission.confirm('main', confirmation(review), sendAccepted); }
    const last = admission.acquire(); expect(() => admission.acquire()).toThrow('rate-limited');
    last.release(); const replacement = admission.acquire(); replacement.release();
  });

  it.each(['return', 'throw', 'native-rejection'] as const)('retains slots until native work settles after early callback %s', async outcome => {
    const { admission, prepare } = fixture(); const first = prepare(), second = prepare(); const native = deferred<void>();
    const dispatches: AttachmentDispatch[] = []; let starts = 0, nativeSettled = 0;
    const start = async (operation: AttachmentDispatch): Promise<AttachmentReceipt> => {
      starts++; dispatches.push(operation);
      void operation.attempt(async () => {
        await native.promise; nativeSettled++;
        if (outcome === 'native-rejection') throw Error('native request rejected');
      });
      if (outcome === 'throw') throw Error('early callback failure');
      return { operationId: operation.review.operationId, target: operation.review.target,
        phase: 'unknown', nativeInvoked: true, imageEvidence: 'unverified', runId: operation.review.operationId };
    };
    const pending = [admission.confirm('main', confirmation(first), start), admission.confirm('main', confirmation(second), start)];
    // Two turns let both callbacks finish, without settling their native promises.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const repeated = admission.confirm('main', confirmation(first), start);
    try {
      expect(starts).toBe(2); expect(nativeSettled).toBe(0);
      expect(() => admission.acquire()).toThrow('rate-limited');
      admission.discard('main', first.operationId); admission.invalidatePrepared();
      expect(() => admission.acquire()).toThrow('rate-limited');
    } finally { native.resolve(); await Promise.all([...pending, repeated]); }
    expect(nativeSettled).toBe(2); expect(starts).toBe(2);
    expect(admission.read('main', first.operationId)?.receipt.phase).toBe('unknown');
    expect(() => dispatches[0].payload).toThrow();
    const lease1 = admission.acquire(), lease2 = admission.acquire(); lease1.release(); lease2.release(); admission.close();
  });
});

describe('late_ack_cannot_downgrade_recorded_receipt', () => {
  it('preserves recorded evidence when a late native acknowledgment resolves', async () => {
    const { admission, prepare } = fixture(); const review = prepare(); const gate = deferred<void>();
    const pending = admission.confirm('main', confirmation(review), operation => operation.attempt(async () => { await gate.promise; return accepted(operation); }));
    await Promise.resolve();
    const recorded: AttachmentReceipt = { operationId: review.operationId, target, runId: review.operationId,
      phase: 'recorded', nativeInvoked: true, imageEvidence: 'reference-recorded', messageId: 'message-1', messageSeq: 7 };
    admission.record(recorded); gate.resolve(); expect(await pending).toEqual(recorded);
    for (const phase of ['accepted', 'unknown'] as const) expect(admission.record({ ...recorded, phase, imageEvidence: 'unverified' })).toEqual(recorded);
    expect(await admission.confirm('main', confirmation(review), sendAccepted)).toEqual(recorded);
  });

  it('does not renew consumed authority or trust foreign, malformed or premature evidence', async () => {
    const { admission, prepare } = fixture(); const review = prepare();
    const premature: AttachmentReceipt = { operationId: review.operationId, target, phase: 'accepted', nativeInvoked: true, imageEvidence: 'unverified' };
    expect(() => admission.record(premature)).toThrow('attachment-changed');
    const receipt = await admission.confirm('main', confirmation(review), sendAccepted);
    expect(() => admission.record({ ...receipt, target: { ...target, activeLeafEntryId: 'other' } })).toThrow();
    expect(() => admission.record({ ...receipt, phase: 'recorded' })).toThrow();
    admission.record({ ...receipt, imageEvidence: 'omitted' });
    expect(admission.record(receipt).imageEvidence).toBe('omitted');
    expect(() => admission.record({ ...receipt, phase: 'prepared', nativeInvoked: false })).toThrow('attachment-changed');
  });

  it('recording a preflight rejection consumes the prepared token and releases its slot', async () => {
    const { admission, prepare } = fixture(); const review = prepare(); let starts = 0;
    admission.record({ operationId: review.operationId, target, phase: 'not-dispatched', nativeInvoked: false, imageEvidence: 'unverified', reason: 'changed' });
    expect((await admission.confirm('main', confirmation(review), async operation => { starts++; return sendAccepted(operation); })).phase).toBe('not-dispatched');
    expect(starts).toBe(0); const first = admission.acquire(), second = admission.acquire(); first.release(); second.release();
  });

  it('does not downgrade accepted evidence or leave a settled operation permanently sending', async () => {
    const { admission, prepare } = fixture(); const review = prepare(); const receipt = await admission.confirm('main', confirmation(review), sendAccepted);
    expect(admission.record({ ...receipt, phase: 'rejected', reason: 'uploads-disabled' }).phase).toBe('accepted');
    const noSend = prepare();
    expect(await admission.confirm('main', confirmation(noSend), async operation => ({ operationId: operation.review.operationId,
      target: operation.review.target, phase: 'sending', nativeInvoked: false, imageEvidence: 'unverified' }))).toMatchObject({ phase: 'not-dispatched', nativeInvoked: false });
  });

  it.each([false, true])('binds callback receipts to the admitted identity (native invoked: %s)', async invoked => {
    const { admission, prepare } = fixture(); const foreign = prepare();
    const foreignReceipt = await admission.confirm('main', confirmation(foreign), sendAccepted);
    const current = prepare();
    const result = await admission.confirm('main', confirmation(current), async operation => {
      if (invoked) await operation.attempt(async () => {});
      return { ...foreignReceipt, imageEvidence: 'omitted' };
    });
    expect(result).toMatchObject({ operationId: current.operationId, phase: invoked ? 'unknown' : 'not-dispatched', nativeInvoked: invoked });
    expect(await admission.confirm('main', confirmation(current), sendAccepted)).toEqual(result);
    expect(admission.read('main', foreign.operationId)?.receipt).toEqual(foreignReceipt); admission.close();
  });
});

describe('old_identity_cannot_create_operation', () => {
  it('cannot import an identity into a fresh process store or revive a discarded operation', async () => {
    const { admission, prepare } = fixture(); const review = prepare(); const fresh = createAttachmentAdmission();
    await expect(fresh.confirm('main', confirmation(review), sendAccepted)).rejects.toThrow('attachment-expired');
    expect(fresh.read('main', review.operationId)).toBeNull();
    admission.discard('main', review.operationId);
    expect(admission.record({ operationId: review.operationId, target, phase: 'prepared', nativeInvoked: false, imageEvidence: 'unverified' }).phase).toBe('not-dispatched');
    expect((await admission.confirm('main', confirmation(review), sendAccepted)).phase).toBe('not-dispatched');
    fresh.close();
  });

  it('invalidates prepared and awaiting preflight work but never replays an invoked operation', async () => {
    const { admission, prepare } = fixture(); const before = prepare(), preflight = prepare(); const gate = deferred<void>(); let sends = 0;
    const pending = admission.confirm('main', confirmation(preflight), async operation => {
      await gate.promise; return operation.attempt(async () => { sends++; return accepted(operation); });
    });
    await Promise.resolve(); admission.invalidatePrepared(); gate.resolve();
    expect(await pending).toMatchObject({ phase: 'not-dispatched', reason: 'changed', nativeInvoked: false });
    expect((await admission.confirm('main', confirmation(before), sendAccepted)).phase).toBe('not-dispatched');
    expect(sends).toBe(0);
    const review = prepare(), native = deferred<void>();
    const running = admission.confirm('main', confirmation(review), operation => operation.attempt(async () => { sends++; await native.promise; return accepted(operation); }));
    await Promise.resolve(); admission.invalidatePrepared(); native.resolve(); expect((await running).phase).toBe('accepted');
    expect(sends).toBe(1);
  });

  it('close drops owned state and blocks a delayed callback or late acknowledgment from reviving it', async () => {
    const { admission, prepare } = fixture(); const review = prepare(); const gate = deferred<void>(); let dispatch!: AttachmentDispatch;
    const pending = admission.confirm('main', confirmation(review), operation => { dispatch = operation; return operation.attempt(async () => { await gate.promise; return {
      operationId: review.operationId, target, phase: 'accepted', nativeInvoked: true, imageEvidence: 'unverified' }; }); });
    await Promise.resolve(); admission.close(); admission.close(); gate.resolve();
    await expect(pending).rejects.toThrow('unavailable');
    expect(admission.read('main', review.operationId)).toBeNull(); expect(() => admission.acquire()).toThrow('unavailable');
    await expect(admission.confirm('main', confirmation(review), sendAccepted)).rejects.toThrow('unavailable');
    await expect(dispatch.attempt(async () => {})).rejects.toThrow();
    expect(() => dispatch.payload).toThrow();
  });

  it('expiry during awaited preflight revokes its delayed attempt', async () => {
    const { admission, prepare, advance } = fixture(); const review = prepare(); const gate = deferred<void>(); let sends = 0;
    const pending = admission.confirm('main', confirmation(review), async operation => {
      await gate.promise; return operation.attempt(async () => { sends++; return accepted(operation); });
    });
    await Promise.resolve(); advance(300_000); gate.resolve();
    expect(await pending).toMatchObject({ phase: 'not-dispatched', nativeInvoked: false, reason: 'expired' }); expect(sends).toBe(0);
  });

  it('owns bounded cleanup scheduling and disposes it on close', () => {
    vi.useFakeTimers(); const { admission, prepare, advance } = fixture();
    prepare(); prepare(); expect(vi.getTimerCount()).toBe(1);
    advance(300_000); vi.advanceTimersByTime(300_000);
    expect(vi.getTimerCount()).toBe(0); admission.acquire(); expect(vi.getTimerCount()).toBe(1);
    admission.close(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('immutable_manifest_and_metadata_only_retention', () => {
  it('freezes owned copies and hashes exact text, complete target, image descriptor and connection epoch', async () => {
    const { admission } = fixture(); const input = { target: { ...target }, message: '  describe\r\nthis  ', payload: payload(),
      connection: { ...connection }, lease: admission.acquire() };
    const review = admission.prepare(input);
    input.target.activeLeafEntryId = 'mutated'; input.payload.image.filename = 'mutated.png'; input.payload.contentBase64 = 'AA=='; input.connection.epoch = 'mutated';
    expect(Object.isFrozen(review)).toBe(true); expect(Object.isFrozen(review.target)).toBe(true); expect(Object.isFrozen(review.image)).toBe(true);
    expect(review.target.activeLeafEntryId).toBe('leaf-1'); expect(review.image.filename).toBe('sample.png');
    let dispatch!: AttachmentDispatch;
    const receipt = await admission.confirm('main', confirmation(review), operation => { dispatch = operation;
      expect(operation.payload.contentBase64).toBe(png); expect(Object.isFrozen(operation.payload)).toBe(true);
      expect(Object.isFrozen(operation.connection)).toBe(true); expect(operation.connection.epoch).toBe('epoch-1'); return sendAccepted(operation); });
    expect(receipt.phase).toBe('accepted');
    const meta = admission.read('main', review.operationId)!;
    expect(Object.keys(meta).sort()).toEqual(['image', 'receipt', 'sourceKey', 'submittedTextDigest']);
    expect(meta.submittedTextDigest).toBe(createHash('sha256').update('describe\r\nthis').digest('hex'));
    expect(JSON.stringify(meta)).not.toContain(input.message); expect(JSON.stringify(meta)).not.toContain(review.reviewToken); expect(JSON.stringify(meta)).not.toContain(png);
    meta.receipt.target.sessionId = 'bad'; meta.image.filename = 'bad.png';
    expect(admission.read('main', review.operationId)?.receipt.target.sessionId).toBe('session-1');
    expect(admission.read('main', review.operationId)?.image.filename).toBe('sample.png');
    expect(() => dispatch.payload).toThrow(); expect(() => dispatch.review).toThrow(); expect(() => dispatch.connection).toThrow();
  });

  it('binds every manifest field deterministically, not random identity or object key order', () => {
    type Input = { target: ControlTarget; message: string; payload: ReturnType<typeof payload>; connection: typeof connection };
    const digests = (change: (input: Input) => void) => {
      const admission = createAttachmentAdmission(); const input = { target: { ...target }, message: 'Read this', payload: payload(), connection: { ...connection } }; change(input);
      const review = admission.prepare({ ...input, lease: admission.acquire() }); admission.close(); return review;
    };
    const baseline = digests(() => {}), identical = digests(input => { input.target = { activeLeafEntryId: 'leaf-1', branchId: 'branch-1',
      lifecycleRevision: 'lifecycle-1', sessionId: 'session-1', sessionKey: 'agent:main:test', agentId: 'main' }; });
    expect(identical.manifestDigest).toBe(baseline.manifestDigest); expect(identical.operationId).not.toBe(baseline.operationId);
    expect(identical.reviewToken).not.toBe(baseline.reviewToken); expect(baseline.reviewToken).not.toBe(baseline.operationId);
    const changes = [
      (input: Input) => { input.message += ' '; },
      ...(['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'branchId', 'activeLeafEntryId'] as const).map(key => (input: { target: ControlTarget }) => { input.target[key] += '-different'; }),
      (input: { connection: typeof connection }) => { input.connection.epoch += '-different'; },
      (input: { connection: typeof connection }) => { input.connection.sourceKey += '-different'; },
      (input: { payload: ReturnType<typeof payload> }) => { input.payload.image.filename = 'different.png'; },
      (input: { payload: ReturnType<typeof payload> }) => { input.payload.image.sha256 = 'a'.repeat(64); },
      (input: { payload: ReturnType<typeof payload> }) => { input.payload.image.bytes++; },
      (input: { payload: ReturnType<typeof payload> }) => { input.payload.image.mimeType = 'image/jpeg'; input.payload.image.filename = 'sample.jpg'; },
    ];
    for (const change of changes) expect(digests(change).manifestDigest).not.toBe(baseline.manifestDigest);
  });

  it('releases large-payload authority on settlement without retaining bytes in receipts or dispatch handles', async () => {
    const { admission } = fixture(); const bytes = Buffer.alloc(4_194_304); Buffer.from(png, 'base64').copy(bytes);
    const large = validateAttachmentPayload({ filename: 'large.png', mimeType: 'image/png', contentBase64: bytes.toString('base64') }, 4_194_304);
    const review = admission.prepare({ target, message: 'Large synthetic input', payload: large, connection, lease: admission.acquire() });
    let dispatch!: AttachmentDispatch;
    const receipt = await admission.confirm('main', confirmation(review), operation => { dispatch = operation; expect(operation.payload.image.bytes).toBe(4_194_304); return sendAccepted(operation); });
    expect(receipt.phase).toBe('accepted');
    expect(Object.keys(admission.read('main', review.operationId)!)).not.toContain('payload'); expect(() => dispatch.payload).toThrow();
    const first = admission.acquire(), second = admission.acquire(); expect(() => admission.acquire()).toThrow('rate-limited'); first.release(); second.release();
  });
});
