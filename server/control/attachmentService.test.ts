// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_LIMITS, type AttachmentReview } from '../../shared/controlAttachments';
import { createAttachmentAdmission } from './attachmentAdmission';
import { createAttachmentService } from './attachmentService';
import { AttachmentGatewayRequestError } from './gatewayClient';
import { createTaskService } from './taskService';
import { attachmentGatewayFixture, attachmentInput, attachmentMessage, attachmentTarget, nativeImageMessage } from './fixtures/attachments';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(close => close()); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const f = attachmentGatewayFixture(); let elapsed = 0;
  const admission = createAttachmentAdmission({ now: () => elapsed });
  const tasks = createTaskService(f.gateway, () => f.state.registered);
  const service = createAttachmentService({ gateway: f.gateway, tasks, admission, enabled: () => f.state.enabled, registeredAgentIds: () => f.state.registered });
  cleanups.push(() => { service.close(); tasks.close(); });
  const prepare = () => service.prepare('main', { target: attachmentTarget, message: attachmentMessage, image: attachmentInput }, service.acquirePreparation('main'));
  const operation = (review: AttachmentReview) => ({ operationId: review.operationId });
  const confirm = (review: AttachmentReview) => service.confirm('main', { operationId: review.operationId, reviewToken: review.reviewToken, sharingAcknowledged: true });
  return { ...f, service, admission, prepare, operation, confirm, advance: (ms: number) => { elapsed += ms; } };
}

