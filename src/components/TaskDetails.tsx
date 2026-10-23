import React, { useEffect, useId, useState } from 'react';
import { type ControlRunState } from '../../shared/control';
import { useControlAccess } from '../control/ControlAccess';
import { ControlApiError, targetIdentity } from '../control/api';
import { useTaskDetails } from '../control/useTaskDetails';
import './TaskDetails.css';

const runLabels: Record<ControlRunState, string> = { running: 'Running', completed: 'Completed', failed: 'Failed', aborted: 'Stopped', 'not-running': 'Not running', unknown: 'Unknown' };
const outcomeLabels = { pending: 'No result recorded', success: 'Success recorded', error: 'Error recorded', unknown: 'Outcome unavailable' };
const time = (value: number) => new Date(value).toLocaleString();

export function TaskDetails({ agentId, initialSessionKey, active }: { agentId: string; initialSessionKey: string; active: boolean }) {
  const access = useControlAccess(); const state = useTaskDetails({ agentId, initialSessionKey, active });
  const [key, setKey] = useState(''); const [unlocking, setUnlocking] = useState(false); const [accessError, setAccessError] = useState<ControlApiError | null>(null);
  const keyId = useId(); const selectorId = useId();
  const task = state.task && access.status?.canRead === false
    ? { ...state.task, source: { ...state.task.source, state: 'stale' as const } } : state.task;
  useEffect(() => {
    if (!active) return;
    let disposed = false; const controller = new AbortController();
    const check = async () => {
      if (document.visibilityState === 'hidden') return;
      try { await access.request('/api/control/status', { signal: controller.signal }); if (!disposed) setAccessError(null); }
      catch (error) { if (!disposed) setAccessError(error instanceof ControlApiError ? error : new ControlApiError()); }
    };
    void check(); const timer = access.state === 'unlocked' ? setInterval(() => { void check(); }, 5000) : undefined;
    return () => { disposed = true; controller.abort(); clearInterval(timer); };
  }, [active, access.state, access.request]);
  const refresh = async () => {
    if (state.loading || state.sessionsLoading) return;
    try { await access.request('/api/control/status'); setAccessError(null); await state.refresh(); }
    catch (error) { setAccessError(error instanceof ControlApiError ? error : new ControlApiError()); }
  };
  if (access.state === 'locked') {
    if (!access.status && !accessError && !unlocking) return <section className="task-details task-access" aria-label="Task access"><p role="status">Checking task access…</p></section>;
    const setup = access.status?.configured === false;
    const transport = accessError?.code === 'transport-required';
    return <section className="task-details task-access" aria-label="Task access">
      <p className="task-eyebrow">FROM OPENCLAW</p>
      <h3>{setup ? 'Task access is not connected' : transport ? 'A secure connection is required' : 'Unlock task details'}</h3>
      <p>{setup ? 'Connect the office to OpenClaw to see real requests, run state and recorded activity. Your office roster continues to update normally.'
        : transport ? 'Use HTTPS or the office’s configured private Tailnet connection before entering an access key.' : 'Use the office task access key. It stays in this tab until you lock it or reload the page.'}</p>
      {!setup && !transport && <form onSubmit={async event => {
        event.preventDefault(); if (unlocking) return; setUnlocking(true); setAccessError(null);
        try { await access.unlock(key); } catch (error) { setAccessError(error instanceof ControlApiError ? error : new ControlApiError()); }
        finally { setKey(''); setUnlocking(false); }
      }}>
        <label htmlFor={keyId}>Task access key</label>
        <input id={keyId} type="password" autoComplete="off" value={key} maxLength={4096} onChange={event => setKey(event.target.value)} />
        <button type="submit" disabled={!key || unlocking}>{unlocking ? 'Unlocking…' : 'Unlock task details'}</button>
      </form>}
      {accessError && !['locked', 'transport-required'].includes(accessError.code) && <p role="alert">{accessError.message}</p>}
      {(setup || transport || accessError?.code === 'unavailable') && <button type="button" onClick={() => { void refresh(); }}>Check connection</button>}
    </section>;
  }
  return <div className="task-details">
    <div className="task-tools"><span className="task-eyebrow">FROM OPENCLAW</span><button type="button" onClick={access.lock}>Lock</button><button type="button" aria-disabled={state.loading || state.sessionsLoading} onClick={() => { void refresh(); }}>Refresh</button></div>
    {access.status && !access.status.canRead && <p role="status">{new ControlApiError(access.status.state === 'pairing-required' ? 'pairing-required' : access.status.state === 'auth-error' ? 'scope-required' : access.status.state === 'unsupported' ? 'unsupported' : 'unavailable').message}</p>}
    <div className="task-conversation">
      <label htmlFor={selectorId}>Conversation</label>
      <select id={selectorId} value={state.selected ? targetIdentity(state.selected) : ''} onChange={event => {
        const selected = state.sessions.find(item => targetIdentity(item) === event.target.value); if (selected) state.selectSession(selected);
      }}>
        {!state.selected && <option value="">{state.sessionsLoading ? 'Loading conversations…' : 'Choose a conversation'}</option>}
        {state.sessions.map(item => <option key={targetIdentity(item)} value={targetIdentity(item)}>{item.name}{item.channel ? ` · ${item.channel}` : ''}{item.isChild ? ' · Child session' : ''} · {item.hasActiveRun === true ? 'Running' : item.hasActiveRun === false ? 'Not running' : 'State unknown'} · {item.sessionId.slice(0, 8)}</option>)}
      </select>
      {state.selectionNote && <p className="task-muted">{state.selectionNote}</p>}
      {state.nextSessionsCursor && <button type="button" aria-disabled={state.sessionsLoading} onClick={() => { if (!state.sessionsLoading) void state.loadMoreSessions(); }}>Load more conversations</button>}
      {!state.sessionsLoading && !state.sessions.length && !state.error && access.status?.canRead && <p>No visible conversations for this agent yet.</p>}
    </div>
    {(state.error || accessError) && <p className="task-notice" role="alert">{(state.error ?? accessError)?.message}</p>}
    {state.loading && !task && <p role="status">Loading verified task facts…</p>}
    {task && <>
      <p className="task-announcement" role="status" aria-label="Task updates" aria-live="polite" aria-atomic="true">{runLabels[task.runState]} task. {task.runId ? `Following run ${task.runId}.` : 'Task identity unavailable.'}</p>
      <section className="task-state" aria-label="Run state">
        <div className="task-state-line"><strong className={`task-run-${task.runState}`}>{runLabels[task.runState]}</strong><span className="task-muted">{task.source.state === 'stale' ? 'Last known — connection unavailable' : 'Verified by OpenClaw'}</span></div>
        <p className="task-muted">{time(task.source.observedAt)}</p>
        {task.hasActiveRun === true && !task.runId && <p>Current task identity unavailable</p>}
        {task.runId && <p className="task-muted">Run {task.runId}</p>}
        {task.startedAt !== undefined && <p>Started {time(task.startedAt)}</p>}
        {task.endedAt !== undefined && <p>Ended {time(task.endedAt)}</p>}
        {task.startedAt !== undefined && task.endedAt !== undefined && task.endedAt >= task.startedAt && <p>Duration {Math.round((task.endedAt - task.startedAt) / 1000)} seconds</p>}
        {task.model && <p className="task-muted">Conversation model: <span>{task.model}</span></p>}
      </section>
      <section className="task-block"><h3>{task.requestAssociation === 'latest-recorded' ? 'Latest recorded request' : 'Task request'}</h3>
        {task.request && <><p className="task-text task-request">{task.request.text}</p>{task.request.truncated && <p className="task-muted">Request text shortened for display.</p>}</>}
        {task.requestAssociation === 'latest-recorded' && <p className="task-muted">Recorded context; its association with current work is unknown.</p>}
        {task.requestState !== 'found' && <p>{task.requestState === 'limit-reached' ? 'Discovery limit reached: 2,000 records. The current task request is outside the loaded window.' : task.requestState === 'not-loaded' ? 'Task request not loaded.' : 'No task request is available in the recorded history.'}</p>}
        {task.nextCursor && <button type="button" aria-disabled={state.loading} onClick={() => { if (!state.loading) void state.loadEarlier(); }}>Load earlier records</button>}
      </section>
      <section className="task-block"><h3>Recent recorded activity</h3>
        {task.activity.length ? <ol className="task-activity">{task.activity.map((item, index) => <li key={`${item.id}:${index}`}><strong>{item.toolName}</strong><span>{outcomeLabels[item.outcome]}</span>{item.at !== undefined && <time dateTime={new Date(item.at).toISOString()}>{time(item.at)}</time>}</li>)}</ol> : <p className="task-muted">No tool activity in the loaded window.</p>}
      </section>
      {task.latestResponse && task.latestResponse.id !== task.result?.id && <section className="task-block"><h3>Latest visible response</h3><p className="task-text">{task.latestResponse.text}</p>{task.latestResponse.truncated && <p className="task-muted">Response text shortened for display.</p>}</section>}
      {task.result && <section className="task-block"><h3>Result</h3><p className="task-text">{task.result.text}</p>{task.result.truncated && <p className="task-muted">Result text shortened for display.</p>}</section>}
      <section className="task-block"><h3>Related child sessions{task.childrenComplete ? ` (${task.children.length})` : ' — loaded subset'}</h3>
        {task.children.length ? <ul className="task-children">{task.children.map(child => <li key={targetIdentity(child)}>{child.agentId !== agentId ? `${child.agentId} · ` : ''}{child.name} · {child.hasActiveRun === true ? 'Running' : child.hasActiveRun === false ? 'Not running' : 'State unknown'}</li>)}</ul> : <p className="task-muted">No related children in the loaded subset.</p>}
      </section>
      <p className="task-muted">Task facts follow this conversation. Office activity is a separate roster summary.</p>
    </>}
  </div>;
}
