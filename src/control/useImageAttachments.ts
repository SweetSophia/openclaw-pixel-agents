import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { controlRecord, isControlCommand, parseControlTarget, type ControlTarget } from '../../shared/control';
import { ATTACHMENT_LIMITS, parseAttachmentReceipt, parseAttachmentReview, parseAttachmentStatus, type AttachmentImage, type AttachmentReceipt, type AttachmentReview, type AttachmentStatus } from '../../shared/controlAttachments';
import { inspectAttachmentImage, normalizeAttachmentFilename } from '../../shared/imageAttachment';
import { useAttachmentOperations, useControlAccess, type AttachmentClientOperation } from './ControlAccess';
import { ControlApiError, targetIdentity } from './api';

export interface AttachmentForm {
  status: AttachmentStatus | null; selection: Omit<AttachmentImage, 'sha256'> | null;
  review: AttachmentReview | null; receipt: AttachmentReceipt | null; originalTarget: ControlTarget | null;
  phase: 'idle' | 'reading' | 'preparing' | 'review' | 'confirming' | 'accepted' | 'recorded' | 'not-dispatched' | 'rejected' | 'unknown';
  disabledReason: string; error: string; pending: boolean;
  select(file: File | null): Promise<void>; prepare(): Promise<void>; confirm(sharingAcknowledged: boolean): Promise<void>;
  check(): Promise<void>; remove(): void;
}
interface Options {
  agentId: string; target: ControlTarget | null; active: boolean; readOnly: boolean; isNew: boolean;
  intent: 'followup' | 'steer'; message: string; textPending: boolean; onRecorded(submittedMessage: string): void;
}
interface Local {
  owner: string; status: AttachmentStatus | null; selection: AttachmentForm['selection']; review: AttachmentReview | null;
  phase: 'idle' | 'reading' | 'preparing' | 'review'; error: string; expiresAt: number;
}
const empty = (owner: string, status: AttachmentStatus | null = null): Local => ({ owner, status, selection: null, review: null, phase: 'idle', error: '', expiresAt: 0 });
const listeners = new WeakMap<Map<string, AttachmentClientOperation>, Set<() => void>>();
const unresolved = (operation?: AttachmentClientOperation) => !!operation && ['confirming', 'unknown', 'accepted'].includes(operation.phase);
const exactTarget = (left: ControlTarget, right: ControlTarget) => targetIdentity(left) === targetIdentity(right) && left.activeLeafEntryId === right.activeLeafEntryId;
const path = (agentId: string, action: string) => `/api/control/agents/${encodeURIComponent(agentId)}/attachments/${action}`;
const ordinary = (message: string) => !!message.trim() && message.length <= ATTACHMENT_LIMITS.message && !isControlCommand(message);
function imageError(error: unknown, admitted = false): string {
  if (admitted && error instanceof ControlApiError && error.code === 'attachment-changed')
    return 'This image review changed. Check the original submission.';
  if (error instanceof ControlApiError && error.code.startsWith('attachment-')) return error.message;
  return 'The private image request could not be verified. No replacement submission is sent automatically.';
}
function freezeReview(review: AttachmentReview): AttachmentReview {
  Object.freeze(review.target); Object.freeze(review.image); return Object.freeze(review);
}

