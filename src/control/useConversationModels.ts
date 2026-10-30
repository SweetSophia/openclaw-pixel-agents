import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseControlTarget, type ControlTarget } from '../../shared/control';
import { CONTROL_MODEL_LIMITS, modelTargetIdentity, parseControlModelOutcome, parseControlModelSnapshot, type ControlModelSelection, type ControlModelSnapshot } from '../../shared/controlModels';
import { useControlAccess } from './ControlAccess';
import { ControlApiError } from './api';
import { controlReadDeadline, controlReadError } from './readDeadline';

interface Confirmation extends ControlModelSelection { owner: string; currentModel: string | null; observedAt: number }
interface View {
  owner: string;
  snapshot: ControlModelSnapshot | null;
  expiresAt: number | null;
  confirmation: Confirmation | null;
  draft: string | null | undefined;
  stale: boolean;
  loading: boolean;
  outcome: 'confirmed' | 'unknown' | null;
  error: ControlApiError | null;
}
interface Guard { attempted: Set<string>; pending: boolean; uncertain: boolean; listeners: Set<() => void> }
// Identity-only guards survive ordinary component remounts; no model facts or credentials are retained here.
const guards = new WeakMap<object, Map<string, Guard>>();
function guardFor(request: object, identity: string): Guard {
  let entries = guards.get(request);
  if (!entries) {
    entries = new Map();
    guards.set(request, entries);
  }
  let guard = entries.get(identity);
  if (!guard) {
    guard = { attempted: new Set(), pending: false, uncertain: false, listeners: new Set() };
    entries.set(identity, guard);
  }
  return guard;
}
const empty = (owner: string): View => ({ owner, snapshot: null, expiresAt: null, confirmation: null, draft: undefined, stale: false, loading: false, outcome: null, error: null });
const clears = (error: ControlApiError) => ['locked', 'scope-required', 'pairing-required', 'session-changed', 'invalid-target', 'invalid-source', 'model-denied', 'unsupported', 'disabled', 'transport-required'].includes(error.code);
const settlementMilliseconds = 30000;

