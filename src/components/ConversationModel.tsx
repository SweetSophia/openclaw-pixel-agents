import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ControlTarget } from '../../shared/control';
import type { ControlModelDisabledReason } from '../../shared/controlModels';
import { useConversationModels } from '../control/useConversationModels';
import './ConversationModel.css';

const defaultLabel = 'Use configured default for this conversation';
const reasons: Record<Exclude<ControlModelDisabledReason, null>, string> = {
  busy: 'This conversation has active work. Refresh after it becomes idle.',
  'activity-unknown': 'Conversation activity is unknown. Refresh when idle activity can be verified.',
  'read-only': 'This model connection is read-only. Other conversation controls are unchanged.',
  permission: 'Manual model selection is not permitted for this conversation.',
  'selection-unknown': 'The current model selection is unknown. Refresh to inspect it.',
  unsupported: 'This Gateway does not support conversation model selection.',
};
type ModelConfirmation = NonNullable<ReturnType<typeof useConversationModels>['confirmation']>;
function Confirmation({ value, onCancel, onConfirm }: { value: ModelConfirmation; onCancel(): void; onConfirm(): void }) {
  const cancel = useRef<HTMLButtonElement>(null); const confirm = useRef<HTMLButtonElement>(null); const heading = useId();
  useLayoutEffect(() => { cancel.current?.focus(); }, []);
  return <div className="model-confirmation" role="dialog" aria-modal="true" aria-labelledby={heading} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
    if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); (document.activeElement === cancel.current ? confirm.current : cancel.current)?.focus(); }
  }}>
    <h3 id={heading}>Confirm model preference</h3>
    <p>Agent: <span>{value.target.agentId}</span></p><p>Conversation: <span>{value.target.sessionKey}</span></p><p>Session: <span>{value.target.sessionId}</span></p>
    <p>Observed current model: <span>{value.currentModel ?? 'Unknown'}</span></p>
    <p>Requested preference: <span>{value.model ?? defaultLabel}</span></p>
    <p>Work starting after the idle check may switch models or restart under the Gateway's native behavior. This is not a future-turn-only guarantee.</p>
    <p>This changes only this conversation's preference. Confirmation does not prove that a model has executed.</p>
    <div className="model-actions"><button type="button" ref={cancel} onClick={onCancel}>Cancel</button><button type="button" ref={confirm} onClick={onConfirm}>Confirm model preference</button></div>
  </div>;
}
export function ConversationModel({ target, active, readOnly = false, busy = false }: { target: ControlTarget | null; active: boolean; readOnly?: boolean; busy?: boolean }) {
  const state = useConversationModels(target, active && !readOnly && !busy); const selectId = useId(); const hintId = useId();
  const root = useRef<HTMLElement>(null); const heading = useRef<HTMLHeadingElement>(null); const apply = useRef<HTMLButtonElement>(null); const refresh = useRef<HTMLButtonElement>(null);
  const previous = useRef<string | null>(null); const [, tick] = useState(0);
  const confirmation = state.enabled && !readOnly && state.canApply && state.confirmation?.owner === state.owner ? state.confirmation : null;
  useEffect(() => { if (!state.enabled) return; const timer = setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(timer); }, [state.enabled]);
  useLayoutEffect(() => {
    const prior = previous.current; previous.current = confirmation?.owner ?? null;
    if (!prior || confirmation || prior !== state.owner || !active || readOnly || !state.enabled || document.visibilityState === 'hidden' || root.current?.closest('[hidden], [inert]')) return;
    (apply.current?.isConnected && !apply.current.disabled ? apply.current : refresh.current?.isConnected && !refresh.current.disabled ? refresh.current : heading.current)?.focus();
  });
  if (!active) return null;
  if (readOnly) return <p className="task-notice">Model selection is available for the live conversation only, not recorded runs or new conversation drafts.</p>;
  if (busy) return <p className="task-notice">Model changes are disabled while this conversation has active work. Inspect again after it becomes idle.</p>;
  if (state.disabledReason) return <p className="task-notice">{state.disabledReason}</p>;
  const snapshot = state.snapshot;
  return <section ref={root} className="conversation-model" aria-label="Live conversation model">
    <h3 ref={heading} tabIndex={-1}>Live conversation model</h3>
    <p>Source-observed model information, separate from the office roster. A saved preference is not proof of execution.</p>
    <button ref={refresh} type="button" disabled={!state.enabled || state.loading || state.pending} onClick={() => { void state.refresh(); }}>Refresh models</button>
    {state.loading && <p role="status">Loading conversation models…</p>}
    {state.pending && <p role="status">Model preference request in progress. Hiding this page does not cancel an admitted request.</p>}
    {state.error && <p role="alert">{state.error.message}</p>}
    {state.uncertain && !state.pending && <p role="status">Model outcome unknown. Nothing will be replayed automatically. Explicitly Refresh models to acknowledge newly observed state before another confirmation.</p>}
    {state.outcome === 'confirmed' && <p role="status">Preference confirmed. This does not prove that the model has executed.</p>}
    {snapshot && <>
      <p className="task-muted">{state.stale ? 'Last known — changes disabled; Refresh required' : 'Observed by OpenClaw'} · <time dateTime={new Date(snapshot.observedAt).toISOString()}>{new Date(snapshot.observedAt).toLocaleString()}</time></p>
      <p>Observed current model: <span>{snapshot.currentModel ?? 'Unknown'}</span></p>
      {snapshot.disabledReason && <p>{reasons[snapshot.disabledReason]}</p>}
      <label htmlFor={selectId}>Model preference</label>
      <select id={selectId} value={state.draft === undefined ? '' : state.draft === null ? 'default' : `model:${state.draft}`} aria-describedby={hintId}
        disabled={!snapshot.canChange || state.stale || state.loading || state.pending || state.uncertain} onChange={event => {
          const value = event.target.value;
          if (value === 'default') state.choose(null);
          else if (value.startsWith('model:')) state.choose(value.slice(6));
        }}>
        <option value="" disabled>Choose a preference to inspect</option><option value="default">{defaultLabel}</option>
        {snapshot.choices.map(choice => <option key={choice.id} value={`model:${choice.id}`} disabled={!choice.selectable || choice.available !== true}>
          {choice.label} — {choice.id}{!choice.selectable ? ' — manual selection not permitted' : choice.available === null ? ' — readiness unknown' : !choice.available ? ' — not ready' : ' — ready'}
        </option>)}
      </select>
      <p id={hintId}>Manual-selection permission and model readiness are separate. Only permitted, known-ready choices can be applied. Picking a choice or refreshing does not write.</p>
      {state.draft !== undefined && <p>Requested preference: <span>{state.draft ?? defaultLabel}</span></p>}
      <button ref={apply} type="button" disabled={!state.canApply} onClick={() => { apply.current?.focus(); state.prepare(); }}>Apply model preference</button>
    </>}
    {confirmation && <Confirmation key={`${confirmation.owner}:${confirmation.selectionId}`} value={confirmation} onCancel={state.cancel} onConfirm={() => { void state.confirm(); }} />}
  </section>;
}
