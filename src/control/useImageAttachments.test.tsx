import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlTarget } from '../../shared/control';
import type { AttachmentReceipt, AttachmentReview } from '../../shared/controlAttachments';
import { ControlAccessProvider, useAttachmentOperations, useControlAccess, useConversationDrafts, type ControlAccess } from './ControlAccess';
import { useImageAttachments, type AttachmentForm } from './useImageAttachments';

const target: ControlTarget = { agentId: 'main', sessionKey: 'agent:main:one', sessionId: 'one', lifecycleRevision: 'life-1', branchId: 'branch-1', activeLeafEntryId: 'leaf-1' };
const capability = { enabled: true, canPrepare: true, reason: null, epoch: 'epoch-1', maxBytes: 4_194_304 };
const privateStatus = { configured: true, state: 'ready', canRead: true, canSend: true };
const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function image(read = async () => bytes.slice().buffer) {
  const file = new File([bytes], 'photo.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: read }); return file;
}
function review(message = 'original text', selected = target): AttachmentReview {
  return { operationId: 'image-op-1', reviewToken: 'private-review-token', target: { ...selected }, message,
    image: { filename: 'photo.png', mimeType: 'image/png', bytes: 33, width: 1, height: 1, sha256: 'a'.repeat(64) }, manifestDigest: 'b'.repeat(64), expiresInMs: 300_000 };
}
function receipt(phase: AttachmentReceipt['phase'] = 'unknown', selected = target): AttachmentReceipt {
  return { operationId: 'image-op-1', target: { ...selected }, phase, nativeInvoked: !['prepared', 'not-dispatched'].includes(phase), imageEvidence: 'unverified',
    ...(phase === 'recorded' ? { runId: 'image-op-1', messageId: 'message-1', messageSeq: 1 } : {}) };
}
type Options = Parameters<typeof useImageAttachments>[0];
let form: AttachmentForm; let access: ControlAccess; let operations: ReturnType<typeof useAttachmentOperations>; let drafts: Map<string, unknown>;
let options: Options; let fetcher: ReturnType<typeof vi.fn>; let requests: { path: string; init: RequestInit }[];
let respond: (path: string, init: RequestInit) => Response | Promise<Response>;
function Access() { access = useControlAccess(); operations = useAttachmentOperations(); drafts = useConversationDrafts()!; return null; }
function Form({ options: selected }: { options: Options }) { form = useImageAttachments(selected); return null; }
function Tree({ show = true, selected = options }: { show?: boolean; selected?: Options }) { return <ControlAccessProvider><Access />{show && <Form options={selected} />}</ControlAccessProvider>; }
async function setup() {
  const view = render(<Tree />); await act(() => access.unlock('synthetic-key'));
  await waitFor(() => expect(form.status?.canPrepare).toBe(true)); return view;
}
async function prepare() { await act(() => form.select(image())); await act(() => form.prepare()); expect(form.phase).toBe('review'); }
const count = (action: string) => requests.filter(row => row.path.endsWith(`/attachments/${action}`)).length;
beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  requests = []; options = { agentId: 'main', target, active: true, readOnly: false, isNew: false, intent: 'followup', message: 'original text', textPending: false, onRecorded: vi.fn() };
  respond = path => path.endsWith('/status') ? json(path.includes('/attachments/') ? capability : privateStatus)
    : path.endsWith('/prepare') ? json(review()) : path.endsWith('/discard') ? json({ ok: true }) : json(receipt());
  fetcher = vi.fn((path: string, init: RequestInit) => { requests.push({ path, init }); return respond(path, init); }); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });

