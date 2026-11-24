import { CONTROL_LIMITS, controlByteSize, controlRecord, type ControlTarget } from '../../shared/control';
import { ATTACHMENT_LIMITS, parseAttachmentOperationRequest, parseAttachmentPrepareRequest,
  type AttachmentConfirmRequest, type AttachmentOperationRequest, type AttachmentPrepareRequest, type AttachmentReceipt,
  type AttachmentReview, type AttachmentStatus } from '../../shared/controlAttachments';
import type { AttachmentAdmission, AttachmentLease, AttachmentOperationMeta } from './attachmentAdmission';
import { validateAttachmentPayload } from './attachmentPayload';
import { projectAttachmentEvidence } from './attachmentReceipt';
import { ControlError } from './errors';
import { AttachmentGatewayRequestError, type ControlGateway } from './gatewayClient';
import type { AttachmentGatewayCapabilities } from './gatewayAttachmentPolicy';
import type { TaskService } from './taskService';

export interface AttachmentService {
  status(agentId: string): AttachmentStatus;
  acquirePreparation(agentId: string): AttachmentLease;
  prepare(agentId: string, input: AttachmentPrepareRequest, lease: AttachmentLease, signal?: AbortSignal): Promise<AttachmentReview>;
  confirm(agentId: string, input: AttachmentConfirmRequest): Promise<AttachmentReceipt>;
  receipt(agentId: string, input: AttachmentOperationRequest, signal?: AbortSignal): Promise<AttachmentReceipt>;
  discard(agentId: string, input: AttachmentOperationRequest): void;
  close(): void;
}
interface Options { gateway: ControlGateway; tasks: TaskService; enabled: () => boolean;
  registeredAgentIds: () => ReadonlySet<string>; admission: AttachmentAdmission }
const opaque = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const capKeys = ['epoch', 'sourceKey', 'maxBytes', 'maxImageBytes', 'maxPayload', 'maxBufferedBytes'] as const;

