import React, { useId } from 'react';
import type { ControlRunHistorySnapshot } from '../../shared/controlRunHistory';
import type { ControlApiError } from '../control/api';

export function RunHistoryPicker({ snapshot, runId, loading, error, onSelect, onRefresh, onEarlier }: {
  snapshot: ControlRunHistorySnapshot | null; runId?: string; loading: boolean; error: ControlApiError | null;
  onSelect(runId?: string): void; onRefresh(): void; onEarlier(): void;
}) {
  const id = useId();
  return <section className="task-conversation" aria-label="Run history">
    <label htmlFor={id}>Task / run</label>
    <select id={id} value={runId ?? ''} onChange={event => onSelect(event.target.value || undefined)}>
      <option value="">Live / latest task</option>
      {runId && !snapshot?.runs.some(run => run.runId === runId) && <option value={runId}>Selected run · {runId}</option>}
      {snapshot?.runs.map(run => <option key={run.runId} value={run.runId}>{run.at === undefined ? 'Recorded run' : new Date(run.at).toLocaleString()} · {run.runId}</option>)}
    </select>
    <button type="button" aria-disabled={loading} onClick={() => { if (!loading) onRefresh(); }}>Refresh run history</button>
    {snapshot?.nextCursor && <button type="button" aria-disabled={loading} onClick={() => { if (!loading) onEarlier(); }}>Load earlier runs</button>}
    {loading && <p role="status">Loading recorded runs…</p>}
    {error && <p role="alert">{error.message}</p>}
    {snapshot && <p className="task-muted">History snapshot: {new Date(snapshot.source.observedAt).toLocaleString()} · {snapshot.loadedRecords.toLocaleString()} records loaded{snapshot.source.state === 'stale' ? ' · Last known — connection unavailable' : ''}. This is the loaded subset of recorded runs.</p>}
    {snapshot?.runsTruncated && <p className="task-muted">Showing up to 100 recorded run choices.</p>}
    {snapshot?.limitReached && <p className="task-muted">History discovery reached its record or size limit.</p>}
    {runId && <p className="task-notice">Recorded run selected. This view is read-only. Return to Live / latest task to send a message or control active work.</p>}
    {snapshot?.outcome && <p className="task-muted">Run outcome evidence: {snapshot.outcome.state === 'recorded' ? 'source-correlated audit metadata' : snapshot.outcome.state === 'ambiguous' ? 'ambiguous; outcome remains unknown' : 'unavailable; outcome remains unknown'} · checked {new Date(snapshot.outcome.observedAt).toLocaleString()}.</p>}
    {runId && snapshot && !snapshot.task && <p>No facts for this run are in the loaded window. Load earlier runs to continue discovery.</p>}
  </section>;
}
export function HistoricalConversation({ snapshot }: { snapshot: ControlRunHistorySnapshot | null }) {
  return <section className="agent-conversation" aria-label="Recorded run messages">
    <p className="task-muted">Only messages explicitly tagged with the selected run ID are shown. Historical completion and timing are unknown when the Gateway supplies no matching terminal fact.</p>
    <ol className="conversation-messages" aria-label="Recorded messages">{snapshot?.messages.map((message, index) => <li key={`${message.id}:${index}`} className={`conversation-${message.role}`}><strong>{message.role === 'user' ? 'You / recorded user' : 'Agent'}</strong><p>{message.text}</p>{message.truncated && <span className="task-muted">Text shortened for display.</span>}</li>)}</ol>
    {!snapshot?.messages.length && <p className="task-muted">No visible messages for this run in the loaded window.</p>}
    {snapshot?.messagesTruncated && <p className="task-muted">The recorded message list was shortened for display.</p>}
    <p className="task-muted">At most 50 display messages from the loaded run window are shown.</p>
  </section>;
}
