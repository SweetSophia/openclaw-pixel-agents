import React, { useEffect, useId, useState } from 'react';
import { AGENT_DOCUMENT_NAMES } from '../../shared/controlAgentDocuments';
import { useAgentDocuments } from '../control/useAgentDocuments';
import { useControlAccess } from '../control/ControlAccess';
import './AgentDocuments.css';

interface Props { agentId: string; active: boolean; onDirtyChange?: (dirty: boolean) => void; historical?: boolean; onReturnToLive?: () => void }
export function AgentDocuments({ agentId, active, onDirtyChange, historical = false, onReturnToLive }: Props) {
  const access = useControlAccess(); const owner = `${agentId}:${access.generation}`;
  const [openedOwner, setOpenedOwner] = useState<string | null>(null); const opened = openedOwner === owner;
  const docs = useAgentDocuments({ agentId, active: active && !historical, opened }); const panelId = useId(); const textId = useId();
  const discard = () => !docs.dirty || window.confirm('Discard unsaved document changes? This cannot be undone.');
  useEffect(() => { onDirtyChange?.(docs.dirty); }, [docs.dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  useEffect(() => {
    if (!docs.dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [docs.dirty]);
  const management = docs.management;
  const guidance = !management ? 'Checking document access…' : management.canEdit ? 'Ready — select an existing document to edit.'
    : management.state === 'connecting' ? 'Connecting document access…'
      : management.reason === 'disabled' ? 'Document editing is disabled by the office operator. Read-only Workspace browsing remains available.'
        : management.reason === 'pairing-required' ? 'The separate document device needs approval in OpenClaw. Other panels remain available.'
          : management.reason === 'permission' ? 'The document device requires separately granted read and administrator permission. Other panels remain available.'
            : management.reason === 'unsupported' ? 'Document editing requires a supported stable Gateway 2026.11.2 or newer and its document methods.'
              : 'Document access is temporarily unavailable. Your draft is kept; reload and review before saving.';
  return <section className="agent-documents" aria-label="Agent documents editor">
    <h3><button type="button" aria-expanded={opened} aria-controls={panelId} onClick={() => {
      if (opened && !discard()) return;
      if (opened) docs.reset(); setOpenedOwner(opened ? null : owner);
    }}>Agent documents</button></h3>
    {opened && <div id={panelId}>
      <p className="task-muted">Current agent documents only: existing root files, plain text up to 32 KiB. No autosave, creation, uploads or force overwrite.</p>
      {historical ? <><p>Agent documents belong to the current agent, not this recorded run. Return to live before editing.</p><button type="button" onClick={onReturnToLive}>Return to live conversation</button></> : <>
        <p role="status">{guidance}</p>
        <button type="button" onClick={() => { void docs.refreshManagement(); }}>Check document access</button>
        <div className="agent-documents-actions" aria-label="Document selection">{AGENT_DOCUMENT_NAMES.map(name => <button key={name} type="button"
          disabled={!management?.canEdit || docs.loading || docs.saving} aria-pressed={docs.selected === name}
          onClick={() => { if (discard()) void docs.select(name); }}>Edit {name}</button>)}</div>
        {docs.error && <p role="alert">{docs.error.message}</p>}
        {docs.loading && <p role="status">Reading document…</p>}
        {docs.selected && <p className="agent-document-target">Agent: {agentId} · Document: {docs.selected}</p>}
        {docs.snapshot && <>
          <label htmlFor={textId}>{docs.selected} text for {agentId}</label>
          <textarea id={textId} value={docs.draft} readOnly={docs.loading} spellCheck={false}
            onChange={event => docs.setDraft(event.target.value)}
            onKeyDown={event => { if (event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation(); }}
            onKeyUp={event => event.stopPropagation()} onKeyPress={event => event.stopPropagation()} />
          <p aria-live="polite">{docs.bytes} / 32768 bytes{docs.dirty ? ' · Unsaved changes' : ''}</p>
          {docs.draft === '' && <p>This document is empty.</p>}
          {!docs.valid && <p role="alert">Use valid UTF-8 text without binary control characters, at most 32768 bytes.</p>}
          {!docs.epoch && !docs.loading && <p className="task-notice">Reload and review the current document before another save. Reloading discards your draft; no submission is replayed.</p>}
          {docs.receipt?.state === 'saved' && <p role="status">{docs.dirty
            ? 'Submitted version saved and verified by OpenClaw. Your current draft has unsaved changes.'
            : 'Document saved and verified by OpenClaw.'}</p>}
          <div className="agent-documents-actions">
            <button type="button" disabled={!docs.canSave} onClick={() => { void docs.save(); }}>{docs.saving ? 'Saving document…' : 'Save document'}</button>
            <button type="button" disabled={docs.loading || docs.saving} onClick={() => { if (discard()) void docs.reload(); }}>Reload and review</button>
          </div>
        </>}
      </>}
    </div>}
  </section>;
}
