import React, { useEffect, useRef } from 'react';
import { WORKSPACE_LIMITS, isWorkspacePath, workspaceFileLimit } from '../../shared/controlWorkspace';
import { useWorkspace } from '../control/useWorkspace';
import { ControlApiError } from '../control/api';
import { ControlAccessPanel } from './ControlAccessPanel';
import './AgentWorkspace.css';

function workspaceError(error: ControlApiError | null): string | undefined {
  if (!error) return;
  if (error.code === 'unsupported') return 'This Gateway does not support workspace browsing. Task and conversation access are still available.';
  if (error.code === 'file-unavailable') return 'This file or folder no longer exists. Refresh or use the breadcrumbs to return to an existing folder.';
  if (error.code === 'invalid-target') return 'This agent is no longer available. Select an available agent.';
  if (error.code === 'invalid-request') return 'OpenClaw refused this workspace path or request. Use the breadcrumbs to choose another folder.';
  if (error.code === 'preview-unsupported') return 'This file format is not supported for the requested action.';
  if (error.code === 'unavailable' || error.code === 'invalid-source') return 'The workspace is temporarily unavailable. Refresh to try again.';
  return error.message;
}
function size(value: number): string { return value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1048576).toFixed(1)} MiB`; }
export function AgentWorkspace({ agentId, active }: { agentId: string; active: boolean }) {
  const workspace = useWorkspace({ agentId, active }); const page = workspace.page;
  const previewRef = useRef<HTMLElement>(null);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (workspace.preview) previewRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [workspace.preview]);
  const current = page?.source.state === 'current'; const parts = workspace.path ? workspace.path.split('/') : [];
  const preview = workspace.preview && <section ref={previewRef} className="workspace-preview" aria-label="Workspace file preview">
    <div className="workspace-preview-title"><h4>{workspace.preview.name}</h4><button type="button" onClick={() => { workspace.clearPreview(); previewTrigger.current?.focus(); }}>Close preview</button></div>
    {workspace.preview.kind === 'text' ? workspace.preview.text ? <pre>{workspace.preview.text}</pre> : <p>This file is empty.</p> : <img src={workspace.preview.url} alt={`Preview of ${workspace.preview.name}`} />}
  </section>;
  return <ControlAccessPanel active={active} loading={workspace.loading} onRefresh={workspace.refresh} error={workspaceError(workspace.error)}>
    <section className="agent-workspace" aria-label="Agent workspace">
      <h3>Workspace</h3><p className="task-muted">Read-only files for this agent. Files may belong to any conversation.</p>
      <p role="status" aria-live="polite" aria-label="Preview status" className="task-muted">{workspace.preview ? `Preview ready: ${workspace.preview.name}` : ''}</p>
      <nav className="workspace-breadcrumbs" aria-label="Workspace folders">
        <button type="button" aria-label="Workspace root" onClick={() => workspace.navigate('')}>Workspace root</button>
        {parts.map((part, index) => <React.Fragment key={index}><span aria-hidden="true">/</span><button type="button" onClick={() => workspace.navigate(parts.slice(0, index + 1).join('/'))} aria-current={index === parts.length - 1 ? 'location' : undefined}>{part}</button></React.Fragment>)}
      </nav>
      {workspace.loading && !page && <p role="status">Loading workspace…</p>}
      {page && <>
        <p className="task-muted">{current ? 'Checked by OpenClaw' : 'Last known — connection unavailable'} · {new Date(page.source.observedAt).toLocaleString()}</p>
        {page.totalEntries === 0 && <p>This folder is empty.</p>}
        <ul className="workspace-entries" aria-label="Workspace entries">
          {page.entries.map(entry => {
            const pathAllowed = isWorkspacePath(entry.path);
            const pathNotice = !pathAllowed && <p className="task-muted">This path exceeds the 2,048-character browsing limit.</p>;
            if (entry.kind === 'directory') return <li key={entry.path}><button className="workspace-folder" type="button" aria-disabled={!pathAllowed} aria-label={`Open folder ${entry.name}`} onClick={() => { if (pathAllowed) workspace.navigate(entry.path); }}><span aria-hidden="true">📁</span> {entry.name}</button>{pathNotice}</li>;
            const known = entry.size !== undefined && entry.updatedAtMs !== undefined;
            const oversized = known && entry.size! > workspaceFileLimit(entry.path);
            const available = current && known && pathAllowed && !oversized && workspace.contentLoading === null;
            const raster = /\.(png|jpe?g|webp)$/i.test(entry.name);
            const otherImage = /\.(avif|bmp|gif|heic|heif)$/i.test(entry.name);
            return <li key={entry.path}>
              <div className="workspace-file-name">{entry.name}</div>
              {pathNotice}
              <p className="task-muted">{entry.size === undefined ? 'Size unknown' : size(entry.size)}{entry.updatedAtMs === undefined ? '' : ` · ${new Date(entry.updatedAtMs).toLocaleString()}`}</p>
              {!known && <p className="task-muted">File details unavailable. Refresh before opening.</p>}
              {oversized && <p className="task-muted">Too large for workspace reads ({size(workspaceFileLimit(entry.path))} limit).</p>}
              <div className="workspace-actions">
                {!otherImage && <button type="button" aria-label={`Preview ${entry.name}`} aria-disabled={!available} onClick={event => { if (available) { previewTrigger.current = event.currentTarget; void workspace.act(entry, 'preview'); } }}>Preview{raster ? ' image' : ''}</button>}
                <button type="button" aria-label={`Download ${entry.name}`} aria-disabled={!available} onClick={() => { if (available) void workspace.act(entry, 'download'); }}>Download</button>
                {workspace.contentLoading === entry.path && <span role="status">Loading file…</span>}
              </div>
              {workspace.preview?.path === entry.path && preview}
            </li>;
          })}
        </ul>
        <div className="workspace-pagination" aria-label="Workspace pages">
          <button type="button" aria-disabled={workspace.loading || page.offset === 0} onClick={() => { if (!workspace.loading && page.offset > 0) workspace.navigate(page.path, Math.max(0, page.offset - WORKSPACE_LIMITS.pageSize)); }}>Previous page</button>
          <span>{page.totalEntries ? `${page.offset + 1}–${page.offset + page.entries.length} of ${page.totalEntries}` : '0 files'}</span>
          <button type="button" aria-disabled={workspace.loading || page.offset + WORKSPACE_LIMITS.pageSize >= page.totalEntries || page.offset >= WORKSPACE_LIMITS.maxOffset} onClick={() => {
            if (!workspace.loading && page.offset < WORKSPACE_LIMITS.maxOffset && page.offset + WORKSPACE_LIMITS.pageSize < page.totalEntries) workspace.navigate(page.path, page.offset + WORKSPACE_LIMITS.pageSize);
          }}>Next page</button>
        </div>
        {page.offset >= WORKSPACE_LIMITS.maxOffset && page.offset + page.entries.length < page.totalEntries && <p className="task-muted">Workspace browsing limit reached. Open a smaller subfolder.</p>}
      </>}
      <p className="task-muted">Text up to 256 KiB; images up to 1 MiB. Other binary files are unavailable through this read-only interface. Folder contents can change while agents work.</p>
    </section>
  </ControlAccessPanel>;
}
