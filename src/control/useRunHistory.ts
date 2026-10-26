import { useCallback, useEffect, useRef, useState } from 'react';
import { parseControlTarget, type ControlTarget } from '../../shared/control';
import { parseControlRunHistorySnapshot, type ControlRunHistorySnapshot } from '../../shared/controlRunHistory';
import { parseControlResultsSnapshot, type ControlResultsSnapshot } from '../../shared/controlResults';
import { useControlAccess } from './ControlAccess';
import { ControlApiError, targetIdentity } from './api';
import { controlReadDeadline, controlReadError } from './readDeadline';

interface View { snapshot: ControlRunHistorySnapshot | null; lastKnown: ControlRunHistorySnapshot | null; results: ControlResultsSnapshot | null; loading: boolean; error: ControlApiError | null }
const empty = (): View => ({ snapshot: null, lastKnown: null, results: null, loading: false, error: null });
export function useRunHistory(options: { target: ControlTarget | null; runId?: string; active: boolean; resultsActive?: boolean }) {
  const access = useControlAccess();
  const denied = access.status?.state === 'auth-error' || access.status?.state === 'pairing-required' || access.status?.configured === false;
  const key = JSON.stringify([options.target && targetIdentity(options.target), access.generation, options.runId ?? null]);
  const [view, setView] = useState<View>(empty); const currentView = useRef(view); currentView.current = view;
  const scope = useRef(key); const read = useRef<AbortController | null>(null); const context = useRef({ ...options, access }); context.current = { ...options, access };
  const permitted = () => context.current.active && context.current.access.state === 'unlocked' && context.current.access.status?.canRead && document.visibilityState !== 'hidden';
  const load = useCallback(async (cursor?: string, refresh = false) => {
    const target = parseControlTarget(context.current.target); if (!target || !permitted() || read.current) return;
    const controller = new AbortController(); read.current = controller; const dispose = controlReadDeadline(controller, undefined, 60000);
    const ownScope = scope.current; const runId = context.current.runId; const resultsMode = context.current.resultsActive;
    const valid = () => !controller.signal.aborted && ownScope === scope.current && permitted();
    setView(old => ({ ...old, loading: true, error: null }));
    try {
      const snapshot = parseControlRunHistorySnapshot(await context.current.access.request(`/api/control/agents/${encodeURIComponent(target.agentId)}/runs`, {
        method: 'POST', signal: controller.signal, body: JSON.stringify({ ...target, ...(runId ? { runId } : {}), ...(cursor ? { cursor } : {}), ...(refresh ? { refresh: true } : {}) }),
      }));
      if (!snapshot || targetIdentity(snapshot.target) !== targetIdentity(target) || snapshot.selectedRunId !== runId) throw new ControlApiError('invalid-source');
      if (!valid()) return;
      setView(old => {
        const matches = (value: ControlRunHistorySnapshot | null) => !!value?.task && value.selectedRunId === runId && value.task.runId === runId && targetIdentity(value.target) === targetIdentity(target);
        const lastKnown = !runId || snapshot.task ? null : matches(old.snapshot) ? old.snapshot : matches(old.lastKnown) ? old.lastKnown : null;
        // Retained display text is independent of the new source window and cannot authorize files.
        return { ...old, snapshot, lastKnown, results: snapshot.task ? old.results : null, loading: !!(resultsMode && runId && snapshot.task), error: null };
      });
      if (resultsMode && runId && snapshot.task) {
        const results = parseControlResultsSnapshot(await context.current.access.request(`/api/control/agents/${encodeURIComponent(target.agentId)}/results`, {
          method: 'POST', signal: controller.signal, body: JSON.stringify({ ...target, runId }),
        }));
        if (!results || targetIdentity(results.target) !== targetIdentity(target) || results.scope.kind !== 'run' || results.scope.runId !== runId) throw new ControlApiError('invalid-source');
        if (valid()) setView(old => ({ ...old, results, loading: false, error: null }));
      } else if (valid()) setView(old => ({ ...old, results: null, loading: false }));
    } catch (error) {
      if (read.current !== controller || ownScope !== scope.current || !permitted()) return;
      const failure = controlReadError(controller, error); const denied = ['session-changed', 'invalid-target', 'scope-required', 'pairing-required', 'locked'].includes(failure.code);
      setView(old => ({ loading: false, error: failure,
        lastKnown: denied ? null : old.lastKnown,
        snapshot: denied ? null : old.snapshot ? { ...old.snapshot, source: { ...old.snapshot.source, state: 'stale' }, ...(old.snapshot.task ? { task: { ...old.snapshot.task, source: { ...old.snapshot.task.source, state: 'stale' } } } : {}) } : null,
        results: denied ? null : old.results ? { ...old.results, source: { ...old.results.source, state: 'stale' }, artifactState: 'unavailable' } : null }));
    } finally { dispose(); if (read.current === controller) read.current = null; }
  }, []);
  useEffect(() => { read.current?.abort(); read.current = null; scope.current = key; setView(empty()); }, [key]);
  useEffect(() => {
    if (access.state !== 'unlocked' || denied) { read.current?.abort(); read.current = null; setView(empty()); }
  }, [access.state, denied]);
  useEffect(() => {
    if (!options.active || access.state !== 'unlocked' || !access.status?.canRead) { read.current?.abort(); read.current = null; setView(old => ({ ...old, loading: false })); return; }
    void load();
    const visible = () => { if (document.visibilityState === 'hidden') { read.current?.abort(); read.current = null; setView(old => ({ ...old, loading: false })); } else void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { document.removeEventListener('visibilitychange', visible); read.current?.abort(); read.current = null; };
  }, [key, options.active, options.resultsActive, access.state, access.status?.canRead, load]);
  const safe = access.state === 'unlocked' && !denied && scope.current === key ? access.status?.canRead === false ? {
    ...view, snapshot: view.snapshot ? { ...view.snapshot, source: { ...view.snapshot.source, state: 'stale' as const }, ...(view.snapshot.task ? { task: { ...view.snapshot.task, source: { ...view.snapshot.task.source, state: 'stale' as const } } } : {}) } : null,
    results: view.results ? { ...view.results, source: { ...view.results.source, state: 'stale' as const }, artifactState: 'unavailable' as const } : null,
  } : view : empty();
  return { ...safe, results: safe.snapshot?.task ? safe.results : null, refresh: () => load(undefined, true), loadEarlier: () => load(currentView.current.snapshot?.nextCursor) };
}
