import { useCallback, useEffect, useRef, useState } from 'react';
import { parseControlSessionPage, parseControlTarget, parseControlTaskSnapshot, type ControlSession, type ControlTarget, type ControlTaskSnapshot } from '../../shared/control';
import { useControlAccess } from './ControlAccess';
import { ControlApiError, targetIdentity } from './api';

export interface TaskDetailsState {
  sessions: ControlSession[]; selected: ControlSession | null; task: ControlTaskSnapshot | null;
  loading: boolean; sessionsLoading: boolean; error: ControlApiError | null; selectionNote?: string; nextSessionsCursor?: string;
  selectSession(target: ControlTarget): void; refresh(): Promise<void>; loadMoreSessions(): Promise<void>; loadEarlier(): Promise<void>;
}
export function useTaskDetails(options: { agentId: string; initialSessionKey: string; active: boolean }): TaskDetailsState {
  const access = useControlAccess();
  type View = Omit<TaskDetailsState, 'selectSession' | 'refresh' | 'loadMoreSessions' | 'loadEarlier'>;
  const [view, setRendered] = useState<View>({ sessions: [], selected: null, task: null, loading: false, sessionsLoading: false, error: null });
  const data = useRef(view);
  const setView = useCallback((update: View | ((previous: View) => View)) => {
    const next = typeof update === 'function' ? update(data.current) : update;
    data.current = next; setRendered(next);
  }, []);
  const context = useRef({ ...options, access }); context.current = { ...options, access };
  const scope = `${options.agentId}:${access.generation}`; const scopeRef = useRef(scope);
  const selection = useRef(0); const everSelected = useRef(false);
  const taskRead = useRef<AbortController | null>(null); const sessionRead = useRef<AbortController | null>(null);
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const permitted = () => context.current.active && context.current.access.state === 'unlocked' && context.current.access.status?.canRead && document.visibilityState !== 'hidden';
  const stop = useCallback(() => { selection.current++; taskRead.current?.abort(); sessionRead.current?.abort(); taskRead.current = null; sessionRead.current = null; }, []);
  const readTask = useCallback(async (target: ControlTarget, cursor?: string) => {
    if (!permitted() || taskRead.current) return;
    const controller = new AbortController(); taskRead.current = controller;
    const current = selection.current; const currentScope = scopeRef.current;
    setView(old => ({ ...old, loading: true }));
    try {
      const selected = parseControlTarget(target); if (!selected) throw new ControlApiError('invalid-target');
      const value = parseControlTaskSnapshot(await context.current.access.request(`/api/control/agents/${encodeURIComponent(target.agentId)}/task`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ ...selected, cursor }) }));
      if (!value || targetIdentity(value.target) !== targetIdentity(target)) throw new ControlApiError('invalid-source');
      if (controller.signal.aborted || current !== selection.current || currentScope !== scopeRef.current || !permitted()) return;
      setView(old => old.task && old.task.source.observedAt > value.source.observedAt ? { ...old, loading: false } : { ...old, task: value, loading: false, error: null });
    } catch (error) {
      if (controller.signal.aborted || current !== selection.current || currentScope !== scopeRef.current) return;
      const failure = error instanceof ControlApiError ? error : new ControlApiError();
      setView(old => ({ ...old, loading: false, error: failure, task: ['session-changed', 'invalid-target', 'scope-required', 'locked'].includes(failure.code) ? null
        : old.task ? { ...old.task, source: { ...old.task.source, state: 'stale' } } : null }));
    } finally { if (taskRead.current === controller) taskRead.current = null; }
  }, []);
  const loadSessions = useCallback(async (more = false) => {
    if (!permitted() || sessionRead.current) return;
    const controller = new AbortController(); sessionRead.current = controller; const currentScope = scopeRef.current;
    setView(old => ({ ...old, sessionsLoading: true }));
    const cursor = more ? data.current.nextSessionsCursor : undefined;
    try {
      const value = parseControlSessionPage(await context.current.access.request(`/api/control/agents/${encodeURIComponent(context.current.agentId)}/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal }));
      if (!value || value.sessions.some(item => item.agentId !== context.current.agentId)) throw new ControlApiError('invalid-source');
      if (controller.signal.aborted || currentScope !== scopeRef.current || !permitted()) return;
      let selected = data.current.selected; let note = data.current.selectionNote;
      if (!everSelected.current && value.sessions.length) {
        const ordered = [...value.sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        selected = ordered.find(item => item.sessionKey === context.current.initialSessionKey) ?? ordered.find(item => !item.isChild) ?? ordered[0];
        note = selected.sessionKey === context.current.initialSessionKey ? undefined : selected.isChild ? 'Only child sessions are visible. Showing the newest child session.' : 'The roster conversation is not in this page. Showing the newest visible conversation.';
        everSelected.current = true;
      }
      const all = more ? [...data.current.sessions, ...value.sessions] : value.sessions;
      if (selected && !all.some(item => targetIdentity(item) === targetIdentity(selected!))) all.unshift(selected);
      const sessions = [...new Map(all.map(item => [targetIdentity(item), item])).values()];
      const next = { ...data.current, sessions, selected, selectionNote: note, nextSessionsCursor: value.nextCursor, sessionsLoading: false };
      data.current = next; setView(next);
      if (selected && !data.current.task) await readTask(selected);
    } catch (error) {
      if (!controller.signal.aborted && currentScope === scopeRef.current) setView(old => ({ ...old, sessionsLoading: false, error: error instanceof ControlApiError ? error : new ControlApiError() }));
    } finally { if (sessionRead.current === controller) sessionRead.current = null; }
  }, [readTask]);
  const refresh = useCallback(async () => {
    if (!permitted()) return;
    const selected = data.current.selected;
    await Promise.allSettled([loadSessions(), selected ? readTask(selected) : Promise.resolve()]);
  }, [loadSessions, readTask]);
  const selectSession = useCallback((target: ControlTarget) => {
    const selected = data.current.sessions.find(item => targetIdentity(item) === targetIdentity(target)); if (!selected) return;
    selection.current++; taskRead.current?.abort(); taskRead.current = null; everSelected.current = true;
    const next = { ...data.current, selected, task: null, loading: false, error: null, selectionNote: undefined }; data.current = next; setView(next);
    void readTask(selected);
  }, [readTask]);
  useEffect(() => {
    stop(); scopeRef.current = scope; everSelected.current = false;
    const empty = { sessions: [], selected: null, task: null, loading: false, sessionsLoading: false, error: null };
    data.current = empty; setView(empty);
  }, [scope, stop]);
  useEffect(() => {
    const change = () => { setVisible(document.visibilityState !== 'hidden'); if (document.visibilityState === 'hidden') stop(); };
    document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change);
  }, [stop]);
  useEffect(() => {
    if (!options.active || !visible || access.state !== 'unlocked' || !access.status?.canRead) { stop(); setView(old => ({ ...old, loading: false, sessionsLoading: false })); return; }
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { clearInterval(timer); stop(); };
  }, [scope, options.active, visible, access.state, access.status?.canRead, refresh, stop]);
  const privateView = access.state !== 'unlocked' || scope !== scopeRef.current ? { sessions: [], selected: null, task: null, loading: false, sessionsLoading: false, error: null } : view;
  return { ...privateView, selectSession, refresh, loadMoreSessions: () => loadSessions(true), loadEarlier: async () => { const current = data.current; if (current.selected && current.task?.nextCursor) await readTask(current.selected, current.task.nextCursor); } };
}
