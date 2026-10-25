import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { WORKSPACE_LIMITS, isWorkspacePath, parseWorkspacePage, workspaceFileLimit, type WorkspaceEntry, type WorkspacePage } from '../../shared/controlWorkspace';
import { CONTROL_RESULT_LIMITS } from '../../shared/controlResults';
import { useControlAccess } from './ControlAccess';
import { ControlApiError } from './api';

type Preview = { path: string; name: string } & ({ kind: 'text'; text: string } | { kind: 'image'; url: string });
interface WorkspaceView { page: WorkspacePage | null; loading: boolean; error: ControlApiError | null; preview: Preview | null; contentLoading: string | null }
const empty: WorkspaceView = { page: null, loading: false, error: null, preview: null, contentLoading: null };
export function useWorkspace(options: { agentId: string; active: boolean }) {
  const access = useControlAccess(); const owner = `${options.agentId}:${access.generation}`;
  const [location, setLocation] = useState({ owner, path: '', offset: 0, nonce: 0 });
  const selected = location.owner === owner ? location : { owner, path: '', offset: 0, nonce: 0 };
  const [view, setRendered] = useState<WorkspaceView>(empty); const data = useRef(view);
  const setView = useCallback((update: WorkspaceView | ((old: WorkspaceView) => WorkspaceView)) => {
    const next = typeof update === 'function' ? update(data.current) : update; data.current = next; setRendered(next);
  }, []);
  const context = useRef({ options, access, selected }); context.current = { options, access, selected };
  const readRevision = useRef(0); const contentRevision = useRef(0);
  const listing = useRef<AbortController | null>(null); const content = useRef<AbortController | null>(null);
  // Returning to page one must await the matching load, rather than just scheduling React navigation.
  const pendingRefresh = useRef<{ owner: string; nonce: number; promise: Promise<void>; resolve(): void } | null>(null);
  const finishRefresh = useCallback((directory?: { owner: string; nonce: number }) => {
    const pending = pendingRefresh.current;
    if (pending && (!directory || (pending.owner === directory.owner && pending.nonce === directory.nonce))) {
      pendingRefresh.current = null; pending.resolve();
    }
  }, []);
  const previewEntry = useRef<WorkspaceEntry | null>(null); const urls = useRef(new Set<string>()); const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const permitted = () => context.current.options.active && context.current.access.state === 'unlocked' && context.current.access.status?.canRead && document.visibilityState !== 'hidden';
  const clearPreview = useCallback(() => {
    contentRevision.current++; content.current?.abort(); content.current = null; previewEntry.current = null;
    for (const timer of timers.current) clearTimeout(timer); timers.current.clear();
    for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear();
    setView(old => ({ ...old, preview: null, contentLoading: null }));
  }, [setView]);
  const stop = useCallback(() => { readRevision.current++; listing.current?.abort(); listing.current = null; clearPreview(); }, [clearPreview]);
  const load = useCallback(async (manual = false) => {
    if (!permitted()) return;
    if (listing.current) { if (!manual) return; listing.current.abort(); }
    const current = readRevision.current; const { options: target, selected: directory, access: authority } = context.current;
    const controller = new AbortController(); listing.current = controller;
    const deadline = setTimeout(() => controller.abort(), 10000);
    setView(old => ({ ...old, loading: true, error: manual ? null : old.error }));
    try {
      const page = parseWorkspacePage(await authority.request(`/api/control/agents/${encodeURIComponent(target.agentId)}/workspace`, {
        method: 'POST', signal: controller.signal, body: JSON.stringify({ path: directory.path, offset: directory.offset }) }));
      if (!page || page.agentId !== target.agentId || page.path !== directory.path || page.offset !== directory.offset) throw new ControlApiError('invalid-source');
      if (controller.signal.aborted || current !== readRevision.current || !permitted()) return;
      const prior = data.current.page; const file = previewEntry.current;
      const observed = file && page.entries.find(row => row.path === file.path);
      const changed = !!file && ((prior && prior.sourceRevision !== page.sourceRevision) || !observed || observed.kind !== 'file' || observed.size !== file.size || observed.updatedAtMs !== file.updatedAtMs);
      if (changed) clearPreview();
      setView(old => ({ ...old, page, loading: false, error: changed ? new ControlApiError('workspace-changed')
        : !manual && old.error?.code === 'workspace-changed' ? old.error : null }));
    } catch (error) {
      if (current !== readRevision.current || listing.current !== controller || !permitted()) return;
      clearPreview(); setView(old => ({ ...old, loading: false, error: error instanceof ControlApiError ? error : new ControlApiError(),
        page: old.page ? { ...old.page, source: { ...old.page.source, state: 'stale' } } : null }));
    } finally {
      clearTimeout(deadline);
      if (listing.current === controller) {
        listing.current = null;
        if (current === readRevision.current && controller.signal.aborted) {
          clearPreview(); setView(old => ({ ...old, loading: false, error: new ControlApiError(), page: old.page ? { ...old.page, source: { ...old.page.source, state: 'stale' } } : null }));
        }
      }
      finishRefresh(directory);
    }
  }, [clearPreview, finishRefresh, setView]);
  useLayoutEffect(() => {
    const pending = pendingRefresh.current;
    if (pending && (pending.owner !== owner || pending.nonce !== selected.nonce)) finishRefresh();
    stop();
    if (!options.active || !visible || access.state !== 'unlocked' || ['auth-error', 'pairing-required'].includes(access.status?.state ?? '')) { finishRefresh(); setView(empty); return; }
    const page = data.current.page;
    if (!page || page.agentId !== options.agentId || page.path !== selected.path || page.offset !== selected.offset) setView(empty);
    if (!access.status?.canRead) {
      finishRefresh();
      setView(old => ({ ...old, loading: false, error: new ControlApiError(), page: old.page ? { ...old.page, source: { ...old.page.source, state: 'stale' } } : null })); return;
    }
    void load(); const timer = setInterval(() => { void load(); }, 5000);
    return () => { clearInterval(timer); stop(); };
  }, [owner, selected.path, selected.offset, selected.nonce, options.active, visible, access.state, access.status?.canRead, access.status?.state, finishRefresh, load, setView, stop]);
  useEffect(() => {
    const change = () => { if (document.visibilityState === 'hidden') { stop(); finishRefresh(); setView(empty); } setVisible(document.visibilityState !== 'hidden'); };
    document.addEventListener('visibilitychange', change); return () => { document.removeEventListener('visibilitychange', change); stop(); finishRefresh(); };
  }, [finishRefresh, setView, stop]);
  const navigate = useCallback((path: string, offset = 0) => {
    if (!isWorkspacePath(path) || !Number.isSafeInteger(offset) || offset < 0 || offset > WORKSPACE_LIMITS.maxOffset) return;
    stop(); const current = context.current.selected;
    setView(old => ({ ...old, error: null }));
    setLocation({ owner: current.owner, path, offset, nonce: current.nonce + 1 });
  }, [setView, stop]);
  const refresh = useCallback(async () => {
    if (!permitted()) return;
    if (pendingRefresh.current) return pendingRefresh.current.promise;
    const directory = context.current.selected;
    if (directory.offset === 0) { await load(true); return; }
    let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
    pendingRefresh.current = { owner: directory.owner, nonce: directory.nonce + 1, promise, resolve };
    navigate(directory.path); await promise;
  }, [load, navigate]);
  const act = useCallback(async (entry: WorkspaceEntry, intent: 'preview' | 'download') => {
    const page = data.current.page;
    const currentEntry = page?.entries.find(row => row.path === entry.path && row.kind === 'file' && row.size === entry.size && row.updatedAtMs === entry.updatedAtMs);
    if (!permitted() || page?.source.state !== 'current' || !currentEntry || !isWorkspacePath(entry.path) || entry.size === undefined || entry.updatedAtMs === undefined || entry.size > workspaceFileLimit(entry.path)) return;
    clearPreview(); const current = contentRevision.current; const read = readRevision.current;
    const controller = new AbortController(); content.current = controller; previewEntry.current = entry;
    const deadline = setTimeout(() => controller.abort(), CONTROL_RESULT_LIMITS.contentDeadlineMs);
    const valid = () => current === contentRevision.current && read === readRevision.current && !controller.signal.aborted && permitted();
    setView(old => ({ ...old, error: null, contentLoading: entry.path }));
    try {
      const authority = context.current.access;
      const value = await authority.requestFile(`/api/control/agents/${encodeURIComponent(page.agentId)}/workspace/file`, { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ path: entry.path, offset: page.offset, sourceRevision: page.sourceRevision, expected: { size: entry.size, updatedAtMs: entry.updatedAtMs }, intent }) });
      if (!valid()) return;
      if (value.kind !== 'bytes' || value.blob.size > workspaceFileLimit(entry.path)) throw new ControlApiError('invalid-source');
      if (intent === 'download') {
        const url = URL.createObjectURL(value.blob); urls.current.add(url);
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = value.filename; anchor.hidden = true;
        document.body.append(anchor); try { anchor.click(); } finally { anchor.remove(); }
        const timer = setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); timers.current.delete(timer); }, 1000); timers.current.add(timer);
      } else {
        const mime = value.blob.type.split(';')[0];
        if (mime === 'text/plain' && value.blob.size <= WORKSPACE_LIMITS.textBytes) {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(await value.blob.arrayBuffer());
          if (valid()) setView(old => ({ ...old, preview: { path: entry.path, name: entry.name, kind: 'text', text } }));
        } else if (['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
          const url = URL.createObjectURL(value.blob); urls.current.add(url);
          setView(old => ({ ...old, preview: { path: entry.path, name: entry.name, kind: 'image', url } }));
        } else throw new ControlApiError('preview-unsupported');
      }
    } catch (error) {
      if (valid()) { clearPreview(); setView(old => ({ ...old, error: error instanceof ControlApiError ? error : new ControlApiError('preview-unsupported') })); }
    } finally {
      clearTimeout(deadline);
      if (content.current === controller) {
        content.current = null; setView(old => ({ ...old, contentLoading: null, ...(controller.signal.aborted ? { error: new ControlApiError() } : {}) }));
      }
    }
  }, [clearPreview, setView]);
  return { ...view, path: selected.path, offset: selected.offset, navigate, refresh, act, clearPreview };
}
