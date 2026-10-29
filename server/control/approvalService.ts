import { createHash, randomUUID } from 'node:crypto';
import { CONTROL_LIMITS, controlByteSize, controlRecord, type ControlTarget } from '../../shared/control';
import { APPROVAL_LIMITS, parseApprovalInspectRequest, parseApprovalReadRequest, parseApprovalResolveRequest,
  type ApprovalInspectRequest, type ApprovalNonDispatchCode, type ApprovalResolveRequest, type ControlApproval, type ControlApprovalPage, type ControlApprovalResult } from '../../shared/controlApprovals';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';
import { ControlError, type TaskService } from './taskService';
import { projectApproval } from './approvalProjection';

export interface ApprovalService {
  read(target: ControlTarget, signal?: AbortSignal): Promise<ControlApprovalPage>;
  inspect(input: ApprovalInspectRequest, signal?: AbortSignal): Promise<ControlApprovalResult>;
  resolve(input: ApprovalResolveRequest, signal?: AbortSignal): Promise<ControlApprovalResult>;
  close(): void;
}
// Created only by the pre-native resolve fence, never inferred from a native error code.
export class ApprovalNotDispatchedError extends ControlError {
  readonly approvalDisposition = 'not-dispatched' as const;
  constructor(code: ApprovalNonDispatchCode) { super(code); }
}
const identity = (target: ControlTarget) => JSON.stringify([target.agentId, target.sessionKey, target.sessionId, target.lifecycleRevision ?? null, target.branchId ?? null]);
export function createApprovalService(gateway: ControlGateway, tasks: TaskService): ApprovalService {
  let closed = false; let generation = 0; let activeOperations = 0;
  const observations = new Map<string, { approval: ControlApproval; expires: number; observationId?: string; inspectionExpires?: number }>();
  const controllers = new Set<AbortController>(); const resolving = new Set<string>();
  const observers = new Map<string, { subscription: { key: string; agentId: string; subscriptionId: string }; epoch: number; ready: boolean }>();
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined; let cleanupFlight: Promise<void> | undefined;
  // Never evict an attempted native identity, including unknown outcomes across reconnects/audiences.
  // This is bounded process-local protection, not durable exactly-once delivery.
  const attempted = new Set<string>(); const decisionTimes: number[] = [];
  const presentationIdentity = (approval: ControlApproval) => createHash('sha256').update(JSON.stringify(approval)).digest('hex');
  const key = (target: ControlTarget, id: string) => JSON.stringify([identity(target), id]);
  function authority(): void {
    if (closed || !gateway.status().canRead) throw new ControlError('unavailable');
    if (!gateway.status().canReviewApprovals) throw new ControlError(gateway.status().approvalsDisabledReason === 'unsupported' ? 'unsupported' : 'approvals-denied');
  }
  function current(epoch: number, signal?: AbortSignal): void {
    authority(); if (generation !== epoch || signal?.aborted) throw new ControlError('unavailable');
  }
  function remember(target: ControlTarget, approval: ControlApproval): void {
    for (const [id, observation] of observations) if (observation.expires <= Date.now()) observations.delete(id);
    const previous = observations.get(key(target, approval.id));
    const observationId = previous && presentationIdentity(previous.approval) === presentationIdentity(approval) ? previous.observationId : undefined;
    observations.set(key(target, approval.id), { approval: structuredClone(approval), expires: Date.now() + APPROVAL_LIMITS.lifetime,
      ...(observationId ? { observationId, inspectionExpires: previous!.inspectionExpires } : {}) });
    while (observations.size > APPROVAL_LIMITS.observations) observations.delete(observations.keys().next().value!);
  }
  const off = gateway.onEvent(event => {
    if (event.event === 'source.invalidated') {
      generation++; observations.clear(); observers.clear(); clearTimeout(cleanupTimer); cleanupTimer = undefined; cleanupFlight = undefined;
      for (const controller of controllers) controller.abort();
      if (closed) off();
    }
  });
  function scheduleCleanup(): void {
    if (cleanupTimer || ![...observers.values()].some(observer => observer.ready)) return;
    cleanupTimer = setTimeout(() => { cleanupTimer = undefined; void releaseObservers(); }, 250); cleanupTimer.unref?.();
  }
  function releaseObservers(): Promise<void> {
    if (cleanupFlight) return cleanupFlight;
    const epoch = generation;
    const flight = (async () => {
      for (const [id, observer] of observers) {
        if (epoch !== generation || !gateway.status().canRead) return;
        if (!observer.ready || observer.epoch !== epoch) continue;
        try {
          const response = controlRecord(await gateway.request('sessions.messages.unsubscribe', observer.subscription));
          if (!response || controlByteSize(response) > CONTROL_LIMITS.responseBytes || response.subscribed !== false || response.key !== observer.subscription.key) return;
          if (observers.get(id) === observer) observers.delete(id);
        } catch { return; } // Keep the exact identity for admission-safe cleanup retry, never a decision retry.
      }
    })().finally(() => {
      if (cleanupFlight === flight) cleanupFlight = undefined;
      if (epoch === generation) scheduleCleanup();
      if (closed && !observers.size) off();
    });
    cleanupFlight = flight; return flight;
  }
  // Own cancellation for all native work, not just the temporary subscription.
  async function operation<T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    authority();
    if (activeOperations >= APPROVAL_LIMITS.concurrent) throw new ControlError('rate-limited');
    activeOperations++;
    const controller = new AbortController(); const cancel = () => controller.abort();
    controllers.add(controller); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try { current(generation, controller.signal); return await action(controller.signal); }
    finally { controllers.delete(controller); activeOperations--; signal?.removeEventListener('abort', cancel); }
  }
  async function discover(target: ControlTarget, signal?: AbortSignal): Promise<ControlApprovalPage> {
    if (!parseApprovalReadRequest({ target })) throw new ControlError('invalid-request');
    target = structuredClone(target);
    authority();
    const epoch = generation; const controller = new AbortController(); controllers.add(controller);
    const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    const events: { updatedAtMs: number; approval: ControlApproval; phase: string }[] = []; let overflow = false;
    const stop = gateway.onEvent(event => {
      // Native events omit agentId: only qualified keys disambiguate concurrent agent observers.
      // Unqualified aliases use the explicitly agent-bound replay and the next bounded refresh.
      if (event.event !== 'session.approval' || !target.sessionKey.startsWith(`agent:${target.agentId}:`)) return;
      const row = controlRecord(event.payload);
      if (row?.sessionKey !== target.sessionKey) return;
      const approval = projectApproval(row.approval);
      if (!approval || !Number.isSafeInteger(row.updatedAtMs) || Number(row.updatedAtMs) < 0
        || (row.phase !== 'pending' && row.phase !== 'terminal') || (row.phase === 'pending') !== (approval.status === 'pending')
        || (row.sourceSessionKey !== undefined && (typeof row.sourceSessionKey !== 'string' || !row.sourceSessionKey || row.sourceSessionKey.length > 512
          || row.sourceSessionKey.trim() !== row.sourceSessionKey || /[\u0000-\u001f\u007f]/.test(row.sourceSessionKey)
          || (approval.sourceSessionKey !== undefined && approval.sourceSessionKey !== row.sourceSessionKey)))) { overflow = true; return; }
      if (events.length >= APPROVAL_LIMITS.events) { overflow = true; return; }
      events.push({ updatedAtMs: Number(row.updatedAtMs), approval: { ...approval,
        ...(typeof row.sourceSessionKey === 'string' ? { sourceSessionKey: row.sourceSessionKey } : {}) }, phase: row.phase });
    });
    const subscription = { key: target.sessionKey, agentId: target.agentId, subscriptionId: `pixel-approvals-${randomUUID()}` };
    let observer: ReturnType<typeof observers.get>;
    try {
      current(epoch, controller.signal);
      await tasks.verifyTarget(target, controller.signal); current(epoch, controller.signal);
      // Reserve ownership before dispatch: even a lost subscribe response needs exact cleanup.
      if (observers.size >= APPROVAL_LIMITS.concurrent || [...observers.values()].some(item => item.ready)) throw new ControlError('rate-limited');
      observer = { subscription, epoch, ready: false }; observers.set(subscription.subscriptionId, observer);
      const response = controlRecord(await gateway.request('sessions.messages.subscribe', { ...subscription, includeApprovals: true }, controller.signal));
      const replay = controlRecord(response?.approvalReplay);
      if (!response || controlByteSize(response) > CONTROL_LIMITS.responseBytes || response.subscribed !== true || response.key !== target.sessionKey || response.agentId !== target.agentId
        || replay?.sessionKey !== target.sessionKey || !Number.isSafeInteger(replay.updatedAtMs) || Number(replay.updatedAtMs) < 0
        || replay.truncated !== false || !Array.isArray(replay.approvals) || replay.approvals.length > APPROVAL_LIMITS.replay) throw new ControlError('invalid-source');
      const items = new Map<string, ControlApproval>();
      for (const raw of replay.approvals) {
        const approval = projectApproval(raw);
        if (!approval || approval.status !== 'pending' || items.has(approval.id)) throw new ControlError('invalid-source');
        items.set(approval.id, approval);
      }
      await tasks.verifyTarget(target, controller.signal); current(epoch, controller.signal);
      if (overflow) throw new ControlError('invalid-source');
      // Equal-timestamp terminal facts win over replay; older pending events cannot resurrect an approval.
      const terminal = new Set<string>(); const versions = new Map<string, number>();
      for (const event of events) {
        if (event.phase === 'terminal') { terminal.add(event.approval.id); items.delete(event.approval.id); continue; }
        if (event.updatedAtMs < Number(replay.updatedAtMs) || event.updatedAtMs < (versions.get(event.approval.id) ?? 0)) continue;
        versions.set(event.approval.id, event.updatedAtMs);
        if (!terminal.has(event.approval.id)) items.set(event.approval.id, event.approval);
      }
      const all = [...items.values()];
      const page: ControlApprovalPage = { target: structuredClone(target), source: { state: 'current', observedAt: Date.now() },
        items: all.slice(0, APPROVAL_LIMITS.items), truncated: replay.truncated || all.length > APPROVAL_LIMITS.items };
      while (controlByteSize(page) > CONTROL_LIMITS.responseBytes && page.items.length) { page.items.pop(); page.truncated = true; }
      if (all.length && !page.items.length) throw new ControlError('invalid-source');
      for (const approval of page.items) remember(target, approval);
      return page;
    } catch (error) {
      if (error instanceof GatewayRequestError && error.code === 'scope-required') throw new ControlError('approvals-denied');
      throw error;
    } finally {
      stop(); controllers.delete(controller); signal?.removeEventListener('abort', cancel);
      // Keep failed cleanup owned and bound to this connection; block new subscriptions until acknowledged.
      if (observer && observers.get(subscription.subscriptionId) === observer) { observer.ready = true; await releaseObservers(); }
      current(epoch, controller.signal);
    }
  }
  const read = (target: ControlTarget, signal?: AbortSignal) => operation(signal, active => discover(target, active));
  async function lookup(input: ApprovalInspectRequest, epoch: number, signal?: AbortSignal): Promise<ControlApproval> {
    const known = observations.get(key(input.target, input.id));
    if (!known || known.expires <= Date.now()) throw new ControlError('approval-unavailable');
    const value = controlRecord(await gateway.request('approval.get', { id: input.id }, signal));
    const approval = projectApproval(value?.approval);
    const source = controlRecord(controlRecord(value?.approval)?.source);
    if (!value || controlByteSize(value) > CONTROL_LIMITS.responseBytes || !approval || approval.id !== input.id || approval.kind !== known.approval.kind
      || (approval.sourceSessionKey !== undefined && approval.sourceSessionKey !== known.approval.sourceSessionKey)
      || (source?.sessionKey !== undefined && known.approval.sourceSessionKey !== undefined && source.sessionKey !== known.approval.sourceSessionKey)) throw new ControlError('invalid-source');
    await tasks.verifyTarget(input.target, signal); current(epoch, signal);
    return { ...approval, ...(known.approval.sourceSessionKey ? { sourceSessionKey: known.approval.sourceSessionKey } : {}) };
  }
  async function inspect(input: ApprovalInspectRequest, signal?: AbortSignal): Promise<ControlApprovalResult> {
    if (!parseApprovalInspectRequest(input)) throw new ControlError('invalid-request');
    input = structuredClone(input);
    return operation(signal, async active => {
      authority(); const epoch = generation;
      const page = await discover(input.target, active);
      const approval = await lookup(input, epoch, active);
      if (approval.status === 'pending' && !page.items.some(item => item.id === input.id)) throw new ControlError('approval-unavailable');
      remember(input.target, approval);
      const observationId = approval.status === 'pending' ? randomUUID() : undefined;
      const known = observations.get(key(input.target, input.id))!;
      known.observationId = observationId;
      known.inspectionExpires = observationId ? Date.now() + APPROVAL_LIMITS.lifetime : undefined;
      return { target: structuredClone(input.target), source: { state: 'current', observedAt: Date.now() }, approval, applied: false, ...(observationId ? { observationId } : {}) };
    });
  }
  async function resolve(input: ApprovalResolveRequest, signal?: AbortSignal): Promise<ControlApprovalResult> {
    if (!parseApprovalResolveRequest(input)) throw new ControlError('invalid-request');
    input = structuredClone(input);
    // All actual attempts, even native rejections, retain the authoritative ledger entry.
    // These three local rejection codes can be recoverable only before that entry exists.
    try { return await resolveOnce(input, signal); }
    catch (error) {
      const nativeIdentity = JSON.stringify([input.id, input.kind]);
      if (!attempted.has(nativeIdentity) && error instanceof ControlError
        && (error.code === 'approval-changed' || error.code === 'approval-unavailable' || error.code === 'rate-limited')) {
        throw new ApprovalNotDispatchedError(error.code);
      }
      throw error;
    }
  }
  async function resolveOnce(input: ApprovalResolveRequest, signal?: AbortSignal): Promise<ControlApprovalResult> {
    authority(); const epoch = generation; const nativeIdentity = JSON.stringify([input.id, input.kind]);
    if (attempted.has(nativeIdentity)) throw new ControlError('approval-outcome-unknown');
    const known = observations.get(key(input.target, input.id));
    if (!known || known.expires <= Date.now() || !known.inspectionExpires
      || known.inspectionExpires <= Date.now() || known.observationId !== input.observationId) {
      throw new ControlError('approval-unavailable');
    }
    const inspected = structuredClone(known.approval);
    if (inspected.kind !== input.kind) throw new ControlError('invalid-request');
    if (resolving.has(nativeIdentity)) throw new ControlError('rate-limited');
    resolving.add(nativeIdentity);
    try {
      return await operation(signal, async active => {
        const page = await discover(input.target, active);
        const approval = await lookup(input, epoch, active);
        if (approval.kind !== input.kind) throw new ControlError('invalid-request');
        if (approval.status !== 'pending') return { target: input.target, source: { state: 'current', observedAt: Date.now() }, approval, applied: false };
        const audience = page.items.find(item => item.id === input.id);
        if (!audience) throw new ControlError('approval-unavailable');
        if (presentationIdentity(inspected) !== presentationIdentity(approval) || presentationIdentity(inspected) !== presentationIdentity(audience)) {
          observations.delete(key(input.target, input.id)); throw new ControlError('approval-changed');
        }
        if (approval.expiresAtMs <= Date.now() || !approval.allowedDecisions.includes(input.decision)) throw new ControlError('approval-unavailable');
        await tasks.verifyTarget(input.target, active); current(epoch, active);
        const final = observations.get(key(input.target, input.id));
        if (!final || final.observationId !== input.observationId || final.expires <= Date.now()
          || !final.inspectionExpires || final.inspectionExpires <= Date.now()) {
          throw new ControlError('approval-changed');
        }
        if (approval.expiresAtMs <= Date.now()) throw new ControlError('approval-unavailable');
        while (decisionTimes.length && Date.now() - decisionTimes[0] >= 60000) decisionTimes.shift();
        if (decisionTimes.length >= APPROVAL_LIMITS.decisionsPerMinute || attempted.size >= APPROVAL_LIMITS.attempts) throw new ControlError('rate-limited');
        decisionTimes.push(Date.now()); attempted.add(nativeIdentity);
        try {
          const value = controlRecord(await gateway.request('approval.resolve', { id: input.id, kind: input.kind, decision: input.decision }, active));
          const resolved = projectApproval(value?.approval);
          if (!value || controlByteSize(value) > CONTROL_LIMITS.responseBytes || typeof value.applied !== 'boolean' || !resolved || resolved.id !== input.id || resolved.kind !== input.kind || resolved.status === 'pending'
            || (value.applied && (resolved.status !== (input.decision === 'deny' ? 'denied' : 'allowed')
              || controlRecord(value.approval)?.decision !== input.decision))) throw new ControlError('invalid-source');
          await tasks.verifyTarget(input.target, active); current(epoch, active);
          const result = { ...resolved, ...(approval.sourceSessionKey ? { sourceSessionKey: approval.sourceSessionKey } : {}) }; remember(input.target, result);
          return { target: structuredClone(input.target), source: { state: 'current' as const, observedAt: Date.now() }, approval: result, applied: value.applied };
        } catch (error) {
          if (error instanceof GatewayRequestError && ['approvals-denied', 'approval-unavailable'].includes(error.code)) throw error;
          throw new ControlError('approval-outcome-unknown');
        }
      });
    } finally { resolving.delete(nativeIdentity); }
  }
  return { read, inspect, resolve, close() {
    if (closed) return;
    closed = true; observations.clear(); for (const controller of controllers) controller.abort();
    if (!observers.size) off();
    else void releaseObservers();
  } };
}