export function useConversationModels(target: ControlTarget | null, active: boolean) {
  const access = useControlAccess();
  // Session rows have runtime metadata; projecting is required at both network boundaries.
  const canonical = target ? parseControlTarget(target) : null;
  const owner = JSON.stringify([canonical, access.generation]);
  // Credential/source generations clear payloads, not the attempt/uncertainty guard for this identity.
  const identity = canonical ? modelTargetIdentity(canonical) : '';
  const guard = guardFor(access.request, identity);
  const enabled = !!canonical && active && access.state === 'unlocked' && access.status?.canRead === true && document.visibilityState !== 'hidden';
  const [view, render] = useState(() => empty(owner));
  const data = useRef(view);
  const [, redraw] = useState(0);
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const context = useRef({ owner, enabled, access, target: canonical, guard });
  context.current = { owner, enabled, access, target: canonical, guard };
  const mounted = useRef(true);
  const epoch = useRef(0);
  const read = useRef<AbortController | null>(null);
  const update = useCallback((change: (old: View) => View) => {
    data.current = change(data.current);
    render(data.current);
  }, []);
  const permitted = () => mounted.current && context.current.enabled && document.visibilityState !== 'hidden';
  const same = (captured: string, revision: number) => permitted() && context.current.owner === captured && epoch.current === revision;
  const clear = useCallback(() => {
    epoch.current++;
    read.current?.abort();
    read.current = null;
    update(() => empty(context.current.owner));
  }, [update]);
  useLayoutEffect(() => {
    mounted.current = true;
    clear();
    return () => {
      mounted.current = false;
      epoch.current++;
      read.current?.abort();
      read.current = null;
    };
  }, [owner, enabled, clear]);
  useLayoutEffect(() => {
    const notify = () => redraw(value => value + 1);
    guard.listeners.add(notify);
    return () => { guard.listeners.delete(notify); };
  }, [guard]);
  useEffect(() => {
    const change = () => {
      if (document.visibilityState === 'hidden') clear();
      setVisible(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, [clear]);
  useEffect(() => {
    const expiresAt = view.expiresAt;
    if (!enabled || view.owner !== owner || view.stale || expiresAt === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      if (context.current.owner !== view.owner || data.current.expiresAt !== expiresAt) return;
      const remaining = expiresAt - performance.now();
      if (remaining > 0) {
        timer = setTimeout(expire, Math.ceil(remaining));
        return;
      }
      update(old => ({ ...old, stale: true, confirmation: null }));
    };
    timer = setTimeout(expire, Math.max(0, Math.ceil(expiresAt - performance.now())));
    return () => clearTimeout(timer);
  }, [enabled, owner, view.owner, view.expiresAt, view.stale, update]);
  const fail = (error: ControlApiError) => update(old => clears(error) ? { ...empty(context.current.owner), error }
    : { ...old, error, stale: true, confirmation: null, loading: false });
  const readModels = useCallback(async (explicit: boolean) => {
    const current = context.current;
    if (!permitted() || !current.target || current.guard.pending || read.current) return;
    const selected = current.owner;
    const revision = epoch.current;
    const controller = new AbortController();
    read.current = controller;
    const dispose = controlReadDeadline(controller);
    update(old => ({ ...old, loading: true, confirmation: null }));
    // Browser/server wall clocks can differ. The server observes during this request,
    // so its local request start is a conservative bound on the observation's age.
    const expiresAt = performance.now() + CONTROL_MODEL_LIMITS.lifetime;
    try {
      const value = await current.access.request(`/api/control/agents/${encodeURIComponent(current.target.agentId)}/models`, {
        method: 'POST', body: JSON.stringify({ target: parseControlTarget(current.target) }), signal: controller.signal,
      });
      if (!same(selected, revision) || (controller.signal.aborted && controller.signal.reason?.code !== 'timed-out')) return;
      if (controller.signal.aborted) throw controller.signal.reason;
      const snapshot = parseControlModelSnapshot(value);
      if (!snapshot || modelTargetIdentity(snapshot.target) !== modelTargetIdentity(current.target)) throw new ControlApiError('invalid-source');
      const fresh = performance.now() < expiresAt;
      if (explicit && fresh && !current.guard.attempted.has(snapshot.selectionId)) current.guard.uncertain = false;
      update(() => ({ ...empty(selected), snapshot, expiresAt, stale: !fresh }));
    } catch (error) {
      if (same(selected, revision) && (!controller.signal.aborted || controller.signal.reason?.code === 'timed-out')) fail(controlReadError(controller, error));
    } finally {
      dispose();
      if (read.current === controller) read.current = null;
    }
  }, [update]);
  useEffect(() => { if (enabled && visible) void readModels(false); }, [owner, enabled, visible, readModels]);
  const actionable = () => {
    const current = context.current;
    const state = data.current;
    const snapshot = state.snapshot;
    return permitted() && state.owner === current.owner && !!snapshot && !state.stale && !state.loading && !current.guard.pending && !current.guard.uncertain
      && snapshot.canChange && state.expiresAt !== null && performance.now() < state.expiresAt
      && !current.guard.attempted.has(snapshot.selectionId) && current.guard.attempted.size < CONTROL_MODEL_LIMITS.attempts;
  };
  const choiceAllowed = (model: string | null | undefined) => model === null || (model !== undefined && data.current.snapshot?.choices.some(choice => choice.id === model && choice.selectable && choice.available === true) === true);
  const choose = useCallback((model: string | null) => { if (permitted()) update(old => ({ ...old, draft: model, confirmation: null, outcome: null })); }, [update]);
  const prepare = useCallback(() => {
    if (data.current.confirmation || !actionable() || !choiceAllowed(data.current.draft)) return;
    const current = context.current;
    const snapshot = data.current.snapshot!;
    update(old => ({ ...old, confirmation: { owner: current.owner, target: { ...current.target! }, selectionId: snapshot.selectionId,
      model: old.draft!, currentModel: snapshot.currentModel, observedAt: snapshot.observedAt } }));
  }, [update]);
  const confirm = useCallback(async (captured: Confirmation | null) => {
    const current = context.current;
    // A click from an obsolete render must never confirm a newer dialog's request.
    if (captured !== data.current.confirmation) return;
    if (!captured || captured.owner !== current.owner || captured.selectionId !== data.current.snapshot?.selectionId
      || captured.model !== data.current.draft || !actionable() || !choiceAllowed(captured.model)) {
      if (captured) update(old => ({ ...old, confirmation: null }));
      return;
    }
    const operation = current.guard;
    operation.attempted.add(captured.selectionId);
    operation.pending = true;
    operation.uncertain = true;
    epoch.current++;
    read.current?.abort();
    read.current = null;
    const revision = epoch.current;
    update(old => ({ ...old, confirmation: null, outcome: null, error: null }));
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const startedAt = performance.now();
      const expiresAt = startedAt + CONTROL_MODEL_LIMITS.lifetime;
      // An admitted mutation has no visibility/unmount AbortSignal and is never replayed automatically.
      const deadline = new Promise<never>((_resolve, reject) => {
        settlementTimer = setTimeout(() => reject(new ControlApiError('timed-out')), settlementMilliseconds);
      });
      const request = current.access.request(`/api/control/agents/${encodeURIComponent(captured.target.agentId)}/model`, {
        method: 'POST', body: JSON.stringify({ target: parseControlTarget(captured.target), selectionId: captured.selectionId, model: captured.model }),
      });
      // Race the whole HTTP/body promise. Late settlements are consumed by Promise.race,
      // not replayed or allowed to settle this identity guard a second time.
      const value = await Promise.race([request, deadline]);
      if (performance.now() >= startedAt + settlementMilliseconds) throw new ControlApiError('timed-out');
      const result = parseControlModelOutcome(value);
      if (!result || modelTargetIdentity(result.target) !== modelTargetIdentity(captured.target)) throw new ControlApiError('invalid-source');
      operation.uncertain = result.outcome === 'unknown';
      if (same(captured.owner, revision)) update(old => ({ ...old, snapshot: result.snapshot ?? old.snapshot,
        expiresAt: result.snapshot ? expiresAt : old.expiresAt,
        stale: result.outcome === 'unknown' || performance.now() >= expiresAt, outcome: result.outcome, draft: undefined }));
    } catch (error) {
      if (same(captured.owner, revision)) {
        fail(error instanceof ControlApiError ? error : new ControlApiError('unavailable'));
        update(old => ({ ...old, outcome: 'unknown' }));
      }
    } finally {
      clearTimeout(settlementTimer);
      operation.pending = false;
      for (const notify of operation.listeners) notify();
    }
  }, [update]);
  const displayed = enabled && view.owner === owner ? view : empty(owner);
  const stale = displayed.stale || (displayed.expiresAt !== null && performance.now() >= displayed.expiresAt);
  const disabledReason = !active ? '' : access.state !== 'unlocked' ? 'Unlock task access to inspect conversation models.'
    : access.status?.canRead !== true ? 'Reconnect the conversation source to inspect models.' : !canonical ? 'Choose a live conversation to inspect models.' : '';
  return { ...displayed, owner, enabled, disabledReason, stale, pending: guard.pending, uncertain: guard.uncertain,
    canApply: actionable() && choiceAllowed(displayed.draft), choose, prepare, confirm: () => confirm(displayed.confirmation),
    refresh: useCallback(() => readModels(true), [readModels]), cancel: useCallback(() => update(old => ({ ...old, confirmation: null })), [update]) };
}
