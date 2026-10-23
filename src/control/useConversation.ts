import { useCallback, useEffect, useRef, useState } from 'react';
import { CONTROL_LIMITS, isControlCommand, parseControlConversationEvent, parseControlHistoryPage, parseControlSendReceipt, parseControlTarget, type ControlHistoryPage, type ControlMessage, type ControlSendReceipt, type ControlSendRequest, type ControlTarget } from '../../shared/control';
import { newEntityId } from '../util/id';
import { useControlAccess, useConversationDrafts } from './ControlAccess';
import { ControlApiError, targetIdentity } from './api';

interface Submission { input: ControlSendRequest; phase: 'sending' | 'accepted' | 'persisted' | 'unknown' | 'rejected'; receipt?: ControlSendReceipt }
interface Draft { text: string; submission?: Submission }
export function useConversation(target: ControlTarget | null, active: boolean, options?: { agentId: string; onCreated?(target: ControlTarget): void }) {
  const access = useControlAccess(); const sharedDrafts = useConversationDrafts(); const localDrafts = useRef(new Map<string, unknown>());
  const drafts = (sharedDrafts ?? localDrafts.current) as Map<string, Draft>;
  const [isNew, setNew] = useState(false); const [, redraw] = useState(0);
  const [page, setPage] = useState<ControlHistoryPage | null>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState<ControlApiError | null>(null);
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const agentId = options?.agentId ?? target?.agentId ?? '';
  const targetKey = target ? targetIdentity(target) : ''; const draftKey = isNew ? `new:${agentId}` : targetKey;
  const scope = `${draftKey}:${access.generation}`;
  const read = useRef<AbortController | null>(null); const readGeneration = useRef(0);
  const context = useRef({ access, active, target, targetKey, draftKey, scope, isNew, agentId, page, onCreated: options?.onCreated });
  context.current = { access, active, target, targetKey, draftKey, scope, isNew, agentId, page, onCreated: options?.onCreated };
  const mutate = useCallback((key: string, action: (draft: Draft) => void) => {
    let draft = drafts.get(key); if (!draft) { draft = { text: '' }; drafts.set(key, draft); }
    action(draft); redraw(n => n + 1);
  }, [drafts]);
  const refresh = useCallback(async (earlier = false) => {
    const current = context.current; const selected = current.target;
    if (!selected || current.isNew || !current.active || !current.access.status?.canRead || current.access.state !== 'unlocked'
      || document.visibilityState === 'hidden' || read.current) return;
    const controller = new AbortController(); read.current = controller; const generation = readGeneration.current; setLoading(true);
    try {
      const body = parseControlTarget(selected)!;
      const result = parseControlHistoryPage(await current.access.request(`/api/control/agents/${encodeURIComponent(selected.agentId)}/history`, {
        method: 'POST', signal: controller.signal, body: JSON.stringify({ ...body, ...(earlier ? { cursor: current.page?.nextCursor } : {}) }),
      }));
      if (!result || targetIdentity(result.target) !== current.targetKey) throw new ControlApiError('invalid-source');
      if (controller.signal.aborted || generation !== readGeneration.current || current.scope !== context.current.scope) return;
      setPage(previous => {
        const sameLeaf = previous && previous.target.activeLeafEntryId === result.target.activeLeafEntryId;
        if (!previous || (!earlier && !sameLeaf)) return result;
        const messages = earlier ? [...result.messages, ...previous.messages] : [...previous.messages, ...result.messages];
        return { ...result, nextCursor: earlier ? result.nextCursor : previous.nextCursor,
          messages: [...new Map(messages.map(message => [message.id, message])).values()].slice(-CONTROL_LIMITS.maximumHistory) };
      });
      setError(null);
      reconcile(result.messages, current.draftKey);
    } catch (failure) {
      if (controller.signal.aborted || generation !== readGeneration.current) return;
      const problem = failure instanceof ControlApiError ? failure : new ControlApiError(); setError(problem);
      setPage(previous => ['session-changed', 'invalid-target', 'scope-required', 'locked', 'pairing-required'].includes(problem.code) ? null : previous ? { ...previous, source: { ...previous.source, state: 'stale' } } : null);
    } finally { if (read.current === controller) { read.current = null; setLoading(false); } }
  }, []);
  function reconcile(messages: ControlMessage[], key: string) {
    const draft = drafts.get(key); const pending = draft?.submission;
    if (!pending || pending.phase === 'persisted') return;
    const canonical = messages.find(message => message.role === 'user' && (message.runId === pending.input.idempotencyKey || message.submissionId === pending.input.idempotencyKey)
      && !message.id.startsWith('local-record-') && message.messageSeq !== undefined && message.messageSeq > 0);
    if (canonical) mutate(key, value => { if (value.text === pending.input.message) value.text = ''; value.submission = { ...pending, phase: 'persisted' }; });
  }
  const submit = useCallback(async (retry: boolean) => {
    const current = context.current; const key = current.draftKey; const draft = drafts.get(key); if (!draft) return;
    const unsettled = draft.submission && !['persisted', 'rejected'].includes(draft.submission.phase);
    if (!current.active || current.access.state !== 'unlocked' || !current.access.status?.canSend || draft.submission?.phase === 'sending') return;
    const page = current.page;
    if (!retry && (unsettled || !draft.text.trim() || draft.text.length > CONTROL_LIMITS.prompt || (!current.isNew && (!page || page.source.state !== 'current' || page.sendDisabledReason || !current.target || targetIdentity(page.target) !== current.targetKey)))) return;
    const input = retry ? draft.submission?.input : {
      agentId: current.agentId, newConversation: current.isNew, message: draft.text, idempotencyKey: newEntityId('send'),
      ...(!current.isNew && page ? { target: parseControlTarget(page.target)! } : {}),
    };
    if (!input) return;
    mutate(key, value => { value.submission = { input, phase: 'sending' }; });
    try {
      const receipt = parseControlSendReceipt(await current.access.request(`/api/control/agents/${encodeURIComponent(input.agentId)}/send`, { method: 'POST', body: JSON.stringify(input) }));
      if (current.access.generation !== context.current.access.generation || context.current.access.state !== 'unlocked') return;
      if (!receipt || receipt.idempotencyKey !== input.idempotencyKey || receipt.target.agentId !== input.agentId
        || (input.target && targetIdentity(receipt.target) !== targetIdentity(input.target))) throw new ControlApiError('invalid-source');
      mutate(key, value => { value.submission = { input, phase: receipt.phase, receipt }; if (receipt.phase === 'persisted' && value.text === input.message) value.text = ''; });
      if (input.newConversation && current.onCreated) {
        const createdKey = targetIdentity(receipt.target);
        if (createdKey !== key) {
          drafts.set(createdKey, drafts.get(key)!); drafts.delete(key);
          if (current.scope === context.current.scope) { setNew(false); current.onCreated(receipt.target); }
        }
      }
      if (current.scope === context.current.scope) { setError(null); void refresh(); }
    } catch (failure) {
      const problem = failure instanceof ControlApiError ? failure : new ControlApiError();
      if (['locked', 'scope-required', 'pairing-required'].includes(problem.code) || current.access.generation !== context.current.access.generation) return;
      const unknown = ['unavailable', 'invalid-source', 'outcome-unknown'].includes(problem.code);
      mutate(key, value => { value.submission = { input, phase: unknown ? 'unknown' : 'rejected' }; });
      if (current.scope === context.current.scope) { setError(problem); if (['session-changed', 'invalid-target'].includes(problem.code)) setPage(null); }
    }
  }, [drafts, mutate, refresh]);
  useEffect(() => { setNew(false); }, [targetKey]);
  useEffect(() => {
    readGeneration.current++; read.current?.abort(); read.current = null; setPage(null); setError(null); setLoading(false);
  }, [scope]);
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    if (!active || !visible || access.state !== 'unlocked' || !access.status?.canRead || isNew || !target) return;
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    const socket = access.openSocket?.(); let disposed = false;
    const watch = () => { if (!disposed) socket?.emit('watch', parseControlTarget(target), (ack: { ok?: boolean }) => { if (!disposed && !ack?.ok) { setPage(null); setError(new ControlApiError('session-changed')); } }); };
    socket?.on('connect', watch);
    socket?.on('conversation', value => {
      if (disposed) return; const event = parseControlConversationEvent(value);
      if (!event || targetIdentity(event.target) !== targetKey) return;
      if (event.kind === 'invalidated') { readGeneration.current++; read.current?.abort(); read.current = null; setPage(null); setError(new ControlApiError('session-changed')); }
      else if (event.kind === 'unavailable') { setPage(previous => previous ? { ...previous, source: { ...previous.source, state: 'stale' } } : null); }
      else { reconcile(event.messages ?? [], targetKey); void refresh(); }
    });
    socket?.on('disconnect', () => { if (!disposed) setPage(previous => previous ? { ...previous, source: { ...previous.source, state: 'stale' } } : null); });
    socket?.connect();
    return () => { disposed = true; clearInterval(timer); socket?.emit('unwatch'); socket?.disconnect(); readGeneration.current++; read.current?.abort(); read.current = null; setLoading(false); };
  }, [active, visible, access.state, access.generation, access.status?.canRead, access.openSocket, targetKey, isNew, refresh]);
  const draft = drafts.get(draftKey); const submission = draft?.submission;
  const currentPage = !isNew && page && target && targetIdentity(page.target) === targetKey && access.state === 'unlocked' ? page : null;
  const disabledReason = access.state !== 'unlocked' ? 'Unlock task details to send a message.'
    : !access.status?.canRead ? 'The conversation source is disconnected. Your draft is kept.' : !access.status.canSend ? 'Sending requires an enabled write grant.'
      : isControlCommand(draft?.text ?? '') ? new ControlApiError('command-not-supported').message
      : !agentId ? 'Choose an agent.' : !isNew && !target ? 'Choose a conversation or start a new one.'
        : !isNew && (!currentPage || currentPage.source.state !== 'current') ? 'Refresh and verify this conversation before sending.' : currentPage?.sendDisabledReason ?? '';
  const retryDisabledReason = access.state !== 'unlocked' || !access.status?.canRead || !access.status.canSend ? 'Reconnect and unlock with write access before retrying.'
    : error && ['session-changed', 'invalid-target'].includes(error.code) ? error.message : '';
  return {
    messages: currentPage?.messages ?? [], draft: draft?.text ?? '', submission, isNew, loading, error, disabledReason, retryDisabledReason,
    ready: !disabledReason, pending: !!submission && !['persisted', 'rejected'].includes(submission.phase), stale: !!currentPage && (currentPage.source.state === 'stale' || !access.status?.canRead),
    nextCursor: currentPage?.nextCursor,
    setDraft: (text: string) => mutate(draftKey, value => { value.text = text; }), send: () => submit(false), retryPending: () => submit(true),
    newConversation: () => { setNew(true); setError(null); }, returnToConversation: () => setNew(false), refresh: () => refresh(), loadEarlier: () => refresh(true),
  };
}
