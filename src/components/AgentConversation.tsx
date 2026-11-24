import React, { useId, useRef } from 'react';
import { CONTROL_LIMITS, type ControlTarget } from '../../shared/control';
import { useConversation } from '../control/useConversation';
import { useImageAttachments } from '../control/useImageAttachments';
import { ConversationAttachment } from './ConversationAttachment';
import { ConversationModel } from './ConversationModel';
import './AgentConversation.css';
interface Props { target: ControlTarget | null; agentId: string; active: boolean; busy?: boolean; readOnly?: boolean; onCreated?(target: ControlTarget): void }
export function AgentConversation(props: Props) {
  // Unmount the live hook and form in recorded mode; private provider drafts survive it.
  return props.readOnly ? null : <LiveConversation {...props} />;
}
function LiveConversation({ target, agentId, active, busy, onCreated }: Props) {
  const imageGuard = useRef(false);
  const state = useConversation(target, active, { agentId, onCreated, attachmentBlocked: () => imageGuard.current });
  const image = useImageAttachments({ agentId, target, active, readOnly: false, isNew: state.isNew, intent: state.intent, message: state.draft, textPending: state.pending, onRecorded: state.clearRecordedDraft });
  imageGuard.current = !!image.selection || !!image.review || image.pending;
  const messageId = useId(); const hintId = useId(); const intentId = useId(); const deliveryHintId = useId();
  const blocked = imageGuard.current || !!state.disabledReason || state.pending || !state.draft.trim() || state.draft.length > CONTROL_LIMITS.prompt;
  const send = () => { if (!blocked) void state.send(); };
  const labels = { sending: 'Sending…', accepted: 'Accepted — waiting for transcript persistence', persisted: 'Persisted in the conversation', unknown: 'Outcome unknown — your recovery draft is kept', rejected: 'Not accepted — your draft is kept' };
  return <section className="agent-conversation" aria-label="Conversation messages">
    <ConversationModel target={target} active={active} readOnly={state.isNew} busy={busy} />
    <div className="conversation-actions"><button type="button" onClick={state.newConversation}>New conversation</button><button type="button" aria-disabled={state.loading} onClick={() => { if (!state.loading) void state.refresh(); }}>Refresh conversation</button></div>
    {state.isNew && <p className="task-notice">New conversation with {agentId}. It will be created when you send.</p>}
    {state.isNew && target && <button type="button" onClick={state.returnToConversation}>Return to selected conversation</button>}
    {state.stale && <p role="status">Last known history — connection unavailable.</p>}
    {state.nextCursor && <button type="button" aria-disabled={state.loading} onClick={() => { if (!state.loading) void state.loadEarlier(); }}>Load earlier messages</button>}
    <ol className="conversation-messages" aria-label="Recorded messages">{state.messages.map(message => <li key={message.id} className={`conversation-${message.role}`}><strong>{message.role === 'user' ? 'You / recorded user' : 'Agent'}</strong><p>{message.text}</p>{message.truncated && <span className="task-muted">Text shortened for display.</span>}</li>)}</ol>
    {!state.messages.length && !state.loading && !state.isNew && <p className="task-muted">No visible messages in this history window.</p>}
    {state.loading && <p role="status">Loading recorded messages…</p>}
    {state.error && <p role="alert">{state.error.message}</p>}
    {state.submission && <p role="status" className="task-notice">{labels[state.submission.phase]}</p>}
    {!imageGuard.current && state.submission && ['unknown', 'accepted', 'rejected'].includes(state.submission.phase) && <button type="button" aria-disabled={!!state.retryDisabledReason} onClick={() => { if (!state.retryDisabledReason) void state.retryPending(); }}>Retry original submission</button>}
    {state.pending && <p className="task-muted">Retry checks the original message, delivery mode and submission ID. Edits below are kept separately until that submission is settled.</p>}
    <label htmlFor={intentId}>Message delivery</label>
    <select id={intentId} value={state.intent} aria-describedby={deliveryHintId} onChange={event => state.setIntent(event.target.value === 'steer' ? 'steer' : 'followup')}>
      <option value="followup">Follow-up (default)</option><option value="steer">Steer conversation</option>
    </select>
    <p id={deliveryHintId} className="task-muted">{state.intent === 'steer' ? "Steering targets this conversation's direct work at admission, not a previously observed run. It can start a new turn if the conversation becomes idle." : 'A follow-up queues behind current work without interrupting it.'}</p>
    <label htmlFor={messageId}>Message</label>
    <textarea id={messageId} rows={5} maxLength={CONTROL_LIMITS.prompt} value={state.draft} aria-describedby={hintId} onChange={event => state.setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); if (imageGuard.current) { if (image.selection && !image.review && !image.pending && !image.disabledReason) void image.prepare(); } else send(); } }} />
    <p id={hintId} className="task-muted">{state.draft.length.toLocaleString()} / {CONTROL_LIMITS.prompt.toLocaleString()} · Enter adds a line. {imageGuard.current ? 'Ctrl/Cmd+Enter can open image review, never confirm it.' : 'Ctrl/Cmd+Enter sends.'}</p>
    {state.disabledReason && <p role="status">{state.disabledReason}</p>}
    <button type="button" className="conversation-send" aria-disabled={blocked} onClick={send}>{state.intent === 'steer' ? 'Steer conversation' : busy && !state.isNew ? 'Send follow-up' : 'Send'}</button>
    {active && !state.isNew && state.intent === 'followup' && target && <ConversationAttachment form={image} target={target} />}
    {image.pending && (state.isNew || state.intent !== 'followup') && <p role="status">An original image submission is unresolved. Return to live Follow-up to check it; text sending stays blocked.</p>}
    <p className="task-muted">{imageGuard.current || image.receipt ? 'Image follow-ups queue without interrupting current work. Lock and reload clear local drafts and markers, but do not undo an admitted send.' : 'Messages stay in this conversation. Sending a follow-up does not interrupt current work. Lock and reload clear private drafts and retry identities.'}</p>
  </section>;
}