describe('private image follow-up state', () => {
  it('lock_clears_image_not_late_restore', async () => {
    await setup(); const read = deferred<ArrayBuffer>(); let selected!: Promise<void>;
    act(() => { selected = form.select(image(() => read.promise)); }); expect(form.phase).toBe('reading');
    const oldPrepare = form.prepare;
    act(() => { access.lock(); void oldPrepare(); });
    await act(async () => { read.resolve(bytes.slice().buffer); await selected; });
    expect(form.selection).toBeNull(); expect(form.review).toBeNull(); expect(form.phase).toBe('idle'); expect(count('prepare')).toBe(0);
  });
  it('Lock sends a staged-review discard with the retiring key without aborting it', async () => {
    await setup(); await prepare();
    const reply = deferred<Response>();
    respond = path => path.endsWith('/discard') ? reply.promise : json({ ok: true });
    act(() => access.lock());
    await waitFor(() => expect(count('discard')).toBe(1));
    const discard = requests.find(row => row.path.endsWith('/discard'))!;
    expect(new Headers(discard.init.headers).get('Authorization')).toBe('Bearer synthetic-key');
    expect(discard.init.signal?.aborted).not.toBe(true);
    expect(discard.init.keepalive).toBe(true);
    expect(JSON.parse(discard.init.body as string)).toEqual({ operationId: 'image-op-1' });
    expect(form.review).toBeNull(); expect(operations.size).toBe(0);
    await act(async () => reply.resolve(json({ ok: true })));
  });
  it('drops a delayed preparation after lock without restoring its review', async () => {
    await setup(); await act(() => form.select(image())); const reply = deferred<Response>();
    respond = path => path.endsWith('/prepare') ? reply.promise : json({ ok: true });
    let preparing!: Promise<void>; act(() => { preparing = form.prepare(); });
    act(() => access.lock()); await act(async () => { reply.resolve(json(review())); await preparing; });
    expect(form.selection).toBeNull(); expect(form.review).toBeNull(); expect(operations.size).toBe(0);
  });
  it('remount_keeps_unknown_without_bytes', async () => {
    const storageWrites = vi.spyOn(Storage.prototype, 'setItem'); const objectUrlCalls = vi.fn(); vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: objectUrlCalls }));
    const view = await setup(); drafts.set('unrelated', { text: 'other private draft' }); await prepare();
    const reply = deferred<Response>(); respond = path => path.endsWith('/confirm') ? reply.promise : path.endsWith('/status') ? json(capability) : json(receipt());
    let confirming!: Promise<void>; act(() => { confirming = form.confirm(true); });
    expect(operations.size).toBe(1); expect([...operations.values()][0]).toMatchObject({ operationId: 'image-op-1', phase: 'confirming', target });
    expect([...operations.values()][0]).not.toHaveProperty('message'); expect([...operations.values()][0]).not.toHaveProperty('reviewToken');
    expect(JSON.stringify([...operations])).not.toMatch(/photo\.png|original text|private-review-token|iVBOR/); expect([...drafts.values()]).toEqual([{ text: 'other private draft' }]);
    view.rerender(<Tree show={false} />); view.rerender(<Tree />);
    expect(form.selection).toBeNull(); expect(form.review).toBeNull(); expect(form.phase).toBe('unknown'); expect(form.pending).toBe(true);
    await act(async () => { reply.reject(Error('lost confirmation')); await confirming; });
    await act(() => form.check()); await act(() => form.check());
    expect(count('confirm')).toBe(1); expect(count('prepare')).toBe(1); expect(storageWrites).not.toHaveBeenCalled(); expect(objectUrlCalls).not.toHaveBeenCalled();
    expect(drafts.get('unrelated')).toEqual({ text: 'other private draft' });
  });
  it('newer_text_is_not_overwritten and confirmation uses the immutable review', async () => {
    const view = await setup(); await prepare(); const original = form.review;
    options = { ...options, message: 'newer draft' }; view.rerender(<Tree />);
    expect(form.review).toBe(original); expect(Object.isFrozen(form.review)).toBe(true);
    respond = () => json(receipt('recorded')); await act(() => form.confirm(true));
    expect(form.phase).toBe('recorded'); expect(options.onRecorded).toHaveBeenCalledWith('original text');
    const request = requests.find(row => row.path.endsWith('/confirm'))!;
    expect(JSON.parse(request.init.body as string)).toEqual({ operationId: 'image-op-1', reviewToken: 'private-review-token', sharingAcknowledged: true });
  });
  it('does not guess original text after remount when a Check records the operation', async () => {
    const view = await setup(); await prepare(); respond = () => Promise.reject(Error('lost reply')); await act(() => form.confirm(true));
    view.rerender(<Tree show={false} />); options = { ...options, message: 'newer text' }; view.rerender(<Tree />);
    respond = () => json(receipt('recorded')); await act(() => form.check());
    expect(form.phase).toBe('recorded'); expect(options.onRecorded).not.toHaveBeenCalled();
  });
  it('a late admitted confirmation updates the remounted form without restoring bytes or text', async () => {
    const view = await setup(); await prepare(); const reply = deferred<Response>(); respond = () => reply.promise; let pending!: Promise<void>;
    act(() => { pending = form.confirm(true); }); view.rerender(<Tree show={false} />); view.rerender(<Tree />);
    await act(async () => { reply.resolve(json(receipt('accepted'))); await pending; });
    expect(form.phase).toBe('accepted'); expect(form.selection).toBeNull(); expect(form.review).toBeNull();
    respond = () => json(receipt('recorded')); await act(() => form.check()); expect(options.onRecorded).not.toHaveBeenCalled();
  });
  it('an older uncertain response cannot downgrade an accepted or recorded receipt', async () => {
    await setup(); await prepare(); const reply = deferred<Response>(); respond = () => reply.promise; let pending!: Promise<void>;
    act(() => { pending = form.confirm(true); });
    respond = () => json(receipt('accepted')); await act(() => form.check()); expect(form.phase).toBe('accepted');
    await act(async () => { reply.resolve(json(receipt('unknown'))); await pending; }); expect(form.phase).toBe('accepted');
    respond = () => json(receipt('recorded')); await act(() => form.check()); await act(() => form.check());
    expect(options.onRecorded).toHaveBeenCalledExactlyOnceWith('original text');
  });
  it('pending_text_cannot_be_bypassed_with_image', async () => {
    const view = await setup(); await act(() => form.select(image()));
    options = { ...options, textPending: true }; view.rerender(<Tree />); await act(() => form.prepare()); expect(count('prepare')).toBe(0);
    options = { ...options, textPending: false }; view.rerender(<Tree />); await act(() => form.prepare());
    options = { ...options, textPending: true }; view.rerender(<Tree />); await act(() => form.confirm(true));
    expect(count('confirm')).toBe(0); expect(form.disabledReason).toMatch(/text.*(pending|submission)|unsettled/i);
  });
  it('check_never_reposts_confirmation and an expired receipt remains blocked', async () => {
    await setup(); await prepare(); respond = () => Promise.reject(Error('lost reply')); await act(() => form.confirm(true));
    respond = () => json({ code: 'attachment-expired' }, 409); await act(() => form.check()); await act(() => form.check()); await act(() => form.prepare()); await act(() => form.confirm(true));
    expect(form.phase).toBe('unknown'); expect(form.pending).toBe(true); expect(count('confirm')).toBe(1); expect(count('prepare')).toBe(1);
    expect(form.disabledReason).not.toMatch(/retry|resend|try again/i);
  });
  it('shows a typed confirm rejection while keeping the original outcome blocked', async () => {
    await setup(); await prepare();
    respond = path => path.endsWith('/confirm') ? json({ code: 'attachment-expired' }, 409) : json(receipt());
    await act(() => form.confirm(true));
    expect(form.phase).toBe('unknown'); expect(form.pending).toBe(true);
    expect(form.error).toMatch(/review expired/i);
    expect(form.disabledReason).toMatch(/Check the original image submission/);
    expect(count('confirm')).toBe(1);
  });
  it('does not invite a replacement image when a changed confirm is still uncertain', async () => {
    await setup(); await prepare();
    respond = path => path.endsWith('/confirm') ? json({ code: 'attachment-changed' }, 409) : json(receipt());
    await act(() => form.confirm(true));
    expect(form.phase).toBe('unknown'); expect(form.pending).toBe(true);
    expect(form.error).toMatch(/Check the original submission/i);
    expect(form.error).not.toMatch(/selecting a new image/i);
    expect(form.error).not.toMatch(/^This image review changed\. Explicitly select/i);
  });
  it('shows a typed receipt rejection without treating expiry as proof of non-delivery', async () => {
    await setup(); await prepare();
    respond = () => Promise.reject(Error('lost confirmation reply')); await act(() => form.confirm(true));
    respond = () => json({ code: 'attachment-expired' }, 409); await act(() => form.check());
    expect(form.phase).toBe('unknown'); expect(form.pending).toBe(true);
    expect(form.error).toMatch(/expiry does not prove non-delivery/i);
    expect(count('receipt')).toBe(1); expect(count('confirm')).toBe(1);
  });
  it('clears an obsolete check error after a fresh accepted receipt', async () => {
    await setup(); await prepare();
    respond = () => Promise.reject(Error('lost confirmation reply')); await act(() => form.confirm(true));
    respond = () => json({ code: 'attachment-expired' }, 409); await act(() => form.check());
    expect(form.error).toMatch(/expired/i);
    respond = () => json(receipt('accepted')); await act(() => form.check());
    expect(form.phase).toBe('accepted'); expect(form.error).toBe('');
    expect(count('confirm')).toBe(1); expect(count('receipt')).toBe(2);
  });
  it('keeps an expiry diagnosis after a still-unknown Check receipt', async () => {
    await setup(); await prepare();
    respond = () => Promise.reject(Error('lost confirmation reply')); await act(() => form.confirm(true));
    respond = () => json({ code: 'attachment-expired' }, 409); await act(() => form.check());
    const diagnosis = form.error; expect(diagnosis).toMatch(/expiry does not prove non-delivery/i);
    respond = () => json(receipt('unknown')); await act(() => form.check());
    expect(form.phase).toBe('unknown'); expect(form.pending).toBe(true); expect(form.error).toBe(diagnosis);
    expect(count('confirm')).toBe(1); expect(count('receipt')).toBe(2);
  });
  it.each(['sending', 'not-dispatched'] as const)('handles a prepared Check followed by %s discard proof', async phase => {
    await setup(); await prepare();
    respond = () => Promise.reject(Error('lost confirmation reply')); await act(() => form.confirm(true));
    respond = () => json({ code: 'attachment-expired' }, 409); await act(() => form.check());
    const diagnosis = form.error; expect(diagnosis).toMatch(/expiry does not prove non-delivery/i);
    const proof = phase === 'sending' ? { ...receipt('prepared'), phase: 'sending' as const } : receipt('not-dispatched');
    let read = 0;
    respond = path => path.endsWith('/discard') ? json({ ok: true }) : json(++read === 1 ? receipt('prepared') : proof);
    await act(() => form.check());
    expect(form.phase).toBe(phase === 'sending' ? 'unknown' : 'not-dispatched');
    expect(form.pending).toBe(phase === 'sending');
    expect(form.error).toBe(phase === 'sending' ? diagnosis : '');
    expect(count('confirm')).toBe(1); expect(count('receipt')).toBe(3); expect(count('discard')).toBe(1);
  });
  it('a prepared snapshot stays blocked until acknowledged discard and fresh not-dispatched proof', async () => {
    await setup(); await prepare(); const confirmReply = deferred<Response>(); const discardReply = deferred<Response>(); const proofReply = deferred<Response>();
    respond = path => path.endsWith('/confirm') ? confirmReply.promise : path.endsWith('/discard') ? discardReply.promise
      : count('receipt') === 1 ? json(receipt('prepared')) : proofReply.promise;
    let confirming!: Promise<void>; act(() => { confirming = form.confirm(true); }); let checking!: Promise<void>; act(() => { checking = form.check(); });
    await waitFor(() => expect(count('discard')).toBe(1));
    expect(form.phase).toBe('unknown'); expect(form.pending).toBe(true); expect(count('receipt')).toBe(1);
    await act(() => form.select(image())); await act(() => form.prepare()); await act(() => form.confirm(true));
    expect(count('prepare')).toBe(1); expect(count('confirm')).toBe(1);
    await act(async () => { discardReply.resolve(json({ ok: true })); }); await waitFor(() => expect(count('receipt')).toBe(2));
    expect(form.pending).toBe(true);
    await act(async () => { proofReply.resolve(json(receipt('not-dispatched'))); await checking; });
    expect(form.phase).toBe('not-dispatched'); expect(form.pending).toBe(false); expect(form.review).toBeNull(); expect(form.selection).toBeNull();
    await act(async () => { confirmReply.reject(Error('lost original confirmation reply')); await confirming; });
    expect(form.phase).toBe('not-dispatched'); expect(count('discard')).toBe(1); expect(count('confirm')).toBe(1);
  });
  it.each(['failure', 'malformed'] as const)('a %s discard cannot resolve a prepared observation', async outcome => {
    await setup(); await prepare(); respond = () => Promise.reject(Error('lost reply')); await act(() => form.confirm(true));
    respond = path => path.endsWith('/discard') ? outcome === 'failure' ? Promise.reject(Error('discard failed')) : json({ ok: true, unexpected: true }) : json(receipt('prepared'));
    await act(() => form.check()); await act(() => form.confirm(true));
    await act(() => form.select(image())); await act(() => form.prepare());
    expect(form.phase).toBe('unknown'); expect(form.pending).toBe(true); expect(form.review).toBeNull(); expect(form.selection).toBeNull();
    expect(count('discard')).toBe(1); expect(count('receipt')).toBe(1); expect(count('prepare')).toBe(1); expect(count('confirm')).toBe(1);
  });
  it.each(['prepared', 'sending', 'unknown', 'failed', 'expired', 'malformed', 'foreign'] as const)('post-discard %s reconciliation remains blocked with no read loop', async outcome => {
    await setup(); await prepare(); respond = () => Promise.reject(Error('lost reply')); await act(() => form.confirm(true));
    respond = path => path.endsWith('/discard') ? json({ ok: true }) : count('receipt') === 1 ? json(receipt('prepared'))
      : outcome === 'failed' ? Promise.reject(Error('receipt connection lost')) : outcome === 'expired' ? json({ code: 'attachment-expired' }, 409) : outcome === 'malformed' ? json({ ...receipt('not-dispatched'), extra: true })
        : outcome === 'foreign' ? json({ ...receipt('not-dispatched'), operationId: 'foreign-op' }) : json(receipt(outcome));
    await act(() => form.check()); await act(() => form.select(image())); await act(() => form.prepare()); await act(() => form.confirm(true));
    expect(form.phase).toBe('unknown'); expect(form.pending).toBe(true); expect(count('receipt')).toBe(2); expect(count('discard')).toBe(1);
    expect(count('prepare')).toBe(1); expect(count('confirm')).toBe(1);
  });
  it('direct authoritative not-dispatched evidence needs no discard or additional read', async () => {
    await setup(); await prepare(); respond = () => Promise.reject(Error('lost reply')); await act(() => form.confirm(true));
    respond = () => json(receipt('not-dispatched')); await act(() => form.check());
    expect(form.phase).toBe('not-dispatched'); expect(form.pending).toBe(false); expect(count('receipt')).toBe(1); expect(count('discard')).toBe(0);
  });
  it('a confirmation that wins the discard race stays blocked after its reply is lost', async () => {
    await setup(); await prepare(); const confirmReply = deferred<Response>(); const discardReply = deferred<Response>();
    let dispatched = false;
    respond = path => path.endsWith('/confirm') ? confirmReply.promise : path.endsWith('/discard') ? discardReply.promise
      : json(receipt(dispatched ? 'unknown' : 'prepared'));
    let confirming!: Promise<void>; act(() => { confirming = form.confirm(true); }); let checking!: Promise<void>; act(() => { checking = form.check(); });
    await waitFor(() => expect(count('discard')).toBe(1));
    await act(async () => { dispatched = true; confirmReply.reject(Error('lost dispatched confirmation')); await confirming; discardReply.resolve(json({ ok: true })); await checking; });
    expect(form.phase).toBe('unknown'); expect(form.receipt?.nativeInvoked).toBe(true); expect(form.pending).toBe(true);
    await act(() => form.select(image())); await act(() => form.prepare()); await act(() => form.confirm(true));
    expect(count('confirm')).toBe(1); expect(count('prepare')).toBe(1); expect(count('receipt')).toBe(2); expect(count('discard')).toBe(1);
    respond = () => json(receipt('recorded')); await act(() => form.check());
    expect(options.onRecorded).toHaveBeenCalledExactlyOnceWith('original text'); expect(count('confirm')).toBe(1); expect(count('receipt')).toBe(3);
  });
  it.each(['receipt', 'discard'] as const)('invalidates a read-only Check across temporary loss of read authority during %s', async stage => {
    await setup(); await prepare(); respond = () => Promise.reject(Error('lost reply')); await act(() => form.confirm(true));
    let canRead = true; const reply = deferred<Response>();
    respond = path => path === '/api/control/status' ? json({ ...privateStatus, canRead, canSend: false })
      : path.endsWith(`/${stage}`) ? reply.promise : json(receipt('prepared'));
    await act(() => access.request('/api/control/status'));
    const oldPrepare = form.prepare, oldConfirm = form.confirm;
    await act(() => form.select(image())); await act(() => oldPrepare()); await act(() => oldConfirm(true));
    expect(form.selection).toBeNull(); expect(form.review).toBeNull();
    let checking!: Promise<void>; act(() => { checking = form.check(); }); await waitFor(() => expect(count(stage)).toBe(1));
    canRead = false; await act(() => access.request('/api/control/status'));
    canRead = true; await act(() => access.request('/api/control/status'));
    await act(async () => { reply.resolve(json(stage === 'discard' ? { ok: true } : receipt('prepared'))); await checking; });
    expect(count('receipt')).toBe(1); expect(count('discard')).toBe(stage === 'discard' ? 1 : 0);
    expect(count('confirm')).toBe(1); expect(count('prepare')).toBe(1); expect(form.phase).toBe('unknown');
  });
  it.each((['receipt', 'discard'] as const).flatMap(stage => (['lock', 'generation', 'target', 'hidden', 'unmount'] as const).map(transition => ({ stage, transition }))))('does not issue a follow-up request after $transition during $stage', async ({ transition, stage }) => {
    const view = await setup(); await prepare(); respond = () => Promise.reject(Error('lost reply')); await act(() => form.confirm(true));
    const delayedReply = deferred<Response>();
    respond = path => path.endsWith(`/${stage}`) ? delayedReply.promise : path.endsWith('/receipt') ? json(receipt('prepared')) : json(path.includes('/attachments/') ? capability : privateStatus);
    let checking!: Promise<void>; act(() => { checking = form.check(); }); await waitFor(() => expect(count(stage)).toBe(1));
    if (transition === 'lock' || transition === 'generation') { act(() => access.lock()); if (transition === 'generation') await act(() => access.unlock('new-synthetic-key')); }
    else if (transition === 'target') { options = { ...options, target: { ...target, sessionId: 'replacement' } }; view.rerender(<Tree />); }
    else if (transition === 'hidden') { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); act(() => document.dispatchEvent(new Event('visibilitychange'))); }
    else view.rerender(<Tree show={false} />);
    await act(async () => { delayedReply.resolve(json(stage === 'discard' ? { ok: true } : receipt('prepared'))); await checking; });
    expect(count('receipt')).toBe(1); expect(count('discard')).toBe(stage === 'discard' ? 1 : 0); expect(count('confirm')).toBe(1); expect(count('prepare')).toBe(1); expect(form.review).toBeNull();
  });
  it.each(['sending', 'unknown'] as const)('an older %s Check cannot replace definitive uploads-disabled rejection', async stale => {
    await setup(); await prepare(); const confirmReply = deferred<Response>(); const checkReply = deferred<Response>();
    respond = path => path.endsWith('/confirm') ? confirmReply.promise : checkReply.promise;
    let confirming!: Promise<void>; act(() => { confirming = form.confirm(true); }); let checking!: Promise<void>; act(() => { checking = form.check(); });
    await act(async () => { confirmReply.resolve(json({ ...receipt('rejected'), reason: 'uploads-disabled' })); await confirming; });
    expect(form.phase).toBe('rejected'); expect(form.pending).toBe(false);
    await act(async () => { checkReply.resolve(json(receipt(stale))); await checking; });
    expect(form.phase).toBe('rejected'); expect(form.receipt?.reason).toBe('uploads-disabled'); expect(form.pending).toBe(false);
    expect(count('confirm')).toBe(1); expect(count('receipt')).toBe(1); expect(count('discard')).toBe(0);
  });
  it('retains the original leaf in a stable conversation marker after an append', async () => {
    const view = await setup(); await prepare(); respond = () => Promise.reject(Error('lost reply')); await act(() => form.confirm(true));
    options = { ...options, target: { ...target, activeLeafEntryId: 'leaf-2' } }; view.rerender(<Tree />);
    expect(form.phase).toBe('unknown'); expect([...operations.values()][0].target.activeLeafEntryId).toBe('leaf-1');
    respond = () => json(receipt('accepted')); await act(() => form.check()); expect(form.phase).toBe('accepted'); expect(form.receipt?.target.activeLeafEntryId).toBe('leaf-1');
  });
  it('switching away while confirmation is in flight retains unknown on the original target', async () => {
    const view = await setup(); await prepare(); const reply = deferred<Response>(); respond = () => reply.promise; let pending!: Promise<void>;
    act(() => { pending = form.confirm(true); }); options = { ...options, target: { ...target, sessionId: 'two' } }; view.rerender(<Tree />);
    expect([...operations.values()][0].phase).toBe('unknown'); options = { ...options, target }; view.rerender(<Tree />);
    expect(form.phase).toBe('unknown'); await act(async () => { reply.reject(Error('lost response')); await pending; });
    expect(count('confirm')).toBe(1); expect(options.onRecorded).not.toHaveBeenCalled();
  });
  it('hiding a prepared form discards authority and a late hidden prepare cannot restore it', async () => {
    const view = await setup(); await prepare();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(form.review).toBeNull(); expect(count('discard')).toBe(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(form.status?.canPrepare).toBe(true)); await act(() => form.select(image()));
    const reply = deferred<Response>(); respond = () => reply.promise; let pending!: Promise<void>; act(() => { pending = form.prepare(); });
    view.rerender(<Tree show={false} />); await act(async () => { reply.resolve(json(review())); await pending; }); view.rerender(<Tree />);
    expect(form.review).toBeNull(); expect(form.selection).toBeNull(); expect(count('confirm')).toBe(0);
  });
  it.each(['hidden', 'unmount', 'agent', 'target', 'leaf', 'inactive', 'history', 'new', 'steer'] as const)('clears local selection and rejects delayed File reads on %s', async transition => {
    const view = await setup(); const read = deferred<ArrayBuffer>(); let pending!: Promise<void>;
    act(() => { pending = form.select(image(() => read.promise)); });
    if (transition === 'hidden') { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); act(() => document.dispatchEvent(new Event('visibilitychange'))); }
    else if (transition === 'unmount') view.rerender(<Tree show={false} />);
    else {
      options = { ...options, ...(transition === 'agent' ? { agentId: 'other' } : transition === 'target' ? { target: { ...target, sessionId: 'two' } }
        : transition === 'leaf' ? { target: { ...target, activeLeafEntryId: 'leaf-2' } } : transition === 'inactive' ? { active: false }
          : transition === 'history' ? { readOnly: true } : transition === 'new' ? { isNew: true } : { intent: 'steer' as const }) }; view.rerender(<Tree />);
    }
    await act(async () => { read.resolve(bytes.slice().buffer); await pending; });
    if (transition === 'unmount') view.rerender(<Tree />);
    expect(form.selection).toBeNull(); expect(form.review).toBeNull(); expect(count('prepare')).toBe(0);
  });
  it('drops a replaced File and a delayed prepare after selection removal', async () => {
    await setup(); const read = deferred<ArrayBuffer>(); let pending!: Promise<void>;
    act(() => { pending = form.select(image(() => read.promise)); }); await act(() => form.select(image()));
    await act(async () => { read.resolve(new ArrayBuffer(0)); await pending; }); expect(form.selection?.bytes).toBe(33);
    const reply = deferred<Response>(); respond = path => path.endsWith('/prepare') ? reply.promise : json({ ok: true });
    act(() => { pending = form.prepare(); }); act(() => form.remove()); await act(async () => { reply.resolve(json(review())); await pending; });
    expect(form.review).toBeNull(); expect(form.selection).toBeNull(); expect(count('confirm')).toBe(0);
    expect(requests.find(row => row.path.endsWith('/prepare'))?.init.signal?.aborted).toBe(true);
  });
  it('allows a fresh explicit review after a lost preparation response, without a send', async () => {
    await setup(); await act(() => form.select(image())); respond = () => Promise.reject(Error('lost preparation'));
    await act(() => form.prepare()); expect(operations.size).toBe(0); expect(count('confirm')).toBe(0);
    respond = () => json(review()); await act(() => form.prepare()); expect(form.phase).toBe('review'); expect(count('prepare')).toBe(2);
  });
  it('requires acknowledgement, coalesces confirm clicks and rejects foreign response bindings', async () => {
    await setup(); await prepare(); await act(() => form.confirm(false)); expect(count('confirm')).toBe(0);
    const reply = deferred<Response>(); respond = () => reply.promise; let first!: Promise<void>;
    act(() => { first = form.confirm(true); void form.confirm(true); }); expect(count('confirm')).toBe(1);
    await act(async () => { reply.resolve(json({ ...receipt('recorded'), operationId: 'foreign-op' })); await first; });
    expect(form.phase).toBe('unknown'); expect(options.onRecorded).not.toHaveBeenCalled();
    respond = () => json(receipt('recorded', { ...target, activeLeafEntryId: 'foreign-leaf' })); await act(() => form.check()); expect(form.phase).toBe('unknown');
  });
  it('expires a review without allowing an old confirmation handler to send it', async () => {
    await setup(); vi.useFakeTimers(); await prepare(); const staleConfirm = form.confirm;
    await act(() => vi.advanceTimersByTimeAsync(300_001)); await act(() => staleConfirm(true));
    expect(form.review).toBeNull(); expect(form.selection).toBeNull(); expect(count('confirm')).toBe(0); expect(count('discard')).toBe(1);
  });
  it('does not adopt changed/malformed preparation metadata or native fields', async () => {
    await setup(); await act(() => form.select(image()));
    for (const invalid of [{ ...review(), deliver: true }, review('replacement text'), review('original text', { ...target, activeLeafEntryId: 'other-leaf' }), { ...review(), image: { ...review().image, bytes: 34 } }]) {
      respond = () => json(invalid); await act(() => form.prepare()); expect(form.review).toBeNull(); expect(count('confirm')).toBe(0);
    }
  });
  it('clears metadata and forbids late confirm settlement across access generations', async () => {
    const view = await setup(); await prepare(); const reply = deferred<Response>(); respond = () => reply.promise; let pending!: Promise<void>;
    act(() => { pending = form.confirm(true); }); act(() => access.lock());
    respond = path => json(path.includes('/attachments/') ? capability : privateStatus); await act(() => access.unlock('new-synthetic-key'));
    await act(async () => { reply.resolve(json(receipt('recorded'))); await pending; }); view.rerender(<Tree />);
    expect(operations.size).toBe(0); expect(form.phase).toBe('idle'); expect(form.selection).toBeNull(); expect(options.onRecorded).not.toHaveBeenCalled();
  });
  it('Remove cannot remove an uncertain admission marker or authorize another image', async () => {
    await setup(); await prepare(); respond = () => Promise.reject(Error('lost reply')); await act(() => form.confirm(true));
    act(() => form.remove()); await act(() => form.select(image())); await act(() => form.prepare());
    expect(form.phase).toBe('unknown'); expect(form.selection).toBeNull(); expect(operations.size).toBe(1); expect(count('prepare')).toBe(1); expect(count('confirm')).toBe(1);
  });
  it('shows local native policy rejection without globally locking valid private reads', async () => {
    await setup(); await prepare(); respond = () => json({ ...receipt('rejected'), reason: 'uploads-disabled' }); await act(() => form.confirm(true));
    expect(form.phase).toBe('rejected'); expect(form.disabledReason).toMatch(/image|upload/i); expect(form.disabledReason).not.toMatch(/retry|resend/i); expect(access.state).toBe('unlocked');
    respond = () => json({ readable: true }); await expect(access.request('/api/control/agents/main/task')).resolves.toEqual({ readable: true });
  });
  it.each([['empty', ''], ['slash command', '/stop'], ['shell command', '!command'], ['overlength', 'x'.repeat(8_001)]])('does not prepare disallowed ordinary text: %s', async (_name, message) => {
    const view = await setup(); await act(() => form.select(image())); options = { ...options, message }; view.rerender(<Tree />); await act(() => form.prepare()); expect(count('prepare')).toBe(0);
  });
  it('screens actual file bytes without thumbnails, trusting MIME labels or uploading on selection', async () => {
    await setup(); await act(() => form.select(image())); expect(form.selection).toEqual({ filename: 'photo.png', mimeType: 'image/png', bytes: 33, width: 1, height: 1 }); expect(count('prepare')).toBe(0);
    const bad = image(async () => new ArrayBuffer(10)); await act(() => form.select(bad)); expect(form.selection).toBeNull(); expect(form.disabledReason).toMatch(/image|PNG|JPEG/i);
  });
  it('uploads only the closed preparation body after explicit review, never browser size/hash authority', async () => {
    await setup(); await prepare();
    expect(JSON.parse(requests.find(row => row.path.endsWith('/attachments/prepare'))!.init.body as string)).toEqual({
      target, message: 'original text', image: { filename: 'photo.png', mimeType: 'image/png', contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAAAAAA' },
    });
    expect(count('confirm')).toBe(0);
  });
  it('rejects malformed capabilities before reading or uploading a File', async () => {
    respond = path => json(path.includes('/attachments/') ? { ...capability, nativeMethods: ['chat.send'] } : privateStatus);
    render(<Tree />); await act(() => access.unlock('synthetic-key')); await waitFor(() => expect(form.disabledReason).toMatch(/could not be verified/));
    const read = vi.fn(async () => bytes.slice().buffer);
    expect(form.status).toBeNull(); await act(() => form.select(image(read))); expect(read).not.toHaveBeenCalled(); expect(form.selection).toBeNull(); expect(count('prepare')).toBe(0);
  });
  it('rejects an over-policy File before reading its bytes', async () => {
    respond = path => json(path.includes('/attachments/') ? { ...capability, maxBytes: 32 } : privateStatus); await setup();
    const read = vi.fn(async () => bytes.slice().buffer); await act(() => form.select(image(read)));
    expect(read).not.toHaveBeenCalled(); expect(form.selection).toBeNull(); expect(count('prepare')).toBe(0);
  });
});