export function useImageAttachments(options: Options): AttachmentForm {
  const access = useControlAccess(); const operations = useAttachmentOperations();
  const target = options.target ? parseControlTarget(options.target) : null;
  const operationKey = target ? JSON.stringify([access.generation, targetIdentity(target)]) : '';
  const owner = JSON.stringify([access.generation, options.agentId, target, options.active, options.readOnly, options.isNew, options.intent]);
  const readable = options.active && !options.readOnly && !options.isNew && options.intent === 'followup' && !!target
    && target.agentId === options.agentId && !!target.activeLeafEntryId && access.state === 'unlocked' && access.status?.canRead === true;
  const enabled = readable && access.status?.canSend === true;
  const [local, render] = useState(() => empty(owner)); const data = useRef(local); const [, redraw] = useState(0);
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const mounted = useRef(false); const version = useRef(0); const content = useRef<string | null>(null);
  const frozen = useRef<{ operationId: string; message: string; notified: boolean } | null>(null);
  const localOperation = useRef<{ key: string; admitted: AttachmentClientOperation } | null>(null);
  const reviewGeneration = useRef<number | null>(null);
  const reads = useRef(new Set<AbortController>()); const checking = useRef(false);
  const context = useRef({ options, access, target, operationKey, owner, readable, enabled });
  context.current = { options, access, target, operationKey, owner, readable, enabled };
  const update = useCallback((value: Local) => { data.current = value; if (mounted.current) render(value); }, []);
  const notify = useCallback(() => { listeners.get(operations)?.forEach(listener => listener()); }, [operations]);
  const currentGeneration = (generation: number) => access.isCurrentGeneration(generation);
  const readPermitted = () => mounted.current && context.current.readable && document.visibilityState !== 'hidden'
    && context.current.access.isCurrentGeneration(context.current.access.generation);
  const permitted = () => context.current.enabled && readPermitted();
  const sameRead = (captured: string, token: number) => readPermitted() && context.current.owner === captured && version.current === token;
  const same = (captured: string, token: number) => context.current.enabled && sameRead(captured, token);
  const discard = useCallback((agentId: string, operationId: string, generation: number) => {
    access.discardAttachmentPreparation(agentId, operationId, generation);
  }, [access.discardAttachmentPreparation]);
  const clear = useCallback((keepStatus = false) => {
    version.current++; content.current = null; frozen.current = null;
    for (const read of reads.current) read.abort(); reads.current.clear(); checking.current = false;
    const state = data.current; const current = context.current; const pending = localOperation.current;
    if (state.review && reviewGeneration.current !== null) discard(state.review.target.agentId, state.review.operationId, reviewGeneration.current);
    if (pending && operations.get(pending.key) === pending.admitted && pending.admitted.phase === 'confirming') { pending.admitted.phase = 'unknown'; notify(); }
    localOperation.current = null; reviewGeneration.current = null;
    update(empty(current.owner, keepStatus && state.owner === current.owner ? state.status : null));
  }, [discard, notify, operations, update]);
  useLayoutEffect(() => {
    mounted.current = true; clear();
    const unsubscribe = access.onInvalidate(() => clear());
    return () => { unsubscribe(); mounted.current = false; clear(); };
  }, [owner, readable, enabled, access.onInvalidate, clear]);
  useLayoutEffect(() => {
    let entries = listeners.get(operations);
    if (!entries) { entries = new Set(); listeners.set(operations, entries); }
    const listener = () => redraw(value => value + 1); entries.add(listener);
    return () => { entries.delete(listener); if (!entries.size) listeners.delete(operations); };
  }, [operations]);
  useEffect(() => {
    const change = () => { if (document.visibilityState === 'hidden') clear(); setVisible(document.visibilityState !== 'hidden'); };
    document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change);
  }, [clear]);
  useEffect(() => {
    if (!enabled || !visible || !permitted()) return;
    const current = context.current; const token = version.current; const controller = new AbortController(); reads.current.add(controller);
    void current.access.request(path(current.options.agentId, 'status'), { signal: controller.signal }).then(value => {
      if (!same(current.owner, token) || controller.signal.aborted) return;
      const status = parseAttachmentStatus(value); if (!status) throw new ControlApiError('invalid-source');
      update({ ...data.current, status, error: '' });
    }).catch(error => { if (same(current.owner, token) && !controller.signal.aborted) update({ ...data.current, error: imageError(error) }); })
      .finally(() => { reads.current.delete(controller); });
    return () => { controller.abort(); reads.current.delete(controller); };
  }, [owner, enabled, visible, access.request, update]);
  useEffect(() => {
    if (!local.review || !local.expiresAt) return;
    const review = local.review;
    const timer = setTimeout(() => {
      if (data.current.review !== review) return;
      clear(true); update({ ...data.current, error: 'This image review expired. Select an image and explicitly review a new submission.' });
    }, Math.max(0, local.expiresAt - performance.now()));
    return () => clearTimeout(timer);
  }, [local.review, local.expiresAt, clear, update]);

  const select = useCallback(async (file: File | null) => {
    if (!permitted() || unresolved(operations.get(context.current.operationKey))) return;
    if (file && !data.current.status?.canPrepare) return;
    clear(true);
    const current = context.current; operations.delete(current.operationKey); notify();
    if (!file || !data.current.status?.canPrepare) return;
    const token = version.current;
    if (!file.size || file.size > Math.min(ATTACHMENT_LIMITS.maxBytes, data.current.status.maxBytes ?? 0)) {
      update({ ...data.current, error: 'Choose one nonempty PNG or JPEG within the displayed image byte limit.' }); return;
    }
    update({ ...data.current, phase: 'reading' });
    try {
      const buffer = await file.arrayBuffer();
      if (!same(current.owner, token)) return;
      const bytes = new Uint8Array(buffer);
      if (bytes.byteLength !== file.size) throw new ControlApiError('invalid-source');
      const detected = inspectAttachmentImage(bytes);
      // Chunk conversion avoids an argument-list overflow at the 4 MiB ceiling.
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      content.current = btoa(binary);
      update({ ...data.current, phase: 'idle', selection: { ...detected, filename: normalizeAttachmentFilename(file.name, detected.mimeType), bytes: bytes.length }, error: '' });
    } catch {
      if (same(current.owner, token)) { content.current = null; update({ ...data.current, phase: 'idle', selection: null, error: 'Choose a valid PNG or JPEG image within the supported dimensions and byte limit.' }); }
    }
  }, [clear, notify, operations, update]);

  const prepare = useCallback(async () => {
    const current = context.current; const state = data.current; const selection = state.selection;
    if (!permitted() || state.owner !== current.owner || current.options.textPending || !ordinary(current.options.message)
      || !state.status?.canPrepare || unresolved(operations.get(current.operationKey)) || !selection || !content.current || state.phase !== 'idle' || !current.target) return;
    const token = version.current; const controller = new AbortController(); reads.current.add(controller);
    const started = performance.now(); update({ ...state, phase: 'preparing', error: '' });
    try {
      const value = await current.access.request(path(current.options.agentId, 'prepare'), { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ target: current.target, message: current.options.message, image: { filename: selection.filename, mimeType: selection.mimeType, contentBase64: content.current } }) });
      const review = parseAttachmentReview(value);
      const valid = !!review && exactTarget(review.target, current.target) && review.message === current.options.message
        && review.image.filename === selection.filename && review.image.mimeType === selection.mimeType && review.image.bytes === selection.bytes
        && review.image.width === selection.width && review.image.height === selection.height;
      if (!same(current.owner, token) || controller.signal.aborted) {
        if (valid) discard(review.target.agentId, review.operationId, current.access.generation);
        return;
      }
      if (!valid) throw new ControlApiError('invalid-source');
      const expiresAt = started + review.expiresInMs;
      if (performance.now() >= expiresAt) { discard(review.target.agentId, review.operationId, current.access.generation); throw new ControlApiError('attachment-expired'); }
      // The server now owns preparation bytes. Only the immutable metadata review stays local.
      content.current = null;
      reviewGeneration.current = current.access.generation;
      update({ ...data.current, phase: 'review', review: freezeReview(review), expiresAt, error: '' });
    } catch (error) {
      if (same(current.owner, token) && !controller.signal.aborted) update({ ...data.current, phase: 'idle', error: imageError(error) });
    } finally { reads.current.delete(controller); }
  }, [discard, operations, update]);

  const settle = (key: string, admitted: AttachmentClientOperation, value: unknown) => {
    const receipt = parseAttachmentReceipt(value);
    if (!receipt || receipt.operationId !== admitted.operationId || !exactTarget(receipt.target, admitted.target)) throw new ControlApiError('invalid-source');
    if (!currentGeneration(admitted.generation) || operations.get(key) !== admitted) return;
    if (['recorded', 'rejected', 'not-dispatched'].includes(admitted.phase) || (admitted.receipt?.nativeInvoked && !receipt.nativeInvoked)
      || (admitted.phase === 'accepted' && ['unknown', 'sending'].includes(receipt.phase))) return;
    admitted.receipt = receipt;
    // Prepared is only an observation: the admitted confirmation may still reach the server.
    admitted.phase = receipt.phase === 'sending' || receipt.phase === 'prepared' ? 'unknown' : receipt.phase;
    if (['rejected', 'not-dispatched'].includes(receipt.phase)) frozen.current = null;
    notify();
    if (['accepted', 'recorded', 'rejected', 'not-dispatched'].includes(receipt.phase)
      && context.current.operationKey === key && data.current.owner === context.current.owner && data.current.error) update({ ...data.current, error: '' });
    const original = frozen.current;
    if (permitted() && context.current.operationKey === key && original?.operationId === admitted.operationId && !original.notified && receipt.phase === 'recorded') {
      original.notified = true; context.current.options.onRecorded(original.message); frozen.current = null;
    }
    return receipt;
  };
  const confirm = useCallback(async (review: AttachmentReview | null, sharingAcknowledged: boolean) => {
    const current = context.current; const state = data.current;
    if (!review || review !== state.review || !sharingAcknowledged || !permitted() || current.options.textPending || !state.status?.canPrepare
      || state.owner !== current.owner || state.phase !== 'review' || performance.now() >= state.expiresAt || unresolved(operations.get(current.operationKey))) return;
    const token = version.current;
    const admitted: AttachmentClientOperation = { operationId: review.operationId, target: Object.freeze({ ...review.target }), generation: current.access.generation, phase: 'confirming' };
    // Latch uncertainty before entering the network. Remounts retain this metadata, never the token/text/bytes.
    operations.set(current.operationKey, admitted); notify();
    localOperation.current = { key: current.operationKey, admitted }; reviewGeneration.current = null;
    frozen.current = { operationId: review.operationId, message: review.message, notified: false };
    content.current = null; update({ ...empty(current.owner, state.status) });
    try {
      const value = await current.access.request(path(review.target.agentId, 'confirm'), { method: 'POST',
        body: JSON.stringify({ operationId: review.operationId, reviewToken: review.reviewToken, sharingAcknowledged: true }) });
      settle(current.operationKey, admitted, value);
    } catch (error) {
      if (currentGeneration(admitted.generation) && operations.get(current.operationKey) === admitted && admitted.phase === 'confirming') { admitted.phase = 'unknown'; notify(); }
      if (sameRead(current.owner, token) && operations.get(current.operationKey) === admitted && admitted.phase === 'unknown') update({ ...data.current, error: imageError(error, true) });
    }
  }, [operations, notify, update]);
  const check = useCallback(async () => {
    const current = context.current; const admitted = operations.get(current.operationKey);
    if (!readPermitted() || !admitted || admitted.generation !== current.access.generation || checking.current) return;
    checking.current = true;
    const controller = new AbortController(); reads.current.add(controller); const token = version.current;
    const ownsCheck = () => sameRead(current.owner, token) && !controller.signal.aborted && operations.get(current.operationKey) === admitted;
    try {
      const value = await current.access.request(path(admitted.target.agentId, 'receipt'), { method: 'POST', signal: controller.signal, body: JSON.stringify({ operationId: admitted.operationId }) });
      if (!ownsCheck()) return;
      const observed = settle(current.operationKey, admitted, value);
      if (observed?.phase !== 'prepared' || !ownsCheck()) return;
      // Cleanup discard is best-effort elsewhere. Recovery requires acknowledgment AND a fresh terminal receipt.
      const discarded = await current.access.request(path(admitted.target.agentId, 'discard'), { method: 'POST', signal: controller.signal, body: JSON.stringify({ operationId: admitted.operationId }) });
      if (!ownsCheck()) return;
      const acknowledgment = controlRecord(discarded);
      if (!acknowledgment || Object.keys(acknowledgment).length !== 1 || acknowledgment.ok !== true) throw new ControlApiError('invalid-source');
      const proof = await current.access.request(path(admitted.target.agentId, 'receipt'), { method: 'POST', signal: controller.signal, body: JSON.stringify({ operationId: admitted.operationId }) });
      if (ownsCheck()) settle(current.operationKey, admitted, proof);
    } catch (error) {
      if (currentGeneration(admitted.generation) && operations.get(current.operationKey) === admitted && admitted.phase === 'confirming') { admitted.phase = 'unknown'; notify(); }
      if (ownsCheck()) update({ ...data.current, error: imageError(error, true) });
    } finally { reads.current.delete(controller); if (!controller.signal.aborted) checking.current = false; }
  }, [operations, notify]);
  const displayed = enabled && visible && local.owner === owner && access.isCurrentGeneration(access.generation) ? local : empty(owner);
  const admitted = access.isCurrentGeneration(access.generation) ? operations.get(operationKey) : undefined;
  const phase = admitted?.phase ?? displayed.phase;
  const disabledReason = !enabled || !visible ? 'Images require unlocked, writable live follow-up access to an existing verified conversation.'
    : options.textPending ? 'An ordinary text submission is still pending. Settle it before preparing or confirming an image.'
      : unresolved(admitted) ? 'Check the original image submission. Another image or replacement submission is blocked.'
        : admitted?.phase === 'rejected' ? 'The native image upload was rejected. Other task panels remain available.'
          : displayed.error || (!displayed.status?.canPrepare ? 'Image sending is unavailable for this connection.'
            : !ordinary(displayed.review?.message ?? options.message) ? 'An image requires nonempty ordinary follow-up text of at most 8,000 characters, not commands.' : '');
  return { status: displayed.status, selection: displayed.selection, review: displayed.review, receipt: admitted?.receipt ?? null, originalTarget: admitted?.target ?? null, phase,
    disabledReason, error: displayed.error, pending: unresolved(admitted) || ['reading', 'preparing'].includes(displayed.phase), select, prepare,
    confirm: acknowledged => confirm(displayed.review, acknowledged), check, remove: () => clear(true) };
}
