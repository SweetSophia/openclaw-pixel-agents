import React, { useId, useLayoutEffect, useRef, useState, useEffect } from 'react';
import type { ControlTarget } from '../../shared/control';
import type { ApprovalDecision, ControlApproval } from '../../shared/controlApprovals';
import { useApprovals } from '../control/useApprovals';
import './ConversationApprovals.css';

const time = (value: number) => new Date(value).toLocaleString();
const decisionLabel = (decision: ApprovalDecision) => decision === 'deny' ? 'deny' : 'allow once';
function Presentation({ approval, target }: { approval: ControlApproval; target: ControlTarget }) {
  return <>
    <h4>{approval.title}</h4><p>Full approval ID: <span>{approval.id}</span></p><p>Kind: <span>{approval.kind}</span> · Status: {approval.status}</p>
    <p>Source: {!approval.sourceSessionKey ? 'source conversation not reported; visible to this conversation audience' : approval.sourceSessionKey !== target.sessionKey ? 'child conversation' : 'selected conversation'}{approval.sourceSessionKey ? ` · ${approval.sourceSessionKey}` : ''}. Not associated with a recorded run.</p>
    <p>Expires {time(approval.expiresAtMs)}</p><pre className="approval-text">{approval.text}</pre>
    {approval.details.length > 0 && <ul>{approval.details.map((detail, index) => <li className="approval-text" key={index}>{detail}</li>)}</ul>}
  </>;
}
// Inline within the detail dialog: share its outer focus boundary, trap this confirmation locally.
function Confirmation({ approval, target, decision, onCancel, onConfirm }: { approval: ControlApproval; target: ControlTarget; decision: ApprovalDecision; onCancel(): void; onConfirm(): void }) {
  const cancel = useRef<HTMLButtonElement>(null); const confirm = useRef<HTMLButtonElement>(null); const heading = useId();
  useLayoutEffect(() => { cancel.current?.focus(); }, []);
  return <div role="dialog" aria-modal="true" aria-labelledby={heading} className="approval-confirmation" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
    if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); (document.activeElement === cancel.current ? confirm.current : cancel.current)?.focus(); }
  }}>
    <h3 id={heading}>Confirm {decisionLabel(decision)}</h3>
    <p>Agent: {target.agentId}</p><p>Conversation: <span>{target.sessionKey}</span></p><p>Session: {target.sessionId}</p>
    {target.lifecycleRevision && <p>Lifecycle: {target.lifecycleRevision}</p>}{target.branchId && <p>Branch: {target.branchId}</p>}
    <Presentation approval={approval} target={target} />
    <p>This decision applies only to this exact inspected approval, once. Changed or expired requests cannot be confirmed.</p>
    <div className="approval-actions"><button type="button" ref={cancel} onClick={onCancel}>Cancel</button><button type="button" ref={confirm} onClick={onConfirm}>Confirm {decisionLabel(decision)}</button></div>
  </div>;
}
export function ConversationApprovals({ target, active, readOnly = false }: { target: ControlTarget | null; active: boolean; readOnly?: boolean }) {
  const state = useApprovals(target, active && !readOnly); const [, tick] = useState(0);
  const section = useRef<HTMLElement>(null); const heading = useRef<HTMLHeadingElement>(null);
  const invoking = useRef<{ owner: string; id: string; button: HTMLButtonElement } | null>(null);
  const previousConfirmation = useRef<string | null>(null);
  const confirmation = state.confirmation?.owner === state.owner && state.confirmation.approval.expiresAtMs > Date.now() ? state.confirmation : null;
  // Restore after DOM updates, not during child deletion; disabled/removed triggers need a stable local fallback.
  useLayoutEffect(() => {
    const previous = previousConfirmation.current; previousConfirmation.current = confirmation?.owner ?? null;
    const origin = invoking.current; const root = section.current;
    if (!previous || confirmation || previous !== state.owner || origin?.owner !== state.owner || !active || readOnly || !state.enabled
      || !root?.isConnected || root.closest('[hidden], [inert]') || document.visibilityState === 'hidden') return;
    const usable = (element: HTMLElement | null): element is HTMLElement => !!element?.isConnected && root.contains(element) && !element.hasAttribute('disabled');
    const inspect = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-approval-inspect]')).find(button => button.dataset.approvalInspect === origin.id) ?? null;
    const refresh = root.querySelector<HTMLButtonElement>('[data-approval-refresh]');
    (usable(origin.button) ? origin.button : usable(inspect) ? inspect : usable(refresh) ? refresh : heading.current)?.focus();
  });
  useEffect(() => { if (!state.enabled) return; const timer = setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(timer); }, [state.enabled]);
  if (readOnly) return <p>Approvals are available for the live conversation only. Return to live to review them.</p>;
  if (!active) return null;
  if (state.disabledReason) return <p className="task-notice">{state.disabledReason}</p>;
  return <section ref={section} className="conversation-approvals" aria-label="Live conversation approvals">
    <h3 ref={heading} tabIndex={-1}>Live conversation approvals</h3><p>Only approvals visible to the selected conversation audience are shown. No standing grants or reviewer overrides.</p>
    <button type="button" data-approval-refresh disabled={state.loading || !!state.busy || !state.enabled} onClick={() => { void state.refresh(); }}>Refresh approvals</button>
    {state.loading && <p role="status">Loading approvals…</p>}
    {state.error && <p role="alert">{state.error.message}</p>}
    {state.page && <p className="task-muted">{state.page.source.state === 'stale' ? 'Last known — decisions disabled' : 'Verified by OpenClaw'} · {time(state.page.source.observedAt)}</p>}
    {state.page?.truncated && <p className="task-notice">This is a limited approval list. Only the displayed exact records can be reviewed.</p>}
    {state.page?.items.length === 0 && <p>No pending approvals visible for this conversation.</p>}
    {state.page?.items.map(approval => <article className="approval-record" key={approval.id} aria-label={`Approval ${approval.id}`}>
      {target && <Presentation approval={approval} target={target} />}
      {approval.status === 'pending' && approval.expiresAtMs <= Date.now() && <p>Expired — decisions disabled.</p>}
      {state.uncertain.includes(approval.id) && <p role="status">Outcome unknown. Pending alone cannot establish failure. Inspect explicitly; this decision cannot be replayed.</p>}
      <div className="approval-actions"><button type="button" data-approval-inspect={approval.id} disabled={!!state.busy || !state.enabled} onClick={() => { void state.inspect(approval); }}>Inspect {approval.id}</button>
        {approval.allowedDecisions.map(decision => <button key={decision} type="button" disabled={!state.canDecide(approval)} onClick={event => { invoking.current = { owner: state.owner, id: approval.id, button: event.currentTarget }; event.currentTarget.focus(); void state.prepare(approval, decision); }}>{decision === 'deny' ? 'Deny' : 'Allow once'}</button>)}
      </div>
    </article>)}
    {state.outcomes.map(result => <div key={result.approval.id}>
      <p role="status">{result.approval.id}: {result.approval.status === 'pending' ? 'Outcome unknown. Pending does not establish failure; inspect explicitly. This decision cannot be replayed.'
        : `${result.approval.status}. ${result.applied ? 'Applied by this request.' : 'Not applied by this request; showing the recorded native status.'}`}</p>
      {result.approval.status === 'pending' && <button type="button" disabled={!!state.busy || !state.enabled} onClick={() => { void state.inspect(result.approval); }}>Reconcile {result.approval.id}</button>}
    </div>)}
    {state.inspected && !confirmation && <section aria-label="Inspected approval"><h3>Inspected record</h3><Presentation approval={state.inspected.approval} target={state.inspected.target} /></section>}
    {confirmation && <Confirmation key={`${confirmation.owner}:${confirmation.observationId}`} {...confirmation} onCancel={state.cancel} onConfirm={() => { void state.confirm(); }} />}
  </section>;
}
