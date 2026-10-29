import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseControlTarget, type ControlTarget } from '../../shared/control';
import { APPROVAL_LIMITS, parseApprovalPage, parseApprovalResult, type ApprovalDecision, type ControlApproval, type ControlApprovalPage, type ControlApprovalResult } from '../../shared/controlApprovals';
import { useControlAccess } from './ControlAccess';
import { ControlApiError, targetIdentity } from './api';
import { controlReadDeadline, controlReadError } from './readDeadline';

interface Confirmation { owner: string; target: ControlTarget; approval: ControlApproval; decision: ApprovalDecision; observationId: string }
interface View { page: ControlApprovalPage | null; confirmation: Confirmation | null; inspected: ControlApprovalResult | null; outcomes: ControlApprovalResult[]; uncertain: string[]; error: ControlApiError | null; loading: boolean; busy: string | null }
const empty = (): View => ({ page: null, confirmation: null, inspected: null, outcomes: [], uncertain: [], error: null, loading: false, busy: null });
// No payloads or credentials; keep attempted identities across tab unmounts, never in browser storage.
const attempts = new WeakMap<object, Set<string>>();
const fingerprint = (approval: ControlApproval) => JSON.stringify(approval);

export function useApprovals(target: ControlTarget | null, active: boolean) {
  const access = useControlAccess(); const canonical = target && parseControlTarget(target);
  const owner = JSON.stringify([canonical, access.generation]);
  const enabled = !!canonical && active && access.state === 'unlocked' && access.status?.canRead === true && access.status.canReviewApprovals === true && document.visibilityState !== 'hidden';
  const [view, render] = useState<View>(empty); const data = useRef(view);
  const context = useRef({ owner, enabled, access, target: canonical }); context.current = { owner, enabled, access, target: canonical };
  const mounted = useRef(true); const epoch = useRef(0); const read = useRef<AbortController | null>(null); const operation = useRef(false);
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const update = useCallback((change: (previous: View) => View) => { data.current = change(data.current); render(data.current); }, []);
  const permitted = () => mounted.current && context.current.enabled && document.visibilityState !== 'hidden';
  const same = (selected: string, generation: number) => permitted() && context.current.owner === selected && epoch.current === generation;
  const stop = useCallback(() => { epoch.current++; read.current?.abort(); read.current = null; operation.current = false; data.current = empty(); render(data.current); }, []);
  useLayoutEffect(() => { mounted.current = true; stop(); return () => { mounted.current = false; epoch.current++; read.current?.abort(); read.current = null; }; }, [owner, enabled, stop]);
  useEffect(() => {
    const change = () => { if (document.visibilityState === 'hidden') stop(); setVisible(document.visibilityState !== 'hidden'); };
    document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change);
  }, [stop]);
  const ledger = () => {
    const request = context.current.access.request;
    let values = attempts.get(request); if (!values) { values = new Set(); attempts.set(request, values); } return values;
  };
  const identity = (item: ControlApproval) => JSON.stringify([context.current.target && targetIdentity(context.current.target), item.kind, item.id]);
  const canDecide = (item: ControlApproval) => permitted() && !operation.current && data.current.page?.source.state === 'current'
    && item.status === 'pending' && item.expiresAtMs > Date.now() && !ledger().has(identity(item)) && ledger().size < APPROVAL_LIMITS.attempts;
  const refresh = useCallback(async () => {
    const current = context.current; if (!permitted() || !current.target || read.current || operation.current) return;
    const selected = current.owner; const generation = epoch.current; const controller = new AbortController(); read.current = controller;
    const dispose = controlReadDeadline(controller); update(old => ({ ...old, loading: true }));
    try {
      const page = parseApprovalPage(await current.access.request(`/api/control/agents/${encodeURIComponent(current.target.agentId)}/approvals/list`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ target: current.target }) }));
      if (!same(selected, generation) || (controller.signal.aborted && controller.signal.reason?.code !== 'timed-out')) return;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!page || targetIdentity(page.target) !== targetIdentity(current.target)) throw new ControlApiError('invalid-source');
      update(old => {
        const confirmation = old.confirmation && page.source.state === 'current' && page.items.some(item => item.id === old.confirmation!.approval.id && fingerprint(item) === fingerprint(old.confirmation!.approval)) ? old.confirmation : null;
        return { ...old, page, confirmation, error: null, loading: false };
      });
    } catch (error) {
      if (!same(selected, generation) || (controller.signal.aborted && controller.signal.reason?.code !== 'timed-out')) return;
      const failure = controlReadError(controller, error);
      const clear = ['locked', 'session-changed', 'invalid-target', 'approvals-denied', 'scope-required', 'pairing-required'].includes(failure.code);
      update(old => ({ ...old, loading: false, error: failure, confirmation: null, page: clear ? null : old.page ? { ...old.page, source: { ...old.page.source, state: 'stale' } } : null }));
    } finally { dispose(); if (read.current === controller) read.current = null; }
  }, [update]);
  useEffect(() => {
    if (!enabled || !visible) return;
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000); return () => clearInterval(timer);
  }, [owner, enabled, visible, refresh]);
  const inspectRecord = useCallback(async (item: ControlApproval, decision?: ApprovalDecision) => {
    const current = context.current;
    if (!permitted() || !current.target || operation.current || (decision && (!canDecide(item) || !item.allowedDecisions.includes(decision)))) return;
    // Inspection replaces any older read/confirmation, so late polling cannot reopen a decision.
    epoch.current++; read.current?.abort(); read.current = null; operation.current = true;
    const selected = current.owner; const generation = epoch.current; const controller = new AbortController(); read.current = controller;
    const dispose = controlReadDeadline(controller); update(old => ({ ...old, confirmation: null, busy: item.id, loading: false, error: null }));
    try {
      const result = parseApprovalResult(await current.access.request(`/api/control/agents/${encodeURIComponent(current.target.agentId)}/approvals/inspect`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ target: current.target, id: item.id }) }));
      if (!same(selected, generation) || (controller.signal.aborted && controller.signal.reason?.code !== 'timed-out')) return;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!result || result.applied || result.approval.id !== item.id || result.approval.kind !== item.kind || targetIdentity(result.target) !== targetIdentity(current.target)
        || (result.source.state === 'current' && result.approval.status === 'pending' && !result.observationId)) throw new ControlApiError('invalid-source');
      const approval = result.approval;
      const actionable = decision && result.source.state === 'current' && approval.status === 'pending' && approval.expiresAtMs > Date.now() && approval.allowedDecisions.includes(decision) && result.observationId && !ledger().has(identity(approval));
      // Clone the inspected record; subsequent list renders never mutate this captured presentation.
      const confirmation: Confirmation | null = actionable ? { owner: selected, target: { ...current.target }, approval: { ...approval, details: [...approval.details], allowedDecisions: [...approval.allowedDecisions] }, decision, observationId: result.observationId! } : null;
      update(old => ({ ...old, inspected: result, confirmation, busy: null,
        page: old.page ? { ...old.page, items: old.page.items.map(entry => entry.id === approval.id ? approval : entry) } : old.page,
        outcomes: approval.status !== 'pending' ? [result, ...old.outcomes.filter(entry => entry.approval.id !== approval.id)].slice(0, APPROVAL_LIMITS.items) : old.outcomes,
        uncertain: approval.status !== 'pending' ? old.uncertain.filter(id => id !== approval.id) : old.uncertain }));
    } catch (error) {
      if (same(selected, generation) && (!controller.signal.aborted || controller.signal.reason?.code === 'timed-out')) update(old => ({ ...old, busy: null, confirmation: null, inspected: null, error: controlReadError(controller, error),
        page: old.page ? { ...old.page, source: { ...old.page.source, state: 'stale' } } : null }));
    } finally { dispose(); if (read.current === controller) read.current = null; if (same(selected, generation)) operation.current = false; }
  }, [update]);
  const confirm = useCallback(async () => {
    const current = context.current; const captured = data.current.confirmation;
    const present = captured && data.current.page?.items.find(item => item.id === captured.approval.id);
    if (!captured || captured.owner !== current.owner || !current.target || !canDecide(captured.approval) || !present || fingerprint(present) !== fingerprint(captured.approval)) {
      update(old => ({ ...old, confirmation: null })); return;
    }
    const attempted = identity(captured.approval); ledger().add(attempted); operation.current = true;
    epoch.current++; read.current?.abort(); read.current = null; const generation = epoch.current; const selected = current.owner;
    update(old => ({ ...old, confirmation: null, busy: captured.approval.id, error: null }));
    try {
      const result = parseApprovalResult(await current.access.request(`/api/control/agents/${encodeURIComponent(captured.target.agentId)}/approvals/resolve`, { method: 'POST', body: JSON.stringify({ target: captured.target, id: captured.approval.id, kind: captured.approval.kind, decision: captured.decision, observationId: captured.observationId }) }));
      if (!same(selected, generation)) return;
      if (!result || targetIdentity(result.target) !== targetIdentity(captured.target) || result.approval.id !== captured.approval.id || result.approval.kind !== captured.approval.kind) throw new ControlApiError('invalid-source');
      const unknown = result.approval.status === 'pending';
      update(old => ({ ...old, busy: null, inspected: result, outcomes: [result, ...old.outcomes.filter(entry => entry.approval.id !== result.approval.id)].slice(0, APPROVAL_LIMITS.items),
        uncertain: unknown ? [...new Set([...old.uncertain, captured.approval.id])] : old.uncertain.filter(id => id !== captured.approval.id),
        page: old.page ? { ...old.page, items: old.page.items.map(item => item.id === result.approval.id ? result.approval : item) } : null }));
    } catch (error) {
      if (!same(selected, generation)) return;
      const failure = error instanceof ControlApiError ? error : new ControlApiError('approval-outcome-unknown');
      const unknown = ['unavailable', 'invalid-source', 'timed-out', 'approval-outcome-unknown'].includes(failure.code);
      update(old => ({ ...old, busy: null, error: failure, uncertain: unknown ? [...new Set([...old.uncertain, captured.approval.id])] : old.uncertain,
        outcomes: unknown ? [{ target: captured.target, source: old.inspected?.source ?? { state: 'stale', observedAt: 0 }, approval: captured.approval, applied: false }, ...old.outcomes.filter(entry => entry.approval.id !== captured.approval.id)].slice(0, APPROVAL_LIMITS.items) : old.outcomes,
        page: old.page ? { ...old.page, source: { ...old.page.source, state: 'stale' } } : null }));
    } finally { if (same(selected, generation)) operation.current = false; }
  }, [update]);
  const disabledReason = access.state !== 'unlocked' ? 'Unlock task access to review approvals.'
    : !access.status?.canReviewApprovals ? access.status?.approvalsDisabledReason === 'scope-required' ? 'Approval review requires a separately granted operator.approvals scope.'
      : access.status?.approvalsDisabledReason === 'unsupported' ? 'This Gateway does not support approval review.' : 'Approval review is not enabled. Ask the office operator about approval setup.'
      : !access.status.canRead ? 'Reconnect the conversation source before reviewing approvals.' : !canonical ? 'Choose a live conversation to review approvals.' : '';
  const displayed = enabled ? view : empty();
  return { ...displayed, owner, enabled, disabledReason, canDecide,
    refresh, inspect: (item: ControlApproval) => inspectRecord(item), prepare: (item: ControlApproval, decision: ApprovalDecision) => inspectRecord(item, decision),
    confirm, cancel: () => update(old => ({ ...old, confirmation: null })) };
}
