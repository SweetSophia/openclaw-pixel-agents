import { createHash } from 'node:crypto';
import { controlRecord, isControlCommand, parseControlTarget, type ControlSendReceipt, type ControlSendRequest, type ControlTarget } from '../../shared/control';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';
import { ControlError, type TaskService } from './taskService';
import { parseSendRequest } from './validation';

export interface SendService { send(input: ControlSendRequest, signal?: AbortSignal): Promise<ControlSendReceipt>; close(): void }
interface Submission {
  digest: string; at: number; target?: ControlTarget; creating: boolean; attempted: boolean;
  receipt?: ControlSendReceipt; flight?: Promise<ControlSendReceipt>;
  observedLeaf?: unknown;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function createSendService(gateway: ControlGateway, tasks: TaskService): SendService {
  const submissions = new Map<string, Submission>(); const controllers = new Set<AbortController>();
  let recent: number[] = []; let closed = false;
  async function reconcile(input: ControlSendRequest, entry: Submission, signal: AbortSignal): Promise<ControlSendReceipt | undefined> {
    const target = entry.target!;
    const page = controlRecord(await gateway.request('chat.history', { agentId: target.agentId, sessionKey: target.sessionKey, limit: 50, maxBytes: 256 * 1024, inputRunIds: [input.idempotencyKey] }, signal));
    if (!page || page.sessionId !== target.sessionId || page.sessionKey !== target.sessionKey || !Array.isArray(page.messages)) throw new ControlError('session-changed');
    if (!Array.isArray(page.inputReceipts) || page.inputReceipts.length > 50) throw new ControlError('unsupported');
    entry.observedLeaf = controlRecord(page.sessionInfo)?.activeLeafEntryId;
    const custody = page.inputReceipts.map(controlRecord).find(receipt => receipt?.runId === input.idempotencyKey);
    let messages = page.messages;
    if (custody?.state === 'pending' && custody.cancelled === true) throw new ControlError('unsupported');
    if (custody?.state === 'consumed' && typeof custody.consumedByEventId === 'string') {
      const committed = controlRecord(await gateway.request('chat.history', { agentId: target.agentId, sessionKey: target.sessionKey, sessionId: target.sessionId, messageId: custody.consumedByEventId, limit: 1, maxBytes: 256 * 1024 }, signal));
      if (!committed || committed.sessionId !== target.sessionId || committed.sessionKey !== target.sessionKey || !Array.isArray(committed.messages)) throw new ControlError('session-changed');
      messages = committed.messages;
    }
    for (const value of messages) {
      const row = controlRecord(value); const meta = controlRecord(row?.__openclaw);
      if (row?.role === 'user' && (meta?.runId === input.idempotencyKey || (custody?.state === 'consumed' && meta?.id === custody.consumedByEventId)) && typeof meta?.id === 'string' && meta.id
        && Number.isSafeInteger(meta.seq) && (meta.seq as number) > 0) {
        return { target, idempotencyKey: input.idempotencyKey, phase: 'persisted', runId: input.idempotencyKey, messageId: meta.id, messageSeq: meta.seq as number };
      }
    }
    if (custody && ['pending', 'consumed'].includes(String(custody.state))) return { target, idempotencyKey: input.idempotencyKey, phase: 'accepted', runId: input.idempotencyKey };
  }
  async function perform(input: ControlSendRequest, entry: Submission, signal: AbortSignal): Promise<ControlSendReceipt> {
    if (closed || !gateway.status().canRead) throw new ControlError('unavailable');
    if (!gateway.status().canSend) throw new ControlError('scope-required');
    if (!entry.target) {
      const key = `agent:${input.agentId}:pixel-${hash(input.idempotencyKey)}`;
      // An unknown pre-existing key may be a submission from an earlier server process.
      // Never infer its identity by comparing prompt text or silently adopt its new lifecycle.
      if (!entry.creating && await tasks.resolveSession(input.agentId, key, signal)) throw new ControlError('outcome-unknown');
      entry.creating = true;
      let created: Record<string, unknown> | null;
      try {
        created = controlRecord(await gateway.request('sessions.create', { agentId: input.agentId, key, idempotencyKey: input.idempotencyKey }, signal));
      } catch { throw new ControlError('outcome-unknown'); }
      const session = await tasks.resolveSession(input.agentId, key, signal);
      if (!session) throw new ControlError('outcome-unknown');
      if (!created || created.key !== key || created.sessionId !== session.sessionId
        || controlRecord(created.entry)?.lifecycleRevision !== session.lifecycleRevision) throw new ControlError('session-changed');
      entry.target = parseControlTarget(session)!;
    }
    const target = entry.target; const row = await tasks.verifyTarget(target, signal);
    if (row.sendDisabledReason || row.sharingRole === 'viewer' || row.readOnly === true) throw new ControlError('unsupported');
    const receipt = await reconcile(input, entry, signal);
    if (receipt) return entry.receipt = receipt;
    if (entry.attempted) {
      if (entry.receipt?.phase === 'accepted' || entry.receipt?.phase === 'persisted') return entry.receipt;
    }
    const steering = input.intent === 'steer';
    if (!steering && !input.newConversation && !target.activeLeafEntryId) throw new ControlError('unsupported');
    if (!steering && entry.observedLeaf !== (target.activeLeafEntryId ?? null)) throw new ControlError('outcome-unknown');
    if (input.newConversation && !entry.attempted) {
      const history = controlRecord(await gateway.request('chat.history', { agentId: target.agentId, sessionKey: target.sessionKey, limit: 1, maxBytes: 256 * 1024 }, signal));
      if (!history || history.sessionId !== target.sessionId || history.sessionKey !== target.sessionKey
        || !Array.isArray(history.messages) || history.messages.length || controlRecord(history.sessionInfo)?.activeLeafEntryId !== null) throw new ControlError('session-changed');
    }
    if (signal.aborted || !gateway.status().canSend) throw new ControlError('unavailable');
    entry.attempted = true;
    try {
      const result = controlRecord(await gateway.request('chat.send', {
        agentId: target.agentId, sessionKey: target.sessionKey, sessionId: target.sessionId, message: input.message,
        idempotencyKey: input.idempotencyKey, queueMode: input.intent ?? 'followup', deliver: false,
        ...(!steering ? { expectedLeafEntryId: target.activeLeafEntryId ?? null } : {}),
      }, signal));
      if (!result || result.runId !== input.idempotencyKey) throw Error('Unconfirmed admission');
      const seq = result.messageSeq; const id = result.messageId;
      const persisted = Number.isSafeInteger(seq) && (seq as number) > 0 && typeof id === 'string' && id.length > 0;
      return entry.receipt = { target, idempotencyKey: input.idempotencyKey, phase: persisted ? 'persisted' : 'accepted', runId: input.idempotencyKey,
        ...(persisted ? { messageId: id as string, messageSeq: seq as number } : {}) };
    } catch (error) {
      if (error instanceof GatewayRequestError && ['scope-required', 'invalid-source', 'session-changed'].includes(error.code)) {
        throw new ControlError(error.code === 'scope-required' ? 'scope-required' : 'session-changed');
      }
      return entry.receipt = { target, idempotencyKey: input.idempotencyKey, phase: 'unknown', runId: input.idempotencyKey };
    }
  }
  return {
    send(input, signal) {
      const parsed = parseSendRequest(input.agentId, input);
      if (!parsed) return Promise.reject(new ControlError('invalid-request'));
      if (isControlCommand(parsed.message)) return Promise.reject(new ControlError('command-not-supported'));
      if (signal?.aborted || closed) return Promise.reject(new ControlError('unavailable'));
      const digest = hash(JSON.stringify(parsed)); const now = Date.now();
      let entry = submissions.get(input.idempotencyKey);
      if (entry && entry.digest !== digest) return Promise.reject(new ControlError('invalid-request'));
      if (entry) entry.at = now;
      for (const [id, item] of submissions) if (!item.flight && now - item.at > 3600000) submissions.delete(id);
      if (!entry) {
        recent = recent.filter(at => now - at < 60000);
        if (recent.length >= 10 || submissions.size >= 1000) return Promise.reject(new ControlError('rate-limited'));
        recent.push(now); entry = { digest, at: now, target: parsed.target, creating: false, attempted: false }; submissions.set(input.idempotencyKey, entry);
      }
      if (!entry.flight) {
        // A disconnected HTTP consumer must not cancel or replace an admitted submission.
        const controller = new AbortController(); controllers.add(controller); const current = entry;
        entry.flight = perform(parsed, current, controller.signal).finally(() => { current.flight = undefined; controllers.delete(controller); });
      }
      return entry.flight.then(receipt => structuredClone(receipt));
    },
    close() { closed = true; for (const controller of controllers) controller.abort(); controllers.clear(); submissions.clear(); recent = []; },
  };
}
