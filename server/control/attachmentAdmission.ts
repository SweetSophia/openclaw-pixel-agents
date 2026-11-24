import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ControlTarget } from '../../shared/control';
import { ATTACHMENT_LIMITS, parseAttachmentConfirmRequest, parseAttachmentReceipt,
  type AttachmentConfirmRequest, type AttachmentImage, type AttachmentReceipt, type AttachmentReview } from '../../shared/controlAttachments';
import type { ValidatedAttachmentPayload } from './attachmentPayload';
import type { AttachmentGatewayCapabilities } from './gatewayAttachmentPolicy';
import { ControlError } from './errors';

export interface AttachmentLease { release(): void }
export interface AttachmentDispatch {
  review: Readonly<AttachmentReview>; payload: Readonly<ValidatedAttachmentPayload>; connection: Readonly<AttachmentGatewayCapabilities>;
  readonly nativeInvoked: boolean; attempt<T>(send: (markNativeInvocation: () => void) => Promise<T>): Promise<T>;
}
export interface AttachmentOperationMeta { receipt: AttachmentReceipt; sourceKey: string; image: AttachmentImage; submittedTextDigest: string }
interface Preparation { target: ControlTarget; message: string; payload: ValidatedAttachmentPayload; connection: AttachmentGatewayCapabilities; lease: AttachmentLease }
export interface AttachmentAdmission {
  acquire(): AttachmentLease; beginPreparation(lease: AttachmentLease): void; prepare(input: Preparation): AttachmentReview;
  confirm(agentId: string, request: AttachmentConfirmRequest, start: (operation: AttachmentDispatch) => Promise<AttachmentReceipt>): Promise<AttachmentReceipt>;
  read(agentId: string, operationId: string): AttachmentOperationMeta | null;
  record(receipt: AttachmentReceipt): AttachmentReceipt; discard(agentId: string, operationId: string): void;
  invalidatePrepared(): void; close(): void;
}

