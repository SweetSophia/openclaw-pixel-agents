import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ControlTaskSnapshot } from '../../shared/control';
import { currentDirectRun, parseControlStopReceipt, type ControlStopReceipt } from '../../shared/controlRun';
import { useControlAccess } from '../control/ControlAccess';
import { ControlApiError, targetIdentity } from '../control/api';
import './RunControls.css';

export function RunControls({ task, active, readOnly = false, onRefresh }: { task: ControlTaskSnapshot; active: boolean; readOnly?: boolean; onRefresh(): unknown }) {
  const access = useControlAccess(); const stopButton = useRef<HTMLButtonElement>(null); const cancelButton = useRef<HTMLButtonElement>(null); const reasonId = useId();
  const [confirm, setConfirm] = useState(false); const [phase, setPhase] = useState<ControlStopReceipt['phase'] | 'sending' | null>(null); const [error, setError] = useState<ControlApiError | null>(null);
  const scope = JSON.stringify([targetIdentity(task.target), task.runId, access.generation, readOnly]);
  const context = useRef({ scope, active, access, task, readOnly }); context.current = { scope, active, access, task, readOnly };
  const attempted = useRef<string | null>(null); const mounted = useRef(true);
  const cancel = useCallback(() => { setConfirm(false); if (context.current.active) stopButton.current?.focus(); }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (confirm) cancel(); setPhase(null); setError(null); }, [scope, cancel]);
  const runId = currentDirectRun(task);
  const reason = readOnly ? 'Run history is read-only. Return to Live / latest task to use Stop.'
    : !active || access.state !== 'unlocked' || !access.status?.canRead ? 'Reconnect and unlock to use Stop.'
      : !access.status.canStop ? access.status.stopDisabledReason === 'scope-required' ? 'Stop requires enabled write access.' : 'This Gateway has not enabled exact-run Stop.'
        : !runId ? 'Stop needs fresh, unambiguous direct-run facts. Refresh the task.' : '';
  const blocked = !!reason || phase !== null || attempted.current === scope;
  useEffect(() => { if (confirm && (reason || !active)) cancel(); }, [reason, active, confirm, cancel]);
  useEffect(() => { if (confirm) cancelButton.current?.focus(); }, [confirm]);
  async function stop() {
    if (!confirm || blocked || !runId || currentDirectRun(context.current.task) !== runId) { cancel(); return; }
    const currentScope = scope; attempted.current = scope; setConfirm(false); setPhase('sending'); setError(null);
    const stillSelected = () => mounted.current && context.current.scope === currentScope && !context.current.readOnly && context.current.access.state === 'unlocked';
    const refreshActive = () => { if (context.current.active) { void onRefresh(); stopButton.current?.focus(); } };
    try {
      const receipt = parseControlStopReceipt(await access.request(`/api/control/agents/${encodeURIComponent(task.target.agentId)}/stop`, {
        method: 'POST', body: JSON.stringify({ target: task.target, runId }),
      }));
      if (!stillSelected()) return;
      if (!receipt || targetIdentity(receipt.target) !== targetIdentity(task.target) || receipt.runId !== runId) throw new ControlApiError('invalid-source');
      setPhase(receipt.phase); refreshActive();
    } catch (failure) {
      if (!stillSelected()) return;
      const problem = failure instanceof ControlApiError ? failure : new ControlApiError();
      if (['unavailable', 'timed-out', 'invalid-source', 'outcome-unknown'].includes(problem.code)) { setPhase('unknown'); refreshActive(); }
      else { setPhase(null); setError(problem); }
      if (context.current.active) stopButton.current?.focus();
    }
  }
  return <section className="run-controls" aria-label="Current run controls">
    <button type="button" ref={stopButton} aria-disabled={blocked} aria-describedby={reason ? reasonId : undefined} onClick={() => { if (!blocked) setConfirm(true); }}>Stop run</button>
    {reason && <p id={reasonId} className="task-muted">{reason}</p>}
    {confirm && <div role="group" aria-label="Confirm Stop" className="run-stop-confirmation" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
      <p>Stop run <strong>{runId}</strong> in this conversation? Controlled child work may also stop. Queued follow-ups are not cleared.</p>
      <div className="run-stop-actions"><button type="button" ref={cancelButton} onClick={cancel}>Cancel Stop</button><button type="button" aria-disabled={blocked} onClick={() => { void stop(); }}>Confirm Stop</button></div>
    </div>}
    {phase && <p role="status" aria-live="polite">{phase === 'sending' ? 'Requesting Stop…' : phase === 'requested' ? 'Stop requested. Refresh task facts to verify its final state.'
      : phase === 'not-running' ? 'That exact run was no longer active. No other run was selected.' : 'Stop outcome is unknown. Refresh task facts before taking another action; cancellation is not replayed automatically.'}</p>}
    {error && <p role="alert">{error.message}</p>}
  </section>;
}
