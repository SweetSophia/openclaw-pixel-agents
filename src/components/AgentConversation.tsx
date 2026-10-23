import React, { useId } from 'react';
import { CONTROL_LIMITS, type ControlTarget } from '../../shared/control';
import { useConversation } from '../control/useConversation';
import './AgentConversation.css';
export function AgentConversation({ target, agentId, active, busy, onCreated }: { target: ControlTarget | null; agentId: string; active: boolean; busy?: boolean; onCreated?(target: ControlTarget): void }) {
  const state = useConversation(target, active, { agentId, onCreated }); const messageId = useId(); const hintId = useId();
  const blocked = !!state.disabledReason || state.pending || !state.draft.trim() || state.draft.length > CONTROL_LIMITS.prompt;
  const send = () => { if (!blocked) void state.send(); };
  const labels = { sending: 'Sending…', accepted: 'Accepted — waiting for transcript persistence', persisted: 'Persisted in the conversation', unknown: 'Outcome unknown — your recovery draft is kept', rejected: 'Not accepted — your draft is kept' };
  return <section className="agent-conversation" aria-label="Conversation messages">
    <div className="conversation-actions"><button type="button" onClick={state.newConversation}>New conversation</button><button type="button" aria-disabled={state.loading} onClick={() => { if (!state.loading) void state.refresh(); }}>Refresh conversation</button></div>
    {state.isNew && <p className="task-notice">New conversation with {agentId}. It will be created when you send.</p>}
    {state.isNew && target && <button type="button" onClick={state.returnToConversation}>Return to selected conversation</button>}
    {state.stale && <p role="status">Last known history — connection unavailable.</p>}
    {state.nextCursor && <button type="button" aria-disabled={state.loading} onClick={() => { if (!state.loading) void state.loadEarlier(); }}>Load earlier messages</button>}
    <ol className="conversation-messages" aria-label="Recorded messages">{state.messages.map((message, index) => <li key={`${message.id}:${index}`} className={`conversation-${message.role}`}><strong>{message.role === 'user' ? 'You / recorded user' : 'Agent'}</strong><p>{message.text}</p>{message.truncated && <span className="task-muted">Text shortened for display.</span>}</li>)}</ol>
    {!state.messages.length && !state.loading && !state.isNew && <p className="task-muted">No visible messages in this history window.</p>}
    {state.loading && <p role="status">Loading recorded messages…</p>}
    {state.error && <p role="alert">{state.error.message}</p>}
    {state.submission && <p role="status" className="task-notice">{labels[state.submission.phase]}</p>}
    {state.submission && ['unknown', 'accepted', 'rejected'].includes(state.submission.phase) && <button type="button" aria-disabled={!!state.disabledReason} onClick={() => { if (!state.disabledReason) void state.retryPending(); }}>Retry original submission</button>}
    {state.pending && <p className="task-muted">Retry checks the original message and submission ID. Edits below are kept separately until that submission is settled.</p>}
    <label htmlFor={messageId}>Message</label>
    <textarea id={messageId} rows={5} maxLength={CONTROL_LIMITS.prompt} value={state.draft} aria-describedby={hintId} onChange={event => state.setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
    <p id={hintId} className="task-muted">{state.draft.length.toLocaleString()} / 8,000 · Enter adds a line. Ctrl/Cmd+Enter sends.</p>
    {state.disabledReason && <p role="status">{state.disabledReason}</p>}
    <button type="button" className="conversation-send" aria-disabled={blocked} onClick={send}>{busy && !state.isNew ? 'Send follow-up' : 'Send'}</button>
    <p className="task-muted">Messages stay in this conversation. Sending a follow-up does not interrupt current work. Drafts and retry identities stay in this tab until reload.</p>
  </section>;
}