describe('target-bound image service', () => {
  it.each(['disabled', 'permission', 'unsupported', 'unavailable', 'roster'] as const)('advertises and enforces %s before allocating a slot', kind => {
    const f = fixture();
    if (kind === 'disabled') f.state.enabled = false;
    if (kind === 'permission') f.state.canSend = false;
    if (kind === 'unsupported') f.state.caps = null;
    if (kind === 'unavailable') f.state.canRead = false;
    if (kind === 'roster') f.state.registered.clear();
    expect(f.service.status('main')).toMatchObject({ canPrepare: false, reason: kind === 'roster' ? 'permission' : kind });
    expect(() => f.service.acquirePreparation('main')).toThrow();
    expect(f.requests.filter(r => r.method !== 'sessions.subscribe')).toHaveLength(0);
    expect(f.nativeSends).toHaveLength(0);
  });
  it('does not advertise image preparation when read-source reconciliation is unavailable', () => {
    const f = fixture(); f.gateway.readSourceKey = undefined;
    expect(f.service.status('main')).toMatchObject({ canPrepare: false, reason: 'unsupported' });
    expect(() => f.service.acquirePreparation('main')).toThrow('unsupported');
    expect(f.nativeSends).toHaveLength(0);
  });
  it('preserves a structural pre-dispatch Gateway rejection as a changed, not-dispatched receipt', async () => {
    const f = fixture(); const review = await f.prepare();
    f.gateway.sendImageFollowup = async () => { throw new AttachmentGatewayRequestError('attachment-changed'); };
    expect(await f.confirm(review)).toMatchObject({ phase: 'not-dispatched', nativeInvoked: false, reason: 'changed' });
    expect(f.nativeSends).toHaveLength(0);
  });
  it('does not trust an acknowledgment from a Gateway adapter that skipped the invocation mark', async () => {
    const f = fixture(); const review = await f.prepare();
    f.gateway.sendImageFollowup = async () => ({ runId: review.operationId });
    expect(await f.confirm(review)).toMatchObject({ phase: 'not-dispatched', nativeInvoked: false, reason: 'changed' });
    expect(f.nativeSends).toHaveLength(0);
  });
  it('uses the lower negotiated image cap and rejects malformed browser authority without any source reads', async () => {
    const f = fixture(); f.state.caps!.maxImageBytes = 67;
    expect(f.service.status('main')).toEqual({ enabled: true, canPrepare: true, reason: null, epoch: 'epoch-1', maxBytes: 67 });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'file-too-large' });
    f.state.caps!.maxImageBytes = 4_194_304;
    for (const extra of [{ queueMode: 'steer' }, { destination: 'external' }, { runtime: 'other' }]) {
      await expect(f.service.prepare('main', { target: attachmentTarget, message: attachmentMessage, image: attachmentInput, ...extra }, f.service.acquirePreparation('main'))).rejects.toMatchObject({ code: 'invalid-request' });
    }
    await expect(f.service.prepare('main', { target: attachmentTarget, message: '/stop', image: attachmentInput }, f.service.acquirePreparation('main'))).rejects.toMatchObject({ code: 'invalid-request' });
    expect(f.requests.filter(r => r.method !== 'sessions.subscribe')).toHaveLength(0);
    expect(f.nativeSends).toHaveLength(0);
  });
  it('rechecks admission after receiving and releases a cancelled preparation lease', async () => {
    const f = fixture(); const lease = f.service.acquirePreparation('main'); f.state.enabled = false;
    await expect(f.service.prepare('main', { target: attachmentTarget, message: attachmentMessage, image: attachmentInput }, lease)).rejects.toMatchObject({ code: 'disabled' });
    f.state.enabled = true; const aborted = new AbortController(); aborted.abort();
    await expect(f.service.prepare('main', { target: attachmentTarget, message: attachmentMessage, image: attachmentInput }, f.service.acquirePreparation('main'), aborted.signal)).rejects.toMatchObject({ code: 'unavailable' });
    const a = f.service.acquirePreparation('main'), b = f.service.acquirePreparation('main'); a.release(); b.release();
    expect(f.nativeSends).toHaveLength(0);
  });
  it('counts preparing custody across the original receiving deadline while target preflight is deferred', async () => {
    vi.useFakeTimers(); const f = fixture(); const lease = f.service.acquirePreparation('main');
    f.advance(29_999); vi.advanceTimersByTime(29_999);
    const entered = deferred<void>(), gate = deferred<void>();
    f.state.afterRequest = async method => { if (method === 'sessions.describe') { entered.resolve(); await gate.promise; } };
    const pending = f.service.prepare('main', { target: attachmentTarget, message: attachmentMessage, image: attachmentInput }, lease);
    const outcome = pending.then(review => ({ review }), error => ({ error }));
    await entered.promise;
    const other = f.service.acquirePreparation('main'); f.advance(2); vi.advanceTimersByTime(2);
    try {
      expect(() => f.service.acquirePreparation('main')).toThrow('rate-limited');
      expect(f.nativeSends).toHaveLength(0);
    } finally { gate.resolve(); other.release(); }
    const settled = await outcome;
    expect(settled).toHaveProperty('review');
    if (!('review' in settled)) return;
    lease.release(); lease.release(); const receiving = f.service.acquirePreparation('main');
    expect(() => f.service.acquirePreparation('main')).toThrow('rate-limited');
    f.service.discard('main', f.operation(settled.review)); const freed = f.service.acquirePreparation('main');
    receiving.release(); freed.release();
  });
  it('close aborts the service-owned preparation preflight and cannot mint a late review', async () => {
    const f = fixture(); const entered = deferred<void>(), gate = deferred<void>();
    let readSignal: AbortSignal | undefined; const request = f.gateway.request;
    vi.spyOn(f.gateway, 'request').mockImplementation((method, params, signal) => {
      if (method === 'sessions.describe') readSignal = signal;
      return request(method, params, signal);
    });
    f.state.afterRequest = async method => { if (method === 'sessions.describe') { entered.resolve(); await gate.promise; } };
    const outcome = f.prepare().then(review => ({ review }), error => ({ error }));
    await entered.promise;
    try {
      f.service.close(); expect(readSignal?.aborted).toBe(true);
      expect(() => f.admission.acquire()).toThrow('unavailable');
    } finally { gate.resolve(); }
    expect(await outcome).toHaveProperty('error'); expect(f.nativeSends).toHaveLength(0);
  });
  it.each(['expired', 'released', 'foreign'] as const)('rejects a %s preparation lease before source reads or payload custody', async kind => {
    const f = fixture(), foreign = createAttachmentAdmission();
    const lease = kind === 'foreign' ? foreign.acquire() : f.service.acquirePreparation('main');
    if (kind === 'expired') f.advance(30_000);
    if (kind === 'released') lease.release();
    try {
      await expect(f.service.prepare('main', { target: attachmentTarget, message: attachmentMessage, image: attachmentInput }, lease)).rejects.toMatchObject({ code: 'attachment-expired' });
      expect(f.requests.filter(r => r.method !== 'sessions.subscribe')).toHaveLength(0);
      if (kind === 'foreign') {
        foreign.beginPreparation(lease); const other = foreign.acquire();
        expect(() => foreign.acquire()).toThrow('rate-limited'); other.release();
      }
    } finally { lease.release(); foreign.close(); }
    expect(f.nativeSends).toHaveLength(0);
  });
  it.each(['failure', 'abort'] as const)('releases pending preparing custody after %s without minting a review', async kind => {
    vi.useFakeTimers(); const f = fixture(), consumer = new AbortController(); const lease = f.service.acquirePreparation('main');
    f.advance(29_999); vi.advanceTimersByTime(29_999);
    const entered = deferred<void>(), gate = deferred<void>(); let readSignal: AbortSignal | undefined; const request = f.gateway.request;
    vi.spyOn(f.gateway, 'request').mockImplementation((method, params, signal) => { if (method === 'sessions.describe') readSignal = signal; return request(method, params, signal); });
    f.state.afterRequest = async method => { if (method === 'sessions.describe') { entered.resolve(); await gate.promise; } };
    const outcome = f.service.prepare('main', { target: attachmentTarget, message: attachmentMessage, image: attachmentInput }, lease, consumer.signal)
      .then(review => ({ review }), error => ({ error }));
    await entered.promise; const other = f.service.acquirePreparation('main'); f.advance(2); vi.advanceTimersByTime(2);
    try {
      if (kind === 'abort') { consumer.abort(); expect(readSignal?.aborted).toBe(true); }
      else f.state.session.lifecycleRevision = 'life-changed';
      expect(() => f.service.acquirePreparation('main')).toThrow('rate-limited');
    } finally { gate.resolve(); other.release(); }
    expect(await outcome).toHaveProperty('error');
    const a = f.service.acquirePreparation('main'), b = f.service.acquirePreparation('main'); a.release(); b.release();
    expect(f.nativeSends).toHaveLength(0);
  });
  it('a duplicate prepare cannot release the first preparation custody when its own lease transition is refused', async () => {
    const f = fixture(), entered = deferred<void>(), gate = deferred<void>(); const lease = f.service.acquirePreparation('main');
    f.state.afterRequest = async method => { if (method === 'sessions.describe') { entered.resolve(); await gate.promise; } };
    const pending = f.service.prepare('main', { target: attachmentTarget, message: attachmentMessage, image: attachmentInput }, lease);
    const outcome = pending.then(review => ({ review }), error => ({ error })); await entered.promise;
    let duplicateResult: unknown;
    const duplicate = f.service.prepare('main', { target: attachmentTarget, message: attachmentMessage, image: attachmentInput }, lease)
      .then(review => { duplicateResult = { review }; }, error => { duplicateResult = { error }; });
    try {
      await Promise.resolve(); expect(duplicateResult).toMatchObject({ error: { code: 'attachment-expired' } });
      const other = f.service.acquirePreparation('main');
      try { expect(() => f.service.acquirePreparation('main')).toThrow('rate-limited'); } finally { other.release(); }
    } finally { gate.resolve(); await duplicate; await outcome; }
    expect(await outcome).toHaveProperty('review'); expect(f.nativeSends).toHaveLength(0);
  });
  it('prepare_never_sends', async () => {
    const f = fixture(); const review = await f.prepare();
    expect(f.nativeSends).toHaveLength(0);
    expect(review).toMatchObject({ target: attachmentTarget, message: attachmentMessage, image: { filename: 'picture.png', mimeType: 'image/png', bytes: 68, width: 1, height: 1 } });
    expect(await f.confirm(review)).toMatchObject({ phase: 'accepted', nativeInvoked: true, imageEvidence: 'unverified', runId: review.operationId });
    expect(f.nativeSends).toEqual([{ type: 'req', id: 'native-request-1', method: 'chat.send', params: {
      agentId: 'main', sessionKey: 'agent:main:fixture', sessionId: 's1', expectedLeafEntryId: 'leaf-1', message: attachmentMessage,
      idempotencyKey: review.operationId, queueMode: 'followup', deliver: false,
      attachments: [{ mimeType: 'image/png', fileName: 'picture.png', origin: 'file', content: attachmentInput.contentBase64 }],
    } }]);
    expect(f.requests.filter(r => r.method === 'chat.history').every(r => r.params.limit === 1)).toBe(true);
  });
  it.each(['foreign', 'read-only', 'viewer', 'stale', 'missing-leaf'] as const)('does not prepare a %s target', async kind => {
    const f = fixture();
    if (kind === 'foreign') f.state.session.agentId = 'other';
    if (kind === 'read-only') f.state.session.readOnly = true;
    if (kind === 'viewer') f.state.session.sharingRole = 'viewer';
    if (kind === 'stale') f.state.session.lifecycleRevision = 'life-2';
    const target = kind === 'missing-leaf' ? { ...attachmentTarget, activeLeafEntryId: undefined } : attachmentTarget;
    await expect(f.service.prepare('main', { target, message: attachmentMessage, image: attachmentInput }, f.service.acquirePreparation('main'))).rejects.toThrow();
    expect(f.nativeSends).toHaveLength(0);
    const a = f.service.acquirePreparation('main'), b = f.service.acquirePreparation('main'); a.release(); b.release();
  });
  it('connected_leaf_race_blocks_confirmation', async () => {
    const f = fixture(); const review = await f.prepare();
    f.state.afterRequest = method => { if (method === 'chat.history') f.state.session.activeLeafEntryId = 'leaf-2'; };
    expect(await f.confirm(review)).toMatchObject({ phase: 'not-dispatched', nativeInvoked: false, reason: 'changed' });
    expect(f.nativeSends).toHaveLength(0);
  });
  it('does not prepare against a contradictory history leaf or a connected source change', async () => {
    const f = fixture(); f.state.historyOverride = { sessionInfo: { activeLeafEntryId: 'leaf-other' } };
    await expect(f.prepare()).rejects.toMatchObject({ code: 'attachment-changed' });
    f.state.historyOverride = undefined;
    f.state.afterRequest = method => { if (method === 'sessions.describe') f.state.caps!.epoch = 'epoch-2'; };
    await expect(f.prepare()).rejects.toMatchObject({ code: 'attachment-changed' });
    expect(f.nativeSends).toHaveLength(0);
  });
  it('source invalidation during preflight prevents dispatch even if connection getters still look ready', async () => {
    const f = fixture(); const review = await f.prepare();
    f.state.afterRequest = method => { if (method === 'chat.history') f.emit({ event: 'source.invalidated', payload: {} }); };
    expect(await f.confirm(review)).toMatchObject({ phase: 'not-dispatched', nativeInvoked: false, reason: 'changed' });
    expect(f.nativeSends).toHaveLength(0);
  });
  it('opens the private payload only after every target preflight read has completed', async () => {
    const f = fixture(); const review = await f.prepare(); let describes = 0, histories = 0;
    f.state.afterRequest = method => { if (method === 'sessions.describe') describes++; if (method === 'chat.history') histories++; };
    const confirm = f.admission.confirm;
    vi.spyOn(f.admission, 'confirm').mockImplementation((agent, request, start) => confirm(agent, request, dispatch => start(new Proxy(dispatch, {
      get(target, key, receiver) {
        if (key === 'payload' && (describes < 2 || histories < 1)) throw Error('Payload opened while preflight can still invalidate its lease');
        return Reflect.get(target, key, receiver);
      },
    }))));
    expect(await f.confirm(review)).toMatchObject({ phase: 'accepted', nativeInvoked: true });
    expect(f.nativeSends).toHaveLength(1);
  });
  it.each(['lifecycle', 'branch', 'roster', 'source', 'epoch', 'permission', 'disabled', 'viewer'] as const)('refences connected %s changes during preflight', async change => {
    const f = fixture(); const review = await f.prepare();
    f.state.afterRequest = method => {
      if (method !== 'chat.history') return;
      if (change === 'lifecycle') f.state.session.lifecycleRevision = 'life-2';
      if (change === 'branch') f.state.session.branchId = 'branch-2';
      if (change === 'roster') f.state.registered.clear();
      if (change === 'source') f.state.caps!.sourceKey = 'source-2';
      if (change === 'epoch') f.state.caps!.epoch = 'epoch-2';
      if (change === 'permission') f.state.canSend = false;
      if (change === 'disabled') f.state.enabled = false;
      if (change === 'viewer') f.state.session.sharingRole = 'viewer';
    };
    expect(await f.confirm(review)).toMatchObject({ phase: 'not-dispatched', nativeInvoked: false });
    expect(f.nativeSends).toHaveLength(0);
  });
  it.each(['timeout', 'malformed', 'different-run', 'untyped-denial'] as const)('lost_ack_checks_never_resend: %s', async failure => {
    const f = fixture(); const review = await f.prepare();
    f.state.nativeResult = async () => { if (failure === 'timeout') throw new AttachmentGatewayRequestError('attachment-outcome-unknown');
      if (failure === 'untyped-denial') throw { code: 'uploads-disabled' }; return failure === 'malformed' ? {} : { runId: 'foreign-run' }; };
    const [a, b] = await Promise.all([f.confirm(review), f.confirm(review)]);
    expect(a).toMatchObject({ phase: 'unknown', nativeInvoked: true }); expect(b).toEqual(a);
    f.state.caps!.epoch = 'epoch-reconnected';
    for (let i = 0; i < 3; i++) expect(await f.service.receipt('main', f.operation(review))).toMatchObject({ phase: 'unknown' });
    expect(await f.confirm(review)).toEqual(a);
    f.advance(ATTACHMENT_LIMITS.receiptTtlMs + 1);
    await expect(f.service.receipt('main', f.operation(review))).rejects.toMatchObject({ code: 'attachment-expired' });
    await expect(f.confirm(review)).rejects.toMatchObject({ code: 'attachment-expired' });
    expect(f.nativeSends).toHaveLength(1);
  });
  it('an HTTP read cancellation never aborts or replaces the admitted native invocation', async () => {
    const f = fixture(); const review = await f.prepare(); let settle!: (value: unknown) => void;
    f.state.nativeResult = () => new Promise(resolve => { settle = resolve; });
    const pending = f.confirm(review); await vi.waitFor(() => expect(f.nativeSends).toHaveLength(1));
    const aborted = new AbortController(); aborted.abort();
    for (let i = 0; i < 3; i++) await f.service.receipt('main', f.operation(review), aborted.signal).catch(() => undefined);
    settle({ runId: review.operationId });
    expect(await pending).toMatchObject({ phase: 'accepted' }); expect(await f.confirm(review)).toMatchObject({ phase: 'accepted' });
    expect(f.nativeSends).toHaveLength(1);
  });
  it('losing read consumers during reconciliation cannot create a new attempt', async () => {
    const f = fixture(); const review = await f.prepare(); await f.confirm(review);
    for (let i = 0; i < 3; i++) {
      const consumer = new AbortController();
      f.state.history.messages = [nativeImageMessage(review.operationId)];
      f.state.afterRequest = method => { if (method === 'chat.history') consumer.abort(); };
      expect(await f.service.receipt('main', f.operation(review), consumer.signal)).toMatchObject({ phase: 'accepted', imageEvidence: 'unverified' });
    }
    expect(await f.confirm(review)).toMatchObject({ phase: 'accepted' });
    expect(f.nativeSends).toHaveLength(1);
  });
  it.each(['attachment-changed', 'attachment-too-large'] as const)('does not infer native rejection from %s', async code => {
    const f = fixture(); const review = await f.prepare();
    f.state.nativeResult = async () => { throw new AttachmentGatewayRequestError(code); };
    expect(await f.confirm(review)).toMatchObject({ phase: 'unknown', nativeInvoked: true });
    expect(await f.confirm(review)).toMatchObject({ phase: 'unknown' }); expect(f.nativeSends).toHaveLength(1);
  });
  it.each([{ runId: 'other', messageId: 'user-1', messageSeq: 7 }, { messageId: 'user-1' }, { messageSeq: 0 }])('rejects malformed acknowledgment identity %j', async ack => {
    const f = fixture(); const review = await f.prepare();
    f.state.nativeResult = async () => ({ runId: review.operationId, ...ack });
    expect(await f.confirm(review)).toMatchObject({ phase: 'unknown', nativeInvoked: true }); expect(f.nativeSends).toHaveLength(1);
  });
  it('an exact recorded acknowledgment establishes text only, not an attachment reference', async () => {
    const f = fixture(); const review = await f.prepare();
    f.state.nativeResult = async id => ({ runId: id, messageId: 'user-1', messageSeq: 7 });
    expect(await f.confirm(review)).toMatchObject({ phase: 'recorded', imageEvidence: 'unverified', messageId: 'user-1', messageSeq: 7 });
  });
  it('does not qualify an acknowledgment after the source changes during native invocation', async () => {
    const f = fixture(); const review = await f.prepare();
    f.state.nativeResult = async id => { f.state.caps!.sourceKey = 'source-other'; return { runId: id, messageId: 'user-1', messageSeq: 7 }; };
    expect(await f.confirm(review)).toMatchObject({ phase: 'unknown', nativeInvoked: true, imageEvidence: 'unverified' });
    expect(await f.confirm(review)).toMatchObject({ phase: 'unknown' }); expect(f.nativeSends).toHaveLength(1);
  });
  it('reserves rejected exclusively for the typed native uploads-disabled denial', async () => {
    const f = fixture(); const review = await f.prepare();
    f.state.nativeResult = async () => { throw new AttachmentGatewayRequestError('uploads-disabled'); };
    expect(await f.confirm(review)).toMatchObject({ phase: 'rejected', nativeInvoked: true, reason: 'uploads-disabled', imageEvidence: 'unverified' });
    expect(await f.service.receipt('main', f.operation(review))).toMatchObject({ phase: 'rejected' });
    expect(f.nativeSends).toHaveLength(1);
  });
  it('recorded_text_is_not_image_success', async () => {
    const f = fixture(); const review = await f.prepare(); await f.confirm(review);
    f.state.history.messages = [{ role: 'user', content: attachmentMessage, __openclaw: { runId: review.operationId, id: 'user-1', seq: 7 } }];
    expect(await f.service.receipt('main', f.operation(review))).toMatchObject({ phase: 'recorded', imageEvidence: 'unverified', messageId: 'user-1', messageSeq: 7 });
    expect(f.nativeSends).toHaveLength(1);
  });
  it.each(['pending', 'consumed'] as const)('reconciles %s custody with bounded exact identities, never text comparison', async state => {
    const f = fixture(); const review = await f.prepare(); await f.confirm(review);
    const message = nativeImageMessage(review.operationId);
    f.state.history.inputReceipts = [{ runId: review.operationId, state, ...(state === 'consumed' ? { consumedByEventId: 'user-1' } : {}) }];
    f.state.history.messages = state === 'pending' ? [message] : [];
    f.state.consumedMessages = [{ ...message, __openclaw: { ...message.__openclaw, runId: undefined } }];
    const result = await f.service.receipt('main', f.operation(review));
    expect(result).toEqual({ operationId: review.operationId, target: attachmentTarget, phase: 'recorded', nativeInvoked: true,
      runId: review.operationId, messageId: 'user-1', messageSeq: 7, imageEvidence: 'reference-recorded' });
    const reads = f.requests.filter(r => r.method === 'chat.history' && (r.params.limit !== 1 || r.params.messageId));
    expect(reads[0].params).toEqual({ agentId: 'main', sessionKey: 'agent:main:fixture', limit: 50, maxBytes: 262144, inputRunIds: [review.operationId] });
    if (state === 'consumed') expect(reads[1].params).toEqual({ agentId: 'main', sessionKey: 'agent:main:fixture', sessionId: 's1', messageId: 'user-1', limit: 1, maxBytes: 262144 });
    expect(reads).toHaveLength(state === 'consumed' ? 2 : 1);
    expect(JSON.stringify(result)).not.toMatch(/media:\/\/|contentBase64|picture\.png|Describe|reviewToken|manifestDigest/);
    expect(f.nativeSends).toHaveLength(1);
  });
  it('pending or missing custody never proves failure and consumed identity contradicting run metadata never proves recording', async () => {
    const f = fixture(); const review = await f.prepare();
    f.state.nativeResult = async () => { throw Error('lost acknowledgment'); };
    expect(await f.confirm(review)).toMatchObject({ phase: 'unknown' });
    expect(await f.service.receipt('main', f.operation(review))).toMatchObject({ phase: 'unknown' });
    f.state.history.inputReceipts = [{ runId: review.operationId, state: 'pending' }];
    expect(await f.service.receipt('main', f.operation(review))).toMatchObject({ phase: 'accepted', imageEvidence: 'unverified' });
    f.state.history.inputReceipts = [{ runId: review.operationId, state: 'consumed', consumedByEventId: 'user-1' }];
    f.state.consumedMessages = [nativeImageMessage('foreign-run')];
    expect(await f.service.receipt('main', f.operation(review))).toMatchObject({ phase: 'accepted', imageEvidence: 'unverified' });
    f.state.history.inputReceipts = []; f.state.history.messages = [nativeImageMessage('foreign-run')];
    expect(await f.service.receipt('main', f.operation(review))).toMatchObject({ phase: 'accepted' });
    expect(f.nativeSends).toHaveLength(1);
  });
  it.each(['missing-media', 'truncated-media', 'foreign-media', 'contradictory-media', 'omitted'] as const)('returns safe recorded projections for %s', async shape => {
    const f = fixture(); const review = await f.prepare(); await f.confirm(review);
    const message = nativeImageMessage(review.operationId);
    if (shape === 'missing-media') delete (message.__openclaw as Record<string, unknown>).media;
    if (shape === 'truncated-media') delete (message.__openclaw.media[0] as Record<string, unknown>).fileName;
    if (shape === 'foreign-media') message.__openclaw.media[0].fileName = 'foreign.png';
    if (shape === 'contradictory-media') message.__openclaw.media.push({ ...message.__openclaw.media[0] });
    if (shape === 'omitted') {
      message.content += '\n[image attachment omitted: durable managed media claim unavailable]';
      delete (message.__openclaw as Record<string, unknown>).media; delete (message.__openclaw as Record<string, unknown>).mediaImageLayout;
    }
    f.state.history.messages = [message];
    const result = await f.service.receipt('main', f.operation(review));
    expect(result).toMatchObject({ phase: 'recorded', imageEvidence: shape === 'omitted' ? 'omitted' : 'unverified' });
    expect(Object.keys(result).sort()).toEqual(['imageEvidence', 'messageId', 'messageSeq', 'nativeInvoked', 'operationId', 'phase', 'runId', 'target']);
  });
  it('bounds history and never substitutes or replays a foreign operation token', async () => {
    const f = fixture(); const review = await f.prepare();
    await expect(f.service.confirm('main', { operationId: review.operationId, reviewToken: 'wrong', sharingAcknowledged: true })).rejects.toMatchObject({ code: 'attachment-changed' });
    await f.confirm(review); f.state.history.messages = Array.from({ length: 51 }, () => nativeImageMessage(review.operationId));
    expect(await f.service.receipt('main', f.operation(review))).toMatchObject({ phase: 'accepted' });
    f.state.history.messages = [{ ...nativeImageMessage(review.operationId), padding: 'x'.repeat(262144) }];
    expect(await f.service.receipt('main', f.operation(review))).toMatchObject({ phase: 'accepted' });
    await expect(f.service.receipt('main', { operationId: 'unknown-operation' })).rejects.toMatchObject({ code: 'attachment-expired' });
    expect(f.nativeSends).toHaveLength(1);
  });
  it('expires unconfirmed preparations without native invocation or slot renewal', async () => {
    const f = fixture(); const review = await f.prepare(); f.advance(ATTACHMENT_LIMITS.preparedTtlMs + 1);
    await expect(f.confirm(review)).rejects.toMatchObject({ code: 'attachment-expired' });
    const a = f.service.acquirePreparation('main'), b = f.service.acquirePreparation('main'); a.release(); b.release();
    expect(f.nativeSends).toHaveLength(0);
  });
  it.each(['foreign-run', 'foreign-session', 'source', 'lifecycle', 'bad-sequence', 'duplicate-custody'] as const)('does not promote %s evidence', async change => {
    const f = fixture(); const review = await f.prepare(); await f.confirm(review);
    const message = nativeImageMessage(review.operationId); f.state.history.messages = [message];
    if (change === 'foreign-run') message.__openclaw.runId = 'other';
    if (change === 'foreign-session') f.state.historyOverride = { sessionId: 's2' };
    if (change === 'source') f.state.sourceKey = 'source-2';
    if (change === 'lifecycle') f.state.afterRequest = method => { if (method === 'chat.history') f.state.session.lifecycleRevision = 'life-2'; };
    if (change === 'bad-sequence') message.__openclaw.seq = 0;
    if (change === 'duplicate-custody') f.state.history.inputReceipts = [{ runId: review.operationId, state: 'pending' }, { runId: review.operationId, state: 'consumed', consumedByEventId: 'other' }];
    expect(await f.service.receipt('main', f.operation(review))).toMatchObject({ phase: 'accepted', imageEvidence: 'unverified' });
    expect(f.nativeSends).toHaveLength(1);
  });
  it('discard and close remove dispatch authority without creating another operation', async () => {
    const f = fixture(); const review = await f.prepare(); f.service.discard('main', f.operation(review));
    expect(await f.confirm(review)).toMatchObject({ phase: 'not-dispatched', nativeInvoked: false });
    f.service.close(); await expect(f.confirm(review)).rejects.toThrow();
    expect(f.nativeSends).toHaveLength(0);
  });
  it('a restarted office cannot adopt an old operation or token as new dispatch authority', async () => {
    const first = fixture(); const review = await first.prepare(); await first.confirm(review); first.service.close();
    const restarted = fixture();
    await expect(restarted.confirm(review)).rejects.toMatchObject({ code: 'attachment-expired' });
    await expect(restarted.service.receipt('main', restarted.operation(review))).rejects.toMatchObject({ code: 'attachment-expired' });
    expect(first.nativeSends).toHaveLength(1); expect(restarted.nativeSends).toHaveLength(0);
  });
});
