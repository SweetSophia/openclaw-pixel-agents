import { useCallback, useEffect, useRef, useState } from 'react';
import { controlRecord, parseControlSession, parseControlSessionPage, parseControlTarget, parseControlTaskSnapshot, type ControlSession, type ControlTarget, type ControlTaskSnapshot } from '../../shared/control';
import { parseControlResultsSnapshot, type ControlResultsSnapshot } from '../../shared/controlResults';
import { useControlAccess } from './ControlAccess';
import { ControlApiError, targetIdentity } from './api';
import { controlReadDeadline, controlReadError } from './readDeadline';
import { parseControlUsageSnapshot, type ControlUsageSnapshot } from '../../shared/controlUsage';

const TASK_READ_TIMEOUT_MS = 60000;

export interface TaskDetailsState {
  sessions: ControlSession[]; selected: ControlSession | null; task: ControlTaskSnapshot | null; results: ControlResultsSnapshot | null; usage: ControlUsageSnapshot | null;
  loading: boolean; sessionsLoading: boolean; error: ControlApiError | null; selectionNote?: string; nextSessionsCursor?: string;
  selectSession(target: ControlTarget): void; refresh(signal?: AbortSignal): Promise<void>; loadMoreSessions(): Promise<void>; loadEarlier(): Promise<void>;
  selectCreatedSession(target: ControlTarget): void;
}
export function useTaskDetails(options: { agentId: string; initialSessionKey: string; active: boolean; taskActive?: boolean; resultsActive?: boolean; usageActive?: boolean }): TaskDetailsState {
  const access = useControlAccess();
  const sourceDenied = access.status?.state === 'auth-error' || access.status?.state === 'pairing-required' || access.status?.configured === false;
  type View = Omit<TaskDetailsState, 'selectSession' | 'selectCreatedSession' | 'refresh' | 'loadMoreSessions' | 'loadEarlier'>;
  const [view, setRendered] = useState<View>({ sessions: [], selected: null, task: null, results: null, usage: null, loading: false, sessionsLoading: false, error: null });
  const data = useRef(view);
  const setView = useCallback((update: View | ((previous: View) => View)) => {
    const next = typeof update === 'function' ? update(data.current) : update;
    data.current = next; setRendered(next);
  }, []);
  const context = useRef({ ...options, access }); context.current = { ...options, access };
  const scope = `${options.agentId}:${access.generation}`; const scopeRef = useRef(scope);
  const selection = useRef(0); const everSelected = useRef(false);
  const pagedSessions = useRef(false);
  const sessionError = useRef<ControlApiError | null>(null);
  const taskRead = useRef<AbortController | null>(null); const sessionRead = useRef<AbortController | null>(null);
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const permitted = () => context.current.active && context.current.access.state === 'unlocked' && context.current.access.status?.canRead && document.visibilityState !== 'hidden';
  const stop = useCallback(() => { selection.current++; taskRead.current?.abort(); sessionRead.current?.abort(); taskRead.current = null; sessionRead.current = null; }, []);
  const readTask = useCallback(async (target: ControlTarget, cursor?: string, signal?: AbortSignal) => {
    const resultsMode = context.current.resultsActive === true;
    const usageMode = context.current.usageActive === true;
    if (!permitted() || (!resultsMode && !usageMode && context.current.taskActive === false) || taskRead.current) return;
    const controller = new AbortController(); taskRead.current = controller;
    const dispose = controlReadDeadline(controller, signal, TASK_READ_TIMEOUT_MS);
    const current = selection.current; const currentScope = scopeRef.current;
    setView(old => ({ ...old, loading: true }));
    try {
      const selected = parseControlTarget(target); if (!selected) throw new ControlApiError('invalid-target');
      const raw = await context.current.access.request(`/api/control/agents/${encodeURIComponent(target.agentId)}/${usageMode ? 'usage' : resultsMode ? 'results' : 'task'}`, { method: 'POST', signal: controller.signal, body: JSON.stringify(resultsMode || usageMode ? selected : { ...selected, cursor }) });
      const value = usageMode ? parseControlUsageSnapshot(raw) : resultsMode ? parseControlResultsSnapshot(raw) : parseControlTaskSnapshot(raw);
      if (!value || targetIdentity(value.target) !== targetIdentity(target)) throw new ControlApiError('invalid-source');
      if (controller.signal.aborted || current !== selection.current || currentScope !== scopeRef.current || !permitted()) return;
      if (usageMode) {
        const usage = value as ControlUsageSnapshot;
        setView(old => old.usage && old.usage.source.observedAt > usage.source.observedAt ? { ...old, loading: false } : { ...old, usage, loading: false, error: null });
      } else if (resultsMode) {
        const results = value as ControlResultsSnapshot;
        setView(old => old.results && old.results.source.observedAt > results.source.observedAt ? { ...old, loading: false } : { ...old, results, loading: false, error: null });
      } else {
        const task = value as ControlTaskSnapshot;
        setView(old => old.task && old.task.source.observedAt > task.source.observedAt ? { ...old, loading: false } : { ...old, task, loading: false, error: null });
      }
    } catch (error) {
      if (current !== selection.current || currentScope !== scopeRef.current || !permitted()) return;
      const failure = controlReadError(controller, error);
      const denied = ['session-changed', 'invalid-target', 'scope-required', 'pairing-required', 'locked'].includes(failure.code);
      setView(old => ({ ...old, loading: false, error: failure, task: denied ? null : !usageMode && !resultsMode && old.task ? { ...old.task, source: { ...old.task.source, state: 'stale' } } : old.task,
        results: denied ? null : resultsMode && old.results ? { ...old.results, source: { ...old.results.source, state: 'stale' } } : old.results,
        usage: denied || (usageMode && failure.code === 'usage-denied') ? null : usageMode && old.usage ? { ...old.usage, source: { ...old.usage.source, state: 'stale' } } : old.usage }));
    } finally { dispose(); if (taskRead.current === controller) taskRead.current = null; }
  }, []);
  const loadSessions = useCallback(async (more = false, signal?: AbortSignal) => {
    if (!permitted() || sessionRead.current) return;
    const controller = new AbortController(); sessionRead.current = controller; const currentScope = scopeRef.current;
    const dispose = controlReadDeadline(controller, signal, TASK_READ_TIMEOUT_MS);
    setView(old => ({ ...old, sessionsLoading: true }));
    const cursor = more ? data.current.nextSessionsCursor : undefined;
    try {
      const value = parseControlSessionPage(await context.current.access.request(`/api/control/agents/${encodeURIComponent(context.current.agentId)}/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal }));
      if (!value || value.sessions.some(item => item.agentId !== context.current.agentId)) throw new ControlApiError('invalid-source');
      if (controller.signal.aborted || currentScope !== scopeRef.current || !permitted()) return;
      let selected = data.current.selected; let note = data.current.selectionNote;
      if (!everSelected.current && value.sessions.length) {
        const ordered = [...value.sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        let roster = ordered.find(item => item.sessionKey === context.current.initialSessionKey);
        if (!roster && context.current.initialSessionKey) {
          const resolved = controlRecord(await context.current.access.request(`/api/control/agents/${encodeURIComponent(context.current.agentId)}/selection`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ sessionKey: context.current.initialSessionKey }) }));
          if (!resolved || (resolved.session !== null && !parseControlSession(resolved.session))) throw new ControlApiError('invalid-source');
          roster = parseControlSession(resolved.session) ?? undefined;
          if (roster && (roster.agentId !== context.current.agentId || roster.sessionKey !== context.current.initialSessionKey)) throw new ControlApiError('invalid-source');
          if (controller.signal.aborted || currentScope !== scopeRef.current || !permitted()) return;
        }
        selected = roster ?? ordered.find(item => !item.isChild) ?? ordered[0];
        note = selected.sessionKey === context.current.initialSessionKey ? undefined : selected.isChild ? 'Only child sessions are visible. Showing the newest child session.' : 'The roster conversation is not visible. Showing the newest visible conversation.';
        everSelected.current = true;
      }
      if (selected) selected = value.sessions.find(item => targetIdentity(item) === targetIdentity(selected!)) ?? selected;
      const headIds = new Set(value.sessions.map(targetIdentity));
      const all = more ? [...data.current.sessions, ...value.sessions] : pagedSessions.current
        ? [...value.sessions, ...data.current.sessions.filter(item => !headIds.has(targetIdentity(item)))] : value.sessions;
      const nextCursor = more || !pagedSessions.current ? value.nextCursor : data.current.nextSessionsCursor;
      if (more) pagedSessions.current = true;
      if (selected && !all.some(item => targetIdentity(item) === targetIdentity(selected!))) all.unshift(selected);
      const sessions = [...new Map(all.map(item => [targetIdentity(item), item])).values()];
      const next = { ...data.current, sessions, selected, selectionNote: note, nextSessionsCursor: nextCursor, sessionsLoading: false,
        error: data.current.error === sessionError.current ? null : data.current.error };
      sessionError.current = null;
      data.current = next; setView(next);
      // Session metadata is complete; the detail read owns its own budget and cancellation slot.
      dispose(); if (sessionRead.current === controller) sessionRead.current = null;
      if (selected && !(context.current.usageActive ? data.current.usage : context.current.resultsActive ? data.current.results : data.current.task)) await readTask(selected, undefined, signal);
    } catch (error) {
      const failure = controlReadError(controller, error);
      if (more && failure.code === 'invalid-request') pagedSessions.current = false;
      if (sessionRead.current === controller && currentScope === scopeRef.current && permitted()) { sessionError.current = failure; setView(old => ({ ...old, sessionsLoading: false, error: failure })); }
    } finally { dispose(); if (sessionRead.current === controller) sessionRead.current = null; }
  }, [readTask]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!permitted()) return;
    const selected = data.current.selected;
    await Promise.allSettled([loadSessions(false, signal), selected ? readTask(selected, undefined, signal) : Promise.resolve()]);
  }, [loadSessions, readTask]);
  const selectSession = useCallback((target: ControlTarget) => {
    const selected = data.current.sessions.find(item => targetIdentity(item) === targetIdentity(target)); if (!selected) return;
    selection.current++; taskRead.current?.abort(); taskRead.current = null; everSelected.current = true;
    const next = { ...data.current, selected, task: null, results: null, usage: null, loading: false, error: null, selectionNote: undefined }; data.current = next; setView(next);
    void readTask(selected);
  }, [readTask]);
  useEffect(() => {
    stop(); scopeRef.current = scope; everSelected.current = false; pagedSessions.current = false; sessionError.current = null;
    const empty = { sessions: [], selected: null, task: null, results: null, usage: null, loading: false, sessionsLoading: false, error: null };
    data.current = empty; setView(empty);
  }, [scope, stop]);
  useEffect(() => {
    if (!sourceDenied) return;
    stop(); everSelected.current = true; pagedSessions.current = false; sessionError.current = null;
    setView({ sessions: [], selected: null, task: null, results: null, usage: null, loading: false, sessionsLoading: false, error: null });
  }, [sourceDenied, stop, setView]);
  useEffect(() => {
    const change = () => { setVisible(document.visibilityState !== 'hidden'); if (document.visibilityState === 'hidden') stop(); };
    document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change);
  }, [stop]);
  useEffect(() => {
    if (!options.active || !visible || access.state !== 'unlocked' || !access.status?.canRead) {
      stop(); setView(old => ({ ...old, loading: false, sessionsLoading: false,
        usage: access.status?.canRead === false && old.usage ? { ...old.usage, source: { ...old.usage.source, state: 'stale' } } : old.usage })); return;
    }
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { clearInterval(timer); stop(); };
  }, [scope, options.active, options.taskActive, options.resultsActive, options.usageActive, visible, access.state, access.status?.canRead, refresh, stop]);
  const privateView = access.state !== 'unlocked' || sourceDenied || scope !== scopeRef.current ? { sessions: [], selected: null, task: null, results: null, usage: null, loading: false, sessionsLoading: false, error: null } : view;
  return { ...privateView, selectSession, selectCreatedSession: target => {
    const parsed = parseControlTarget(target); if (!parsed || parsed.agentId !== options.agentId) return;
    const selected: ControlSession = { ...parsed, name: 'Office conversation', isChild: false, hasActiveRun: null };
    if (!data.current.sessions.some(item => targetIdentity(item) === targetIdentity(selected))) setView(old => ({ ...old, sessions: [selected, ...old.sessions] }));
    selectSession(selected);
  }, refresh, loadMoreSessions: () => loadSessions(true), loadEarlier: async () => { const current = data.current; if (current.selected && current.task?.nextCursor) await readTask(current.selected, current.task.nextCursor); } };
}
