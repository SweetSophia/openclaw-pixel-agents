import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isControlAgentId } from '../../shared/control';
import { parseScheduleConfirmation, parseScheduleDraft, parseScheduleIntent, parseScheduleOperation, parseScheduleOperationsPage, parseScheduleSnapshot,
  type ScheduleConfirmation, type ScheduleDraft, type ScheduleIntent, type ScheduleOperation, type ScheduleSnapshot } from '../../shared/controlSchedules';
import { useControlAccess } from './ControlAccess';
import { ControlApiError } from './api';
import { controlReadDeadline, controlReadError } from './readDeadline';

interface View {
  snapshot: ScheduleSnapshot | null; draft: ScheduleDraft | null; confirmation: ScheduleConfirmation | null;
  loading: boolean; stale: boolean; error: ControlApiError | null; operation: ScheduleOperation | null;
}
interface Binding { owner: string; draft: number; history: boolean; epoch: string; expires: number; confirmation: ScheduleConfirmation }
const empty = (): View => ({ snapshot: null, draft: null, confirmation: null, loading: false, stale: true, error: null, operation: null });
const identity = (value: unknown) => JSON.stringify(value);
const terminal = (error: ControlApiError) => ['locked', 'scope-required', 'pairing-required', 'invalid-target', 'disabled', 'transport-required'].includes(error.code);