export function createAttachmentService({ gateway, tasks, enabled, registeredAgentIds, admission }: Options): AttachmentService {
  let closed = false, generation = 0;
  const controllers = new Set<AbortController>();
  const unsubscribe = gateway.onEvent(event => {
    if (event.event === 'source.invalidated' || event.event === 'source.ready') { generation++; admission.invalidatePrepared(); }
  });
  function capabilities(): AttachmentGatewayCapabilities | null {
    const caps = gateway.attachmentCapabilities?.();
    return caps && opaque(caps.epoch) && opaque(caps.sourceKey)
      && [caps.maxBytes, caps.maxImageBytes, caps.maxPayload, caps.maxBufferedBytes].every(positive) ? { ...caps } : null;
  }
  function status(agentId: string): AttachmentStatus {
    const active = enabled(), source = gateway.status();
    let reason: AttachmentStatus['reason'] = !active ? 'disabled' : closed ? 'unavailable'
      : !registeredAgentIds().has(agentId) || source.state === 'auth-error' || source.state === 'pairing-required' ? 'permission'
        : source.state === 'unsupported' ? 'unsupported' : source.state !== 'ready' || !source.canRead ? 'unavailable'
          : !source.canSend ? 'permission' : null;
    const caps = reason === null ? capabilities() : null;
    if (reason === null && (!caps || !gateway.sendImageFollowup || !gateway.readSourceKey)) reason = 'unsupported';
    return { enabled: active, canPrepare: reason === null, reason, epoch: caps?.epoch ?? null,
      maxBytes: caps ? Math.min(ATTACHMENT_LIMITS.maxBytes, caps.maxBytes, caps.maxImageBytes) : null };
  }
  function requireConnection(agentId: string, expected?: AttachmentGatewayCapabilities, version?: number, signal?: AbortSignal): AttachmentGatewayCapabilities {
    if (closed || signal?.aborted) throw new ControlError('unavailable');
    if (!registeredAgentIds().has(agentId)) throw new ControlError('invalid-target');
    const state = status(agentId);
    if (!state.canPrepare) throw new ControlError(state.reason === 'disabled' ? 'disabled'
      : state.reason === 'permission' ? 'scope-required' : state.reason === 'unsupported' ? 'unsupported' : 'unavailable');
    const caps = capabilities();
    if (!caps || (version !== undefined && version !== generation)
      || (expected && capKeys.some(key => caps[key] !== expected[key]))) throw new ControlError('attachment-changed');
    return caps;
  }
  function writable(target: ControlTarget, row: Record<string, unknown>): void {
    if (row.readOnly === true || row.sharingRole === 'viewer' || row.sendDisabledReason) throw new ControlError('unsupported');
    if (!opaque(target.activeLeafEntryId) || row.activeLeafEntryId !== target.activeLeafEntryId) throw new ControlError('attachment-changed');
  }
  function validatePage(target: ControlTarget, value: unknown, limit: number): Record<string, unknown> {
    const page = controlRecord(value);
    if (!page || controlByteSize(page) > CONTROL_LIMITS.responseBytes || page.sessionId !== target.sessionId || page.sessionKey !== target.sessionKey
      || !Array.isArray(page.messages) || page.messages.length > limit) throw new ControlError('attachment-changed');
    tasks.verifyHistoryInfo(target, page.sessionInfo); return page;
  }
  async function preflight(target: ControlTarget, caps: AttachmentGatewayCapabilities, version: number, signal?: AbortSignal): Promise<void> {
    requireConnection(target.agentId, caps, version, signal);
    const first = await tasks.verifyTarget(target, signal);
    requireConnection(target.agentId, caps, version, signal); writable(target, first);
    const history = await gateway.request('chat.history', { agentId: target.agentId, sessionKey: target.sessionKey, limit: 1, maxBytes: CONTROL_LIMITS.responseBytes }, signal);
    requireConnection(target.agentId, caps, version, signal);
    const page = validatePage(target, history, 1);
    if (controlRecord(page.sessionInfo)?.activeLeafEntryId !== target.activeLeafEntryId) throw new ControlError('attachment-changed');
    // A connected source can reset, switch branches, revoke sharing or advance
    // its leaf while the history request is in flight.
    const current = await tasks.verifyTarget(target, signal);
    requireConnection(target.agentId, caps, version, signal); writable(target, current);
  }
  function reason(error: unknown): AttachmentReceipt['reason'] {
    const code = error instanceof ControlError || error instanceof AttachmentGatewayRequestError ? error.code : undefined;
    return code === 'scope-required' || code === 'disabled' || code === 'pairing-required' ? 'permission'
      : code === 'unsupported' ? 'unsupported' : code === 'attachment-expired' ? 'expired'
        : code === 'attachment-changed' || code === 'session-changed' || code === 'invalid-target' || code === 'invalid-source' ? 'changed' : 'unavailable';
  }
  function operation(agentId: string, input: AttachmentOperationRequest): AttachmentOperationMeta {
    if (closed) throw new ControlError('unavailable');
    const parsed = parseAttachmentOperationRequest(input);
    if (!parsed) throw new ControlError('invalid-request');
    if (!registeredAgentIds().has(agentId)) throw new ControlError('invalid-target');
    const meta = admission.read(agentId, parsed.operationId);
    if (!meta) throw new ControlError('attachment-expired');
    return meta;
  }
  function readFence(meta: AttachmentOperationMeta, version: number, signal?: AbortSignal): void {
    const source = gateway.status();
    if (closed || signal?.aborted || source.state !== 'ready' || !source.canRead) throw new ControlError('unavailable');
    if (!gateway.readSourceKey) throw new ControlError('unsupported');
    const sourceKey = gateway.readSourceKey();
    if (sourceKey === null) throw new ControlError('unavailable');
    if (!registeredAgentIds().has(meta.receipt.target.agentId) || generation !== version
      || sourceKey !== meta.sourceKey) throw new ControlError('attachment-changed');
  }
  async function reconcile(meta: AttachmentOperationMeta, signal?: AbortSignal): Promise<AttachmentReceipt> {
    const target = meta.receipt.target, id = meta.receipt.operationId, version = generation;
    const fence = () => readFence(meta, version, signal);
    const verify = async () => { await tasks.verifyTarget(target, signal); fence(); };
    const read = async (params: Record<string, unknown>, limit: number) => {
      const value = await gateway.request('chat.history', params, signal); fence();
      const page = validatePage(target, value, limit);
      await verify(); fence(); return page;
    };
    fence(); await verify(); fence();
    const page = await read({ agentId: target.agentId, sessionKey: target.sessionKey, limit: 50,
      maxBytes: CONTROL_LIMITS.responseBytes, inputRunIds: [id] }, 50); fence();
    if (!Array.isArray(page.inputReceipts) || page.inputReceipts.length > 50) return meta.receipt;
    const receipts = page.inputReceipts.map(controlRecord).filter(row => row?.runId === id);
    if (receipts.length > 1) return meta.receipt;
    const custody = receipts[0]; let messages = page.messages as unknown[];
    if (custody?.cancelled === true || (custody && custody.state !== 'pending' && custody.state !== 'consumed')) return meta.receipt;
    let consumedId: string | undefined;
    if (custody?.state === 'consumed') {
      if (!opaque(custody.consumedByEventId)) return meta.receipt;
      consumedId = custody.consumedByEventId;
      const committed = await read({ agentId: target.agentId, sessionKey: target.sessionKey, sessionId: target.sessionId,
        messageId: consumedId, limit: 1, maxBytes: CONTROL_LIMITS.responseBytes }, 1); fence();
      messages = committed.messages as unknown[];
    }
    const matches = messages.map(controlRecord).filter(row => {
      const native = controlRecord(row?.__openclaw);
      return row?.role === 'user' && opaque(native?.id) && positive(native?.seq)
        && (consumedId ? native.id === consumedId && (native.runId === undefined || native.runId === id) : native.runId === id);
    });
    if (matches.length > 1) return meta.receipt;
    if (matches.length === 1) {
      const message = matches[0]!, native = controlRecord(message.__openclaw)!;
      return admission.record({ operationId: id, target, phase: 'recorded', nativeInvoked: true, runId: id,
        messageId: native.id as string, messageSeq: native.seq as number,
        imageEvidence: projectAttachmentEvidence(message, meta.image, meta.submittedTextDigest) });
    }
    if (custody) return admission.record({ operationId: id, target, phase: 'accepted', nativeInvoked: true, runId: id, imageEvidence: 'unverified' });
    return meta.receipt;
  }
  return {
    status,
    acquirePreparation(agentId) { requireConnection(agentId); return admission.acquire(); },
    async prepare(agentId, input, lease, signal) {
      // Refused transitions must not release another preparation's (or store's)
      // lease. Once this succeeds, only this preparation owns its cleanup.
      admission.beginPreparation(lease);
      const controller = new AbortController(), abort = () => controller.abort(); controllers.add(controller);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      try {
        const caps = requireConnection(agentId, undefined, undefined, controller.signal), version = generation;
        const parsed = parseAttachmentPrepareRequest(input);
        if (!parsed) throw new ControlError('invalid-request');
        if (parsed.target.agentId !== agentId) throw new ControlError('invalid-target');
        if (!opaque(parsed.target.activeLeafEntryId)) throw new ControlError('unsupported');
        const payload = validateAttachmentPayload(parsed.image, Math.min(caps.maxBytes, caps.maxImageBytes));
        await preflight(parsed.target, caps, version, controller.signal);
        requireConnection(agentId, caps, version, controller.signal);
        return admission.prepare({ target: parsed.target, message: parsed.message, payload, connection: caps, lease });
      } finally { signal?.removeEventListener('abort', abort); controllers.delete(controller); lease.release(); }
    },
    confirm(agentId, input) {
      if (closed) return Promise.reject(new ControlError('unavailable'));
      return admission.confirm(agentId, input, async dispatch => {
        const { review, connection } = dispatch, target = review.target;
        const controller = new AbortController(), version = generation; controllers.add(controller);
        const base = { operationId: review.operationId, target, imageEvidence: 'unverified' as const };
        try {
          await preflight(target, connection, version, controller.signal);
          requireConnection(agentId, connection, version, controller.signal);
          const result = controlRecord(await dispatch.attempt(markNativeInvocation => {
            // Do not retain the payload across preflight awaits: invalidation
            // may already have released the store's staged image and lease.
            const payload = dispatch.payload;
            return gateway.sendImageFollowup!({ agentId, sessionKey: target.sessionKey,
              sessionId: target.sessionId, expectedLeafEntryId: target.activeLeafEntryId!, message: review.message,
              idempotencyKey: review.operationId, queueMode: 'followup', deliver: false,
              attachments: [{ mimeType: payload.image.mimeType, fileName: payload.image.filename, origin: 'file', content: payload.contentBase64 }] }, connection.epoch, markNativeInvocation);
          }));
          requireConnection(agentId, connection, version, controller.signal);
          if (!result || result.runId !== review.operationId) throw Error('Unqualified image acknowledgment');
          const hasIdentity = result.messageId !== undefined || result.messageSeq !== undefined;
          if (hasIdentity && (!opaque(result.messageId) || !positive(result.messageSeq))) throw Error('Malformed image acknowledgment');
          return { ...base, nativeInvoked: true, runId: review.operationId, phase: hasIdentity ? 'recorded' : 'accepted',
            ...(hasIdentity ? { messageId: result.messageId as string, messageSeq: result.messageSeq as number } : {}) };
        } catch (error) {
          if (!dispatch.nativeInvoked) return { ...base, phase: 'not-dispatched', nativeInvoked: false, reason: reason(error) };
          if (error instanceof AttachmentGatewayRequestError && error.code === 'uploads-disabled') {
            return { ...base, phase: 'rejected', nativeInvoked: true, runId: review.operationId, reason: 'uploads-disabled' };
          }
          return { ...base, phase: 'unknown', nativeInvoked: true, runId: review.operationId };
        } finally { controllers.delete(controller); }
      });
    },
    async receipt(agentId, input, signal) {
      const meta = operation(agentId, input);
      if (!meta.receipt.nativeInvoked || meta.receipt.phase === 'rejected') return meta.receipt;
      try { return await reconcile(meta, signal); }
      catch { return operation(agentId, input).receipt; }
    },
    discard(agentId, input) { const meta = operation(agentId, input); admission.discard(agentId, meta.receipt.operationId); },
    close() {
      if (closed) return; closed = true; unsubscribe();
      for (const controller of controllers) controller.abort(); controllers.clear(); admission.close();
    },
  };
}
