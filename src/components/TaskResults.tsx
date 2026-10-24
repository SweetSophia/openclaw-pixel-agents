import React, { useEffect, useRef, useState } from 'react';
import { CONTROL_RESULT_LIMITS, controlPreviewKind } from '../../shared/controlResults';
import { useControlAccess } from '../control/ControlAccess';
import { targetIdentity } from '../control/api';
import type { TaskDetailsState } from '../control/useTaskDetails';
import { useResultContent } from '../control/useResultContent';
import './TaskResults.css';

const runLabels = { running: 'Running', completed: 'Completed', failed: 'Failed', aborted: 'Stopped', 'not-running': 'Not running', unknown: 'Unknown' };
const size = (bytes?: number) => bytes === undefined ? 'Size unknown' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

export function TaskResults({ state, active }: { state: TaskDetailsState; active: boolean }) {
  const access = useControlAccess(); const result = state.results;
  const matches = !!result && !!state.selected && targetIdentity(result.target) === targetIdentity(state.selected);
  const current = matches && result.source.state === 'current' && result.artifactState === 'ready' && !!access.status?.canRead;
  const content = useResultContent({ target: matches ? result.target : null, scope: matches ? result.scope : null, sourceRevision: result?.sourceRevision, active, current });
  const [copyNote, setCopyNote] = useState(''); const [imageError, setImageError] = useState(false); const copyGeneration = useRef(0);
  const identity = JSON.stringify([result?.target, result?.scope, result?.response, active, access.generation]);
  useEffect(() => { copyGeneration.current++; setCopyNote(''); setImageError(false); return () => { copyGeneration.current++; }; }, [identity]);
  if (!matches) return <section className="task-results" aria-label="Results and files"><p role="status">{state.loading ? 'Loading results and delivered files…' : state.selected ? 'Results are not available yet. Refresh to check this conversation.' : 'Choose a conversation to see its results and files.'}</p></section>;
  const copy = async () => {
    const generation = copyGeneration.current;
    try {
      if (!navigator.clipboard?.writeText) throw Error(); await navigator.clipboard.writeText(result.response?.text ?? '');
      if (generation === copyGeneration.current) setCopyNote('Displayed text copied.');
    } catch { if (generation === copyGeneration.current) setCopyNote('Select the response text below and copy it manually.'); }
  };
  return <section className="task-results" aria-label="Results and files">
    <p className="task-announcement" role="status" aria-label="Results updates" aria-live="polite" aria-atomic="true">{runLabels[result.runState]}. {result.scope.kind === 'run' ? `Following task ${result.scope.runId}.` : 'Following files shared in this conversation.'}</p>
    <div className="results-state"><strong>{runLabels[result.runState]}</strong><span className="task-muted">{result.source.state === 'stale' || !access.status?.canRead ? 'Last known' : 'Verified by OpenClaw'} · {new Date(result.source.observedAt).toLocaleString()}</span></div>
    <section className="task-block results-response">
      <div className="results-heading"><h3>{result.responseKind === 'result' ? 'Result' : 'Latest response'}</h3>{result.response && <button type="button" onClick={() => { void copy(); }}>Copy displayed text</button>}</div>
      {result.responseKind === 'latest' && <p className="task-notice">Completion is not confirmed. This is the latest visible assistant response.</p>}
      {copyNote && <p role="status">{copyNote}</p>}
      {result.response ? <div role="region" className="task-text results-text" tabIndex={0} aria-label="Response text">{result.response.text}</div> : <p className="task-muted">No visible assistant response yet.</p>}
      {result.response?.truncated && <p className="task-muted">Response shortened for display. Copy includes only the displayed text.</p>}
    </section>
    <section className="task-block" aria-label="Delivered files">
      <h3>Files <span className="results-count">{result.artifacts.length}{result.artifactsTruncated ? '+' : ''}</span></h3>
      <p className="task-muted">Files delivered by the assistant {result.scope.kind === 'run' ? 'for this task.' : 'in this conversation. These may include earlier work.'}</p>
      {!current && result.artifacts.length > 0 && <p className="task-notice">Refresh a current file list before opening files.</p>}
      {result.artifactState === 'unsupported' && <p>This Gateway does not support assistant file discovery. The response above is still available.</p>}
      {result.artifactState === 'unavailable' && <p>The file list is temporarily unavailable. Refresh to try again.</p>}
      {result.artifactState === 'ready' && !result.artifacts.length && <p className="task-muted">No assistant-delivered files in this {result.scope.kind === 'run' ? 'task' : 'conversation'}.</p>}
      {result.artifactsTruncated && <p className="task-notice">Showing the newest delivered files. The file list was shortened.</p>}
      <ul className="results-files">{result.artifacts.map(file => {
        const tooLarge = file.sizeBytes !== undefined && file.sizeBytes > CONTROL_RESULT_LIMITS.transferBytes;
        const blocked = !current || !!content.loadingId || tooLarge || file.download === 'unavailable';
        const act = (intent: 'preview' | 'download') => { if (!blocked) { setImageError(false); void content.act(file.id, intent); } };
        return <li key={file.id} className="results-file"><strong>{file.title}</strong><span className="task-muted">{file.mimeType ?? file.type} · {size(file.sizeBytes)}</span>
          {file.download === 'unavailable' ? <span className="task-muted">This file is not available for download.</span> : <div className="results-actions">
            {controlPreviewKind(file.mimeType) && <button type="button" aria-label={`Preview ${file.title}`} aria-disabled={blocked} onClick={() => act('preview')}>Preview</button>}
            <button type="button" aria-label={`Download ${file.title}`} aria-disabled={blocked} onClick={() => act('download')}>{file.download === 'link' ? 'Get file or link' : 'Download'}</button>
            {content.loadingId === file.id && <span role="status">Loading file…</span>}
          </div>}
          {tooLarge && <span className="task-muted">Above the 16 MiB transfer limit.</span>}
        </li>;
      })}</ul>
      {content.error && <p role="alert" className="task-notice">{content.error.message}</p>}
      {imageError && <p role="alert">This image could not be displayed. Download the file instead.</p>}
      {content.external && <div className="results-external"><p>External link · {content.external.host}</p><a href={content.external.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open {content.external.title} on {content.external.host}</a></div>}
      {content.preview && <section className="results-preview" aria-label="File preview"><div className="results-heading"><h4>Preview</h4><button type="button" onClick={content.clear}>Close preview</button></div>
        {content.preview.kind === 'text' ? <><pre tabIndex={0}>{content.preview.text}</pre>{content.preview.truncated && <p className="task-muted">Preview shortened to 256 KiB. Download for the full file.</p>}</>
          : <img src={content.preview.url} alt="Preview of the delivered file" onError={() => { content.clear(); setImageError(true); }} />}
      </section>}
    </section>
  </section>;
}