export function useSchedules(options: { agentId: string; active: boolean; historical: boolean; editing?: boolean }) {
  const access = useControlAccess(); const owner = identity([options.agentId, access.generation]);
  const context = useRef({ ...options, access, owner }); context.current = { ...options, access, owner };
  const [view, render] = useState<View>(empty); const data = useRef(view);
  const mounted = useRef(false); const scope = useRef(owner); const lifecycle = useRef(0); const draftVersion = useRef(0);
  const binding = useRef<Binding | null>(null); const readers = useRef(new Map<string, AbortController>());
  const mutation = useRef<AbortController | null>(null); const attempted = useRef(new Set<string>());
  // Operation-local request ordering prevents old submit/metadata replies from undoing reconciliation.
  const sequence = useRef(0); const versions = useRef(new Map<string, number>()); const localOperations = useRef(new Map<string, ScheduleOperation>());
  const uncertainIntents = useRef(new Map<string, string>()); const freshRequired = useRef(false);
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const update = useCallback((change: (old: View) => View) => { data.current = change(data.current); if (mounted.current) render(data.current); }, []);
  const permitted = () => mounted.current && scope.current === context.current.owner && context.current.active
    && context.current.access.state === 'unlocked' && context.current.access.status?.canRead === true
    && isControlAgentId(context.current.agentId) && document.visibilityState !== 'hidden';
  const current = (selected: string, epoch: number) => permitted() && context.current.owner === selected && lifecycle.current === epoch;
  const path = () => `/api/control/agents/${encodeURIComponent(context.current.agentId)}/schedules`;
  const invalidate = () => { binding.current = null; };
  const stop = useCallback(() => {
    lifecycle.current++; for (const controller of readers.current.values()) controller.abort(); readers.current.clear();
    mutation.current?.abort(); invalidate();
  }, []);
  const fail = (error: ControlApiError) => {
    invalidate();
    if (terminal(error)) { stop(); draftVersion.current++; uncertainIntents.current.clear(); localOperations.current.clear(); versions.current.clear(); update(() => ({ ...empty(), error })); }
    else update(old => ({ ...old, confirmation: null, loading: false, stale: true, error,
      snapshot: old.snapshot ? { ...old.snapshot, source: { ...old.snapshot.source, state: 'stale' } } : null }));
  };
  const cancelRead = (slot: string) => { readers.current.get(slot)?.abort(); readers.current.delete(slot); };
  const startRead = (slot: string) => { const controller = new AbortController(); readers.current.set(slot, controller); return controller; };
  const loading = () => readers.current.size > 0;
  const mergeOperations = (rows: ScheduleOperation[], previous: ScheduleOperation[] = []) => {
    const merged = new Map(previous.map(row => [row.operationId, row]));
    for (const row of rows) merged.set(row.operationId, localOperations.current.get(row.operationId) ?? row);
    for (const [id, row] of localOperations.current) merged.set(id, row);
    return [...merged.values()].slice(0, 500);
  };
  const applyOperation = (operation: ScheduleOperation, version: number) => {
    if (versions.current.get(operation.operationId) !== version) return;
    localOperations.current.set(operation.operationId, operation);
    update(old => ({ ...old, operation, confirmation: null, snapshot: old.snapshot ? { ...old.snapshot, operations: mergeOperations([operation], old.snapshot.operations) } : null }));
  };
  const canManage = (intent: ScheduleIntent) => {
    const snapshot = data.current.snapshot;
    if (!permitted() || context.current.historical || !snapshot || data.current.stale || snapshot.source.state !== 'current'
      || !snapshot.management.canManage || !snapshot.management.epoch) return false;
    if (intent.kind === 'create') return !snapshot.operationsError;
    const row = snapshot.jobs.find(row => row.id === intent.jobId);
    return !!row && row.readOnlyReason === null && row.revision === intent.revision;
  };

  const browse = useCallback(async (more = false) => {
    if (!permitted() || readers.current.has('browse')) return;
    const previous = data.current.snapshot; const cursor = more ? previous?.nextCursor : undefined;
    if (more && (!cursor || !previous || previous.scanned >= 2000 || data.current.stale)) return;
    invalidate(); update(old => ({ ...old, confirmation: null, loading: true }));
    const selected = context.current.owner; const epoch = lifecycle.current; const controller = startRead('browse');
    const dispose = controlReadDeadline(controller);
    try {
      const snapshot = parseScheduleSnapshot(await context.current.access.request(`${path()}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal }));
      if (!current(selected, epoch)) return;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!snapshot || snapshot.agentId !== context.current.agentId || (!more && snapshot.scanned > 200)
        || (more && (snapshot.management.epoch !== previous!.management.epoch || snapshot.scanned <= previous!.scanned))) throw new ControlApiError('invalid-source');
      if (previous && previous.management.epoch !== snapshot.management.epoch) {
        cancelRead('metadata'); cancelRead('reconcile'); cancelRead('prepare'); mutation.current?.abort();
        // Recovery continuations belong to the old management source, never the new one.
        for (const id of versions.current.keys()) versions.current.set(id, ++sequence.current);
        for (const [id, operation] of localOperations.current) localOperations.current.set(id, { ...operation, recovery: undefined });
      }
      const jobs = more ? [...new Map([...previous!.jobs, ...snapshot.jobs].map(row => [row.id, row])).values()] : snapshot.jobs;
      const operations = mergeOperations(snapshot.operations, more ? previous!.operations : []);
      if (!more) freshRequired.current = false;
      update(old => ({ ...old, snapshot: { ...snapshot, jobs, operations,
        ...(more ? { operationsCursor: old.snapshot?.operationsCursor, operationsError: snapshot.operationsError ?? old.snapshot?.operationsError } : {}) },
        stale: snapshot.source.state !== 'current', error: null }));
    } catch (error) {
      if (!current(selected, epoch)) return;
      const failure = controlReadError(controller, error);
      if (more) { freshRequired.current = true; update(old => ({ ...old, snapshot: old.snapshot ? { ...old.snapshot, nextCursor: undefined } : null })); }
      fail(failure);
    } finally { dispose(); if (readers.current.get('browse') === controller) readers.current.delete('browse'); if (current(selected, epoch)) update(old => ({ ...old, loading: loading() })); }
  }, [update]);
  const refresh = useCallback(() => browse(false), [browse]);
  const loadMore = useCallback(() => browse(true), [browse]);
  const loadMoreOperations = useCallback(async () => {
    const previous = data.current.snapshot; const cursor = previous?.operationsCursor;
    if (!permitted() || !previous || !cursor || previous.operations.length >= 500 || readers.current.has('metadata')) return;
    const selected = context.current.owner; const epoch = lifecycle.current; const management = previous.management.epoch;
    const controller = startRead('metadata'); const dispose = controlReadDeadline(controller); update(old => ({ ...old, loading: true }));
    const applicable = () => current(selected, epoch) && data.current.snapshot?.management.epoch === management && readers.current.get('metadata') === controller;
    try {
      const page = parseScheduleOperationsPage(await context.current.access.request(`${path()}/operations?cursor=${encodeURIComponent(cursor)}`, { signal: controller.signal }));
      if (!applicable()) return;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!page || page.agentId !== context.current.agentId) throw new ControlApiError('invalid-source');
      update(old => ({ ...old, snapshot: old.snapshot ? { ...old.snapshot, operations: mergeOperations(page.operations, old.snapshot.operations), operationsCursor: page.nextCursor, operationsError: undefined } : null, error: null }));
    } catch (error) {
      if (!applicable()) return;
      const failure = controlReadError(controller, error); invalidate(); freshRequired.current = true;
      // Metadata safety fails independently of the verified native browse/CAS edit state.
      update(old => ({ ...old, confirmation: null, error: failure, snapshot: old.snapshot ? { ...old.snapshot, operationsCursor: undefined, operationsError: 'storage-unavailable' } : null }));
    } finally { dispose(); if (readers.current.get('metadata') === controller) { readers.current.delete('metadata'); if (current(selected, epoch)) update(old => ({ ...old, loading: loading() })); } }
  }, [update]);
  const setDraft = useCallback((value: ScheduleDraft | null) => {
    if (context.current.access.state !== 'unlocked' || scope.current !== context.current.owner) return;
    const draft = value === null ? null : parseScheduleDraft(value); draftVersion.current++; invalidate(); cancelRead('prepare');
    update(old => ({ ...old, draft, confirmation: null, loading: loading() }));
  }, [update]);
  const prepare = useCallback(async (input: ScheduleIntent) => {
    const intent = parseScheduleIntent(input);
    if (!intent || !permitted() || context.current.historical || mutation.current || readers.current.has('prepare')
      || [...uncertainIntents.current.values()].includes(identity(intent)) || (intent.kind !== 'enabled' && identity(intent.draft) !== identity(data.current.draft))) return;
    invalidate(); update(old => ({ ...old, confirmation: null }));
    const selected = context.current.owner; const epoch = lifecycle.current; const draft = draftVersion.current; const history = context.current.historical;
    // Explicit preparation refreshes authority even when dirty edits have paused background reads.
    await refresh();
    if (!current(selected, epoch) || draft !== draftVersion.current || !canManage(intent) || readers.current.has('browse')) return;
    const management = data.current.snapshot!.management.epoch!; const started = performance.now();
    const controller = startRead('prepare'); const dispose = controlReadDeadline(controller); update(old => ({ ...old, loading: true, error: null }));
    const applicable = () => current(selected, epoch) && draft === draftVersion.current && context.current.historical === history
      && data.current.snapshot?.management.epoch === management && readers.current.get('prepare') === controller;
    try {
      const confirmation = parseScheduleConfirmation(await context.current.access.request(`${path()}/prepare`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ intent }) }));
      if (!applicable()) return;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!confirmation || confirmation.agentId !== context.current.agentId || identity(confirmation.intent) !== identity(intent)
        || confirmation.epoch !== management || data.current.snapshot?.management.epoch !== management || !canManage(intent)
        || (intent.kind !== 'create' && confirmation.currentEnabled !== data.current.snapshot?.jobs.find(row => row.id === intent.jobId)?.enabled)
        || attempted.current.has(confirmation.operationId)) throw new ControlApiError('invalid-source');
      if (performance.now() >= started + 60000) return;
      binding.current = { owner: selected, draft, history, epoch: management, expires: started + 60000, confirmation };
      // Keep the private capture independent of objects exposed to React consumers.
      update(old => ({ ...old, confirmation: parseScheduleConfirmation(confirmation) }));
    } catch (error) { if (applicable()) fail(controlReadError(controller, error)); }
    finally { dispose(); if (readers.current.get('prepare') === controller) { readers.current.delete('prepare'); if (current(selected, epoch)) update(old => ({ ...old, loading: loading() })); } }
  }, [refresh, update]);
  const submit = useCallback(async () => {
    const captured = binding.current; const confirmation = captured?.confirmation;
    if (!captured || !confirmation || mutation.current || !canManage(confirmation.intent) || captured.owner !== context.current.owner
      || captured.draft !== draftVersion.current || captured.history !== context.current.historical || captured.epoch !== data.current.snapshot?.management.epoch
      || performance.now() >= captured.expires || attempted.current.has(confirmation.operationId)) {
      invalidate(); update(old => ({ ...old, confirmation: null })); return;
    }
    attempted.current.add(confirmation.operationId); uncertainIntents.current.set(confirmation.operationId, identity(confirmation.intent)); invalidate();
    const selected = context.current.owner; const epoch = lifecycle.current; const controller = new AbortController(); mutation.current = controller;
    const dispose = controlReadDeadline(controller); const version = ++sequence.current; versions.current.set(confirmation.operationId, version);
    const unknown: ScheduleOperation = { operationId: confirmation.operationId, agentId: confirmation.agentId, action: confirmation.intent.kind, state: 'unknown',
      ...(confirmation.intent.kind !== 'create' ? { jobId: confirmation.intent.jobId } : {}) };
    applyOperation(unknown, version); update(old => ({ ...old, confirmation: null, error: null, stale: true }));
    try {
      const operation = parseScheduleOperation(await context.current.access.request(`${path()}/submit`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ operationId: confirmation.operationId, intent: confirmation.intent }) }));
      if (!current(selected, epoch) || versions.current.get(confirmation.operationId) !== version) return;
      if (controller.signal.aborted || !operation || operation.agentId !== confirmation.agentId || operation.operationId !== confirmation.operationId || operation.action !== confirmation.intent.kind
        || (confirmation.intent.kind !== 'create' && operation.jobId !== confirmation.intent.jobId)) throw new ControlApiError('schedule-outcome-unknown');
      applyOperation(operation, version); if (operation.state !== 'unknown') uncertainIntents.current.delete(confirmation.operationId);
      if (operation.state === 'unknown') update(old => ({ ...old, error: new ControlApiError('schedule-outcome-unknown') }));
    } catch (error) {
      if (!current(selected, epoch) || versions.current.get(confirmation.operationId) !== version) return;
      const failure = error instanceof ControlApiError && ['schedule-changed', 'schedule-denied', 'schedule-storage-unavailable', 'locked', 'scope-required', 'pairing-required'].includes(error.code)
        ? error : new ControlApiError('schedule-outcome-unknown');
      fail(failure);
    } finally { dispose(); if (mutation.current === controller) mutation.current = null; }
  }, [update]);
  const reconcile = useCallback(async (operationId: string) => {
    const operation = localOperations.current.get(operationId) ?? data.current.snapshot?.operations.find(row => row.operationId === operationId);
    if (!permitted() || !operation || freshRequired.current || readers.current.has('reconcile') || (operation.recovery?.truncated && operation.recovery.scanned >= 2000)) return;
    const selected = context.current.owner; const epoch = lifecycle.current; const management = data.current.snapshot?.management.epoch;
    const version = ++sequence.current; versions.current.set(operationId, version);
    const controller = startRead('reconcile'); const dispose = controlReadDeadline(controller); invalidate(); update(old => ({ ...old, confirmation: null, loading: true }));
    const applicable = () => current(selected, epoch) && management === data.current.snapshot?.management.epoch
      && versions.current.get(operationId) === version && readers.current.get('reconcile') === controller;
    try {
      const result = parseScheduleOperation(await context.current.access.request(`${path()}/operations/${encodeURIComponent(operationId)}/reconcile`, { method: 'POST', signal: controller.signal,
        body: JSON.stringify(operation.recovery?.nextCursor ? { cursor: operation.recovery.nextCursor } : {}) }));
      if (!applicable()) return;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!result || result.agentId !== operation.agentId || result.operationId !== operationId || result.action !== operation.action) throw new ControlApiError('invalid-source');
      applyOperation(result, version); if (result.state !== 'unknown') uncertainIntents.current.delete(operationId);
      update(old => ({ ...old, error: null }));
    } catch (error) {
      if (!applicable()) return;
      freshRequired.current = true; localOperations.current.set(operationId, { ...operation, recovery: undefined });
      fail(controlReadError(controller, error));
    } finally { dispose(); if (readers.current.get('reconcile') === controller) { readers.current.delete('reconcile'); if (current(selected, epoch)) update(old => ({ ...old, loading: loading() })); } }
  }, [update]);

  useLayoutEffect(() => {
    mounted.current = true; stop(); scope.current = owner; draftVersion.current++; mutation.current = null;
    attempted.current.clear(); versions.current.clear(); localOperations.current.clear(); uncertainIntents.current.clear(); freshRequired.current = false; update(empty);
    return () => { mounted.current = false; stop(); };
  }, [owner, access.state, stop, update]);
  useLayoutEffect(() => {
    stop(); update(old => ({ ...old, confirmation: null, loading: false, stale: true,
      error: old.operation?.state === 'unknown' ? new ControlApiError('schedule-outcome-unknown') : old.error }));
  }, [options.active, options.historical, access.status?.canRead, stop, update]);
  useEffect(() => {
    const change = () => {
      if (document.visibilityState === 'hidden') { stop(); update(old => ({ ...old, confirmation: null, loading: false, stale: true,
        error: old.operation?.state === 'unknown' ? new ControlApiError('schedule-outcome-unknown') : old.error })); }
      setVisible(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change);
  }, [stop, update]);
  useEffect(() => {
    if (!permitted() || !visible) return;
    const automatic = () => {
      if (context.current.editing || freshRequired.current || data.current.draft || binding.current || mutation.current || readers.current.size || data.current.operation?.state === 'unknown') {
        update(old => ({ ...old, stale: true })); return;
      }
      // One server page can consume 200 native positions; only explicit Load more follows its cursor.
      void refresh();
    };
    automatic(); const timer = setInterval(automatic, 15000); return () => clearInterval(timer);
  }, [owner, options.active, visible, access.state, access.status?.canRead, refresh, update]);
  const displayed = access.state === 'unlocked' && scope.current === owner ? view : empty();
  return { ...displayed, setDraft, refresh, loadMore, loadMoreOperations, prepare, submit, reconcile };
}