interface LeaseState { expires: number; preparing?: boolean; operationId?: string }
interface Staged {
  review: AttachmentReview; payload: ValidatedAttachmentPayload; connection: AttachmentGatewayCapabilities; lease: AttachmentLease;
}
interface Operation {
  meta: AttachmentOperationMeta; tokenDigest: Buffer; expires: number; staged?: Staged;
  invoked: boolean; attempted: boolean; pending?: Promise<AttachmentReceipt>; attempt?: Promise<void>;
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const tokenHash = (token: string): Buffer => createHash('sha256').update(token).digest();
const copyReceipt = (receipt: AttachmentReceipt): AttachmentReceipt => ({ ...receipt, target: { ...receipt.target } });
function copyTarget(target: ControlTarget): ControlTarget {
  return { agentId: target.agentId, sessionKey: target.sessionKey, sessionId: target.sessionId,
    ...(target.lifecycleRevision === undefined ? {} : { lifecycleRevision: target.lifecycleRevision }),
    ...(target.branchId === undefined ? {} : { branchId: target.branchId }),
    ...(target.activeLeafEntryId === undefined ? {} : { activeLeafEntryId: target.activeLeafEntryId }) };
}
const targetIdentity = (target: ControlTarget) => [target.agentId, target.sessionKey, target.sessionId,
  target.lifecycleRevision ?? null, target.branchId ?? null, target.activeLeafEntryId ?? null];
const ranks: Record<AttachmentReceipt['phase'], number> = { prepared: 0, sending: 1, 'not-dispatched': 2, unknown: 2, accepted: 3, rejected: 3, recorded: 4 };

export function createAttachmentAdmission(options?: { now?: () => number }): AttachmentAdmission {
  const now = options?.now ?? (() => performance.now());
  const leases = new Map<AttachmentLease, LeaseState>(), operations = new Map<string, Operation>();
  let closed = false, cleanup: ReturnType<typeof setTimeout> | undefined;
  function open(): void { if (closed) throw new ControlError('unavailable'); }
  function schedule(): void {
    if (cleanup !== undefined) clearTimeout(cleanup);
    cleanup = undefined;
    if (closed) return;
    let deadline = Infinity;
    for (const row of operations.values()) if (!row.staged || !row.pending || !row.attempted) deadline = Math.min(deadline, row.expires);
    for (const row of leases.values()) if (!row.operationId && !row.preparing) deadline = Math.min(deadline, row.expires);
    if (deadline !== Infinity) {
      cleanup = setTimeout(prune, Math.max(1, deadline - now())); cleanup.unref?.();
    }
  }
  function dropStaged(row: Operation): void {
    if (row.staged) leases.delete(row.staged.lease);
    row.staged = undefined;
  }
  function stopPrepared(row: Operation, reason: 'changed' | 'expired' = 'changed'): void {
    row.meta.receipt = { operationId: row.meta.receipt.operationId, target: row.meta.receipt.target,
      phase: 'not-dispatched', nativeInvoked: false, imageEvidence: 'unverified', reason };
    dropStaged(row); row.expires = now() + ATTACHMENT_LIMITS.receiptTtlMs;
  }
  // Both collections are bounded; receiving leases have their own shorter deadline.
  function prune(): void {
    const time = now();
    for (const [id, row] of operations) if (row.expires <= time) {
      if (!row.pending || !row.staged) { dropStaged(row); operations.delete(id); }
      else if (row.staged && !row.attempted) stopPrepared(row, 'expired');
    }
    for (const [lease, state] of leases) if (!state.operationId && !state.preparing && state.expires <= time) leases.delete(lease);
    schedule();
  }
  function acquire(): AttachmentLease {
    open(); prune();
    const unstaged = [...leases.values()].filter(row => !row.operationId).length;
    if (leases.size >= ATTACHMENT_LIMITS.slots || operations.size + unstaged >= ATTACHMENT_LIMITS.receipts) throw new ControlError('rate-limited');
    const lease: AttachmentLease = Object.freeze({ release() {
      // Successful preparation transfers the lease to the store. A request's finally
      // cannot release a slot while its staged image or native request still owns it.
      if (!leases.get(lease)?.operationId) { leases.delete(lease); schedule(); }
    } });
    leases.set(lease, { expires: now() + ATTACHMENT_LIMITS.bodyTimeoutMs }); schedule(); return lease;
  }
  function beginPreparation(lease: AttachmentLease): void {
    open(); prune(); const state = leases.get(lease);
    if (!state || state.operationId || state.preparing) throw new ControlError('attachment-expired');
    // Body reception is finished. The service now owns this counted slot until
    // it stages a verified review or releases custody; the deadline is unchanged.
    state.preparing = true; schedule();
  }
  function prepare(input: Preparation): AttachmentReview {
    open(); prune(); const state = leases.get(input.lease);
    if (!state || state.operationId) throw new ControlError('attachment-expired');
    const target = Object.freeze(copyTarget(input.target));
    const descriptor = input.payload.image;
    const image = Object.freeze({ filename: descriptor.filename, mimeType: descriptor.mimeType, bytes: descriptor.bytes,
      width: descriptor.width, height: descriptor.height, sha256: descriptor.sha256 });
    const connection = Object.freeze({ epoch: input.connection.epoch, sourceKey: input.connection.sourceKey,
      maxBytes: input.connection.maxBytes, maxImageBytes: input.connection.maxImageBytes,
      maxPayload: input.connection.maxPayload, maxBufferedBytes: input.connection.maxBufferedBytes });
    const operationId = randomUUID(), reviewToken = randomBytes(32).toString('hex');
    const manifestDigest = hash(JSON.stringify(['attachment-manifest-v1', targetIdentity(target), connection.epoch, connection.sourceKey,
      input.message, image.filename, image.mimeType, image.bytes, image.width, image.height, image.sha256]));
    const review = Object.freeze({ operationId, reviewToken, target, message: input.message, image, manifestDigest, expiresInMs: ATTACHMENT_LIMITS.preparedTtlMs });
    const payload = Object.freeze({ contentBase64: input.payload.contentBase64, image });
    const row: Operation = { meta: { receipt: { operationId, target, phase: 'prepared', nativeInvoked: false, imageEvidence: 'unverified' },
      image, sourceKey: connection.sourceKey, submittedTextDigest: hash(input.message.trim()) },
      tokenDigest: tokenHash(reviewToken), expires: now() + ATTACHMENT_LIMITS.preparedTtlMs,
      invoked: false, attempted: false, staged: { review, payload, connection, lease: input.lease } };
    operations.set(operationId, row); state.operationId = operationId; schedule(); return review;
  }
  function read(agentId: string, operationId: string): AttachmentOperationMeta | null {
    prune(); const row = operations.get(operationId);
    if (!row || row.meta.receipt.target.agentId !== agentId) return null;
    return { receipt: copyReceipt(row.meta.receipt), sourceKey: row.meta.sourceKey,
      image: { ...row.meta.image }, submittedTextDigest: row.meta.submittedTextDigest };
  }
  function record(receipt: AttachmentReceipt): AttachmentReceipt {
    open(); prune(); const row = operations.get(receipt.operationId);
    if (!row) throw new ControlError('attachment-expired');
    const parsed = parseAttachmentReceipt(receipt), previous = row.meta.receipt;
    if (!parsed || JSON.stringify(targetIdentity(parsed.target)) !== JSON.stringify(targetIdentity(previous.target))
      || parsed.nativeInvoked !== row.invoked) throw new ControlError('attachment-changed');
    const preserve = ranks[parsed.phase] < ranks[previous.phase] || previous.phase === 'recorded'
      || previous.phase === 'not-dispatched' || previous.phase === 'rejected'
      || (previous.phase === 'accepted' && parsed.phase === 'rejected');
    const next = preserve ? copyReceipt(previous) : parsed;
    if (previous.imageEvidence !== 'unverified') next.imageEvidence = previous.imageEvidence;
    else if (parsed.imageEvidence !== 'unverified') next.imageEvidence = parsed.imageEvidence;
    row.meta.receipt = next;
    if (next.phase === 'not-dispatched' && row.staged) {
      dropStaged(row); row.expires = now() + ATTACHMENT_LIMITS.receiptTtlMs;
    }
    schedule(); return copyReceipt(next);
  }
  function staged(row: Operation): Staged {
    open(); prune(); if (!row.staged) throw new ControlError('attachment-changed'); return row.staged;
  }
  function dispatch(row: Operation): AttachmentDispatch {
    return Object.freeze({
      get review() { return staged(row).review; }, get payload() { return staged(row).payload; },
      get connection() { return staged(row).connection; }, get nativeInvoked() { return row.invoked; },
      attempt<T>(send: (markNativeInvocation: () => void) => Promise<T>): Promise<T> {
        try {
          staged(row);
          if (row.attempted) throw new ControlError('attachment-changed');
          row.attempted = true;
          schedule();
          const markNativeInvocation = () => {
            staged(row);
            if (row.invoked) throw new ControlError('attachment-changed');
            row.invoked = true;
            row.meta.receipt = { ...row.meta.receipt, nativeInvoked: true, runId: row.meta.receipt.operationId };
            schedule();
          };
          let native: Promise<T>;
          try { native = Promise.resolve(send(markNativeInvocation)); } catch (error) { native = Promise.reject(error); }
          // Track settlement without retaining its value/error. This also observes
          // rejection when a callback returns early without awaiting its attempt.
          row.attempt = native.then(() => undefined, () => undefined);
          return native;
        } catch (error) { return Promise.reject(error); }
      },
    });
  }
  function confirm(agentId: string, request: AttachmentConfirmRequest,
    start: (operation: AttachmentDispatch) => Promise<AttachmentReceipt>): Promise<AttachmentReceipt> {
    try {
      open(); prune(); const parsed = parseAttachmentConfirmRequest(request);
      if (!parsed) throw new ControlError('invalid-request');
      const row = operations.get(parsed.operationId);
      if (!row) throw new ControlError('attachment-expired');
      if (row.meta.receipt.target.agentId !== agentId || !timingSafeEqual(row.tokenDigest, tokenHash(parsed.reviewToken))) throw new ControlError('attachment-changed');
      if (row.pending) return row.pending.then(copyReceipt);
      if (!row.staged) return Promise.resolve(copyReceipt(row.meta.receipt));
      row.meta.receipt = { ...row.meta.receipt, phase: 'sending' };
      // Install the shared promise before any caller-controlled work can run.
      row.pending = Promise.resolve().then(async () => {
        try {
          open();
          if (row.staged) {
            const receipt = await start(dispatch(row));
            if (receipt.operationId !== row.meta.receipt.operationId || receipt.phase === 'prepared' || receipt.phase === 'sending') throw new ControlError('attachment-changed');
            record(receipt);
          }
        } catch {
          open();
          if (row.staged) record({ operationId: row.meta.receipt.operationId, target: row.meta.receipt.target,
            phase: row.invoked ? 'unknown' : 'not-dispatched', nativeInvoked: row.invoked, imageEvidence: 'unverified',
            ...(row.invoked ? { runId: row.meta.receipt.operationId } : { reason: 'unavailable' }) });
        } finally {
          await row.attempt;
          if (row.staged) { dropStaged(row); row.expires = now() + ATTACHMENT_LIMITS.receiptTtlMs; }
          row.pending = undefined;
          schedule();
        }
        open(); return copyReceipt(row.meta.receipt);
      });
      return row.pending.then(copyReceipt);
    } catch (error) { return Promise.reject(error); }
  }
  function discard(agentId: string, operationId: string): void {
    prune(); const row = operations.get(operationId);
    if (row?.meta.receipt.target.agentId === agentId && row.staged && !row.pending) { stopPrepared(row); schedule(); }
  }
  function invalidatePrepared(): void {
    prune(); for (const row of operations.values()) if (row.staged && !row.attempted) stopPrepared(row); schedule();
  }
  function close(): void {
    if (closed) return; closed = true;
    if (cleanup !== undefined) clearTimeout(cleanup); cleanup = undefined;
    for (const row of operations.values()) dropStaged(row);
    operations.clear(); leases.clear();
  }
  return { acquire, beginPreparation, prepare, confirm, read, record, discard, invalidatePrepared, close };
}
