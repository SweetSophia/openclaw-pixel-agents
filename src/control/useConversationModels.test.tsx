import React, { useLayoutEffect } from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useConversationModels } from './useConversationModels';
import { ControlApiError } from './api';
import type { ControlTarget } from '../../shared/control';
import { parseControlModelReadRequest, parseControlModelSelection, type ControlModelSnapshot } from '../../shared/controlModels';

const access = vi.hoisted(() => ({ request: vi.fn(), generation: 1, state: 'unlocked', canRead: true }));
vi.mock('./ControlAccess', () => ({ useControlAccess: () => ({ ...access, status: { canRead: access.canRead } }) }));
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:main', sessionId: 'session-1', lifecycleRevision: 'life-1', branchId: 'branch-1' };
let snapshot: ControlModelSnapshot;
const fresh = (): ControlModelSnapshot => ({ target, selectionId: 'observation-1', observedAt: Date.now(), currentModel: 'p/old', canChange: true, disabledReason: null,
  choices: [{ id: 'p/new', label: 'New model', selectable: true, available: true }, { id: 'p/denied', label: 'Denied', selectable: false, available: true }, { id: 'p/unknown', label: 'Unknown', selectable: true, available: null }] });
const applies = () => access.request.mock.calls.filter(([path]) => String(path).endsWith('/model'));
function response(path: string, init: RequestInit) {
  const input = JSON.parse(String(init.body));
  if (path.endsWith('/models')) {
    if (!parseControlModelReadRequest(input)) throw new ControlApiError('invalid-request');
    return { ...snapshot, target: input.target };
  }
  if (!parseControlModelSelection(input)) throw new ControlApiError('invalid-request');
  return { target: input.target, outcome: 'confirmed', snapshot: { ...snapshot, target: input.target, selectionId: 'after-apply', currentModel: input.model ?? 'p/default' } };
}
beforeEach(() => { access.request = vi.fn(async (path, init) => response(path, init)); access.state = 'unlocked'; access.generation++; access.canRead = true; snapshot = fresh(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function ready(result: { current: ReturnType<typeof useConversationModels> }) { await waitFor(() => expect(result.current.snapshot?.currentModel).toBe('p/old')); }

it('reads canonical targets, inspects without writing, and applies one immutable selection despite duplicate clicks', async () => {
  const selected = { ...target, activeLeafEntryId: 'leaf-1', name: 'Private metadata', hasActiveRun: false };
  const { result } = renderHook(() => useConversationModels(selected, true)); await ready(result);
  expect(JSON.parse(String(access.request.mock.calls[0][1].body))).toEqual({ target: { ...target, activeLeafEntryId: 'leaf-1' } });
  act(() => { result.current.choose('p/new'); result.current.prepare(); });
  expect(applies()).toHaveLength(0); expect(result.current.confirmation?.model).toBe('p/new');
  await act(async () => { await Promise.all([result.current.confirm(), result.current.confirm()]); });
  expect(applies()).toHaveLength(1);
  expect(JSON.parse(String(applies()[0][1].body))).toEqual({ target: { ...target, activeLeafEntryId: 'leaf-1' }, selectionId: 'observation-1', model: 'p/new' });
  expect(result.current.outcome).toBe('confirmed'); expect(result.current.snapshot?.currentModel).toBe('p/new');
});
it('allows explicit configured default but never authorizes denied or unknown-availability choices', async () => {
  const { result } = renderHook(() => useConversationModels(target, true)); await ready(result);
  for (const id of ['p/denied', 'p/unknown', 'not-in-catalog']) {
    act(() => { result.current.choose(id); result.current.prepare(); }); expect(result.current.confirmation).toBeNull();
  }
  act(() => { result.current.choose(null); result.current.prepare(); }); expect(result.current.confirmation?.model).toBeNull();
  await act(() => result.current.confirm()); expect(JSON.parse(String(applies()[0][1].body)).model).toBeNull();
});
it.each(['inactive', 'lock', 'generation', 'target', 'permission', 'leaf'])('fences retained confirmation before passive cleanup on %s', async change => {
  let selected: ControlTarget = target; let active = true; let retained = async () => {};
  const initialGeneration = access.generation;
  const { result, rerender } = renderHook(() => {
    const state = useConversationModels(selected, active);
    useLayoutEffect(() => { if (!active || selected !== target || !access.canRead || access.state === 'locked' || access.generation !== initialGeneration) void retained(); });
    return state;
  });
  await ready(result); act(() => { result.current.choose('p/new'); result.current.prepare(); }); retained = result.current.confirm;
  if (change === 'inactive') active = false;
  if (change === 'lock') access.state = 'locked';
  if (change === 'generation') access.generation++;
  if (change === 'target') selected = { ...target, lifecycleRevision: 'life-2' };
  if (change === 'leaf') selected = { ...target, activeLeafEntryId: 'leaf-2' };
  if (change === 'permission') access.canRead = false;
  rerender(); await act(() => retained()); expect(applies()).toHaveLength(0); expect(result.current.confirmation).toBeNull();
});
it('invalidates immutable confirmation when draft or observation changes and when it expires', async () => {
  const { result } = renderHook(() => useConversationModels(target, true)); await ready(result);
  act(() => { result.current.choose('p/new'); result.current.prepare(); });
  const old = result.current.confirmation!;
  act(() => result.current.choose(null)); await act(() => result.current.confirm()); expect(applies()).toHaveLength(0); expect(old.model).toBe('p/new');
  act(() => { result.current.choose('p/new'); result.current.prepare(); });
  snapshot = { ...snapshot, selectionId: 'observation-2', canChange: false, disabledReason: 'busy' };
  await act(() => result.current.refresh()); await act(() => result.current.confirm()); expect(applies()).toHaveLength(0); expect(result.current.confirmation).toBeNull();
  snapshot = fresh(); await act(() => result.current.refresh()); act(() => { result.current.choose('p/new'); result.current.prepare(); });
  vi.spyOn(Date, 'now').mockReturnValue(snapshot.observedAt + 60001); await act(() => result.current.confirm()); expect(applies()).toHaveLength(0); expect(result.current.stale).toBe(true);
});
it('binds retained confirmation callbacks to their exact displayed immutable request', async () => {
  const { result } = renderHook(() => useConversationModels(target, true)); await ready(result);
  act(() => { result.current.choose('p/new'); result.current.prepare(); }); const oldConfirm = result.current.confirm;
  act(() => result.current.choose(null)); act(() => result.current.prepare());
  await act(() => oldConfirm()); expect(applies()).toHaveLength(0);
  expect(result.current.confirmation?.model).toBeNull(); await act(() => result.current.confirm()); expect(applies()).toHaveLength(1);
});
it('blocks an old confirmation in a child layout effect before parent lifecycle cleanup', async () => {
  let state!: ReturnType<typeof useConversationModels>; let selected: ControlTarget = target; let retained = async () => {}; let invoke = false;
  function Child() { useLayoutEffect(() => { if (invoke) { invoke = false; void retained(); } }); return null; }
  function Harness() { state = useConversationModels(selected, true); return <Child />; }
  const view = render(<Harness />); await waitFor(() => expect(state.snapshot?.currentModel).toBe('p/old'));
  act(() => { state.choose('p/new'); state.prepare(); }); retained = state.confirm;
  selected = { ...target, branchId: 'other-branch' }; invoke = true; view.rerender(<Harness />);
  expect(applies()).toHaveLength(0); expect(state.confirmation).toBeNull();
});
it('keeps attempted observations blocked after explicit Refresh returns the same operation identity', async () => {
  access.request.mockImplementation(async (path, init) => path.endsWith('/model') ? { target, outcome: 'unknown' } : response(path, init));
  const { result } = renderHook(() => useConversationModels(target, true)); await ready(result);
  act(() => { result.current.choose('p/new'); result.current.prepare(); }); await act(() => result.current.confirm());
  await act(() => result.current.refresh()); act(() => { result.current.choose('p/new'); result.current.prepare(); }); expect(result.current.confirmation).toBeNull(); expect(applies()).toHaveLength(1);
  expect(result.current.uncertain).toBe(true);
});
it('keeps identity-only uncertainty across credential generations while clearing obsolete model facts', async () => {
  access.request.mockImplementation(async (path, init) => path.endsWith('/model') ? { target, outcome: 'unknown' } : response(path, init));
  const { result, rerender } = renderHook(() => useConversationModels(target, true)); await ready(result);
  act(() => { result.current.choose(null); result.current.prepare(); }); await act(() => result.current.confirm());
  access.state = 'locked'; access.generation++; rerender(); expect(result.current.snapshot).toBeNull();
  snapshot = { ...fresh(), selectionId: 'after-credentials' }; access.state = 'unlocked'; access.generation++; rerender(); await ready(result);
  expect(result.current.uncertain).toBe(true); act(() => { result.current.choose(null); result.current.prepare(); }); expect(result.current.confirmation).toBeNull();
  await act(() => result.current.refresh()); expect(result.current.uncertain).toBe(false);
});
it.each(['unavailable', 'invalid-source', 'model-denied', 'model-busy'] as const)('latches a failed admitted %s request across remount and requires explicit fresh facts', async code => {
  access.request.mockImplementation(async (path, init) => { if (path.endsWith('/model')) throw new ControlApiError(code); return response(path, init); });
  const first = renderHook(() => useConversationModels(target, true)); await ready(first.result);
  act(() => { first.result.current.choose(null); first.result.current.prepare(); }); await act(() => first.result.current.confirm()); first.unmount();
  snapshot = { ...fresh(), selectionId: 'fresh-after-failure' }; const second = renderHook(() => useConversationModels(target, true)); await ready(second.result);
  expect(second.result.current.uncertain).toBe(true); act(() => { second.result.current.choose(null); second.result.current.prepare(); }); expect(second.result.current.confirmation).toBeNull();
  await act(() => second.result.current.refresh()); expect(second.result.current.uncertain).toBe(false); expect(applies()).toHaveLength(1);
});
it.each(['locked', 'scope-required', 'pairing-required', 'invalid-target', 'session-changed', 'invalid-source', 'model-denied'] as const)('clears payloads on authority/identity/model boundary failure %s', async code => {
  const { result } = renderHook(() => useConversationModels(target, true)); await ready(result);
  access.request.mockRejectedValue(new ControlApiError(code)); await act(() => result.current.refresh()); expect(result.current.snapshot).toBeNull(); expect(result.current.confirmation).toBeNull();
});
it('retains original observation time only as visibly stale, non-actionable information after a transient error', async () => {
  const { result } = renderHook(() => useConversationModels(target, true)); await ready(result); const time = snapshot.observedAt;
  access.request.mockRejectedValue(new ControlApiError('unavailable')); await act(() => result.current.refresh());
  expect(result.current.snapshot?.observedAt).toBe(time); expect(result.current.stale).toBe(true);
  act(() => { result.current.choose('p/new'); result.current.prepare(); }); expect(result.current.confirmation).toBeNull();
});
it('aborts obsolete reads on hide/unmount and ignores late replies after source loss', async () => {
  let resolve!: (value: unknown) => void; access.request.mockImplementation(() => new Promise(done => { resolve = done; }));
  const { result, rerender, unmount } = renderHook(() => useConversationModels(target, true));
  const signal = access.request.mock.calls[0][1].signal!;
  access.canRead = false; rerender(); expect(signal.aborted).toBe(true);
  await act(async () => resolve(snapshot)); expect(result.current.snapshot).toBeNull();
  access.canRead = true; rerender(); const nextSignal = access.request.mock.calls[access.request.mock.calls.length - 1][1].signal!; unmount(); expect(nextSignal.aborted).toBe(true);
});
it('does not read for inactive selections and fences hidden-page late reads', async () => {
  const { result, rerender } = renderHook(({ active }) => useConversationModels(target, active), { initialProps: { active: false } });
  await act(() => result.current.refresh()); expect(access.request).not.toHaveBeenCalled();
  let visibility: DocumentVisibilityState = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  rerender({ active: true }); await ready(result);
  visibility = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(result.current.snapshot).toBeNull();
});
it('keeps an admitted mutation alive while hidden and latches unknown across remount until explicit Refresh', async () => {
  let resolve!: (value: unknown) => void; const original = access.request.getMockImplementation()!;
  access.request.mockImplementation((path, init) => path.endsWith('/model') ? new Promise(done => { resolve = done; }) : original(path, init));
  let visibility: DocumentVisibilityState = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const first = renderHook(() => useConversationModels(target, true)); await ready(first.result);
  act(() => { first.result.current.choose('p/new'); first.result.current.prepare(); });
  act(() => { void first.result.current.confirm(); });
  expect(applies()[0][1].signal).toBeUndefined(); visibility = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange'))); first.unmount();
  visibility = 'visible'; const second = renderHook(() => useConversationModels(target, true));
  expect(second.result.current.pending).toBe(true); await act(async () => resolve({ target, outcome: 'unknown' }));
  await waitFor(() => expect(second.result.current.uncertain).toBe(true)); expect(second.result.current.pending).toBe(false);
  snapshot = { ...fresh(), selectionId: 'fresh-after-unknown' };
  visibility = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange'))); visibility = 'visible'; act(() => document.dispatchEvent(new Event('visibilitychange')));
  await ready(second.result); act(() => { second.result.current.choose('p/new'); second.result.current.prepare(); }); expect(second.result.current.confirmation).toBeNull();
  await act(() => second.result.current.refresh()); expect(second.result.current.uncertain).toBe(false);
  act(() => { second.result.current.choose('p/new'); second.result.current.prepare(); }); expect(second.result.current.confirmation?.selectionId).toBe('fresh-after-unknown'); expect(applies()).toHaveLength(1);
});
