import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApprovals } from './useApprovals';
import { ControlApiError } from './api';
import { parseApprovalInspectRequest, parseApprovalReadRequest, parseApprovalResolveRequest, type ControlApproval } from '../../shared/controlApprovals';

const access = vi.hoisted(() => ({ request: vi.fn(), generation: 1, state: 'unlocked', canRead: true, canReviewApprovals: true }));
vi.mock('./ControlAccess', () => ({ useControlAccess: () => ({ ...access, status: { ...access } }) }));
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:main', sessionId: 'session-1', lifecycleRevision: 'life-1', branchId: 'branch-1' };
const pending = (): ControlApproval => ({ id: 'approval-1', kind: 'exec', title: 'Run command', text: 'synthetic command', details: ['Warning: fixture'], status: 'pending',
  createdAtMs: 1, expiresAtMs: Date.now() + 600000, allowedDecisions: ['allow-once', 'deny'] });
let item = pending();
let observation = 'observed-1';
function response(path: string, init: RequestInit) {
  const input = JSON.parse(String(init.body));
  const parsed = path.endsWith('/list') ? parseApprovalReadRequest(input) : path.endsWith('/inspect') ? parseApprovalInspectRequest(input) : parseApprovalResolveRequest(input);
  if (!parsed) throw new ControlApiError('invalid-request');
  const base = { target: parsed.target, source: { state: 'current', observedAt: 1234 } };
  return path.endsWith('/list') ? { ...base, items: [item], truncated: false }
    : { ...base, approval: path.endsWith('/resolve') ? { ...item, status: 'denied', resolvedAtMs: 9, allowedDecisions: [] } : item,
      applied: path.endsWith('/resolve'), ...(path.endsWith('/inspect') && item.status === 'pending' ? { observationId: observation } : {}) };
}
beforeEach(() => { access.request = vi.fn(async (path, init) => response(path, init)); access.state = 'unlocked'; access.generation = 1; access.canRead = true; access.canReviewApprovals = true; item = pending(); observation = 'observed-1'; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const resolves = () => access.request.mock.calls.filter(([path]) => String(path).endsWith('/resolve'));

it('serializes canonical targets and binds decisions to the inspected observation, not session metadata', async () => {
  const row = { ...target, activeLeafEntryId: 'leaf-1', name: 'Private label', hasActiveRun: true };
  const { result } = renderHook(() => useApprovals(row, true));
  await waitFor(() => expect(result.current.page?.items).toHaveLength(1));
  await act(() => result.current.prepare(result.current.page!.items[0], 'deny'));
  expect(result.current.confirmation?.approval.text).toBe('synthetic command');
  await act(() => result.current.confirm());
  expect(resolves()).toHaveLength(1);
  expect(JSON.parse(String(resolves()[0][1].body))).toEqual({ target: { ...target, activeLeafEntryId: 'leaf-1' }, id: 'approval-1', kind: 'exec', decision: 'deny', observationId: 'observed-1' });
  expect(result.current.outcomes[0].applied).toBe(true);
});
it.each(['inactive', 'lock', 'generation', 'target', 'capability'])('clears private reads and rejects a retained confirmation on %s', async change => {
  let selected = target; let active = true;
  const { result, rerender } = renderHook(() => useApprovals(selected, active));
  await waitFor(() => expect(result.current.page).not.toBeNull());
  await act(() => result.current.prepare(result.current.page!.items[0], 'deny'));
  const retained = result.current.confirm;
  if (change === 'inactive') active = false;
  if (change === 'lock') access.state = 'locked';
  if (change === 'generation') access.generation++;
  if (change === 'target') selected = { ...target, lifecycleRevision: 'life-2' };
  if (change === 'capability') access.canReviewApprovals = false;
  rerender(); await act(() => retained());
  expect(result.current.confirmation).toBeNull(); expect(resolves()).toHaveLength(0);
  if (change !== 'target' && change !== 'generation') expect(result.current.page).toBeNull();
});
it('clears and aborts on hidden page, resumes only fresh reads, and cancels on unmount', async () => {
  let visibility = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
  const { result, unmount } = renderHook(() => useApprovals(target, true));
  await waitFor(() => expect(result.current.page).not.toBeNull());
  await act(() => result.current.prepare(result.current.page!.items[0], 'deny'));
  visibility = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(() => result.current.confirm()); expect(result.current.page).toBeNull(); expect(resolves()).toHaveLength(0);
  access.request.mockImplementation((_path, init) => new Promise(() => { expect(init.signal).toBeDefined(); }));
  visibility = 'visible'; act(() => document.dispatchEvent(new Event('visibilitychange')));
  const signal = access.request.mock.calls[access.request.mock.calls.length - 1][1].signal!; unmount(); expect(signal.aborted).toBe(true);
});
it('preserves the original last-known timestamp on read failure and disables confirmation', async () => {
  const { result } = renderHook(() => useApprovals(target, true)); await waitFor(() => expect(result.current.page).not.toBeNull());
  access.request.mockRejectedValue(new ControlApiError('unavailable'));
  await act(() => result.current.refresh()); expect(result.current.page?.source).toEqual({ state: 'stale', observedAt: 1234 });
  await act(() => result.current.prepare(result.current.page!.items[0], 'deny')); expect(result.current.confirmation).toBeNull();
});
it('does not read when disabled or inactive', async () => {
  access.canReviewApprovals = false; const { result } = renderHook(() => useApprovals(target, true));
  await act(() => result.current.refresh()); expect(access.request).not.toHaveBeenCalled(); expect(result.current.disabledReason).toMatch(/approval/i);
});
it('rejects replaced decision-relevant presentation and expiry before confirmation', async () => {
  const { result } = renderHook(() => useApprovals(target, true)); await waitFor(() => expect(result.current.page).not.toBeNull());
  await act(() => result.current.prepare(result.current.page!.items[0], 'allow-once'));
  item = { ...item, text: 'replacement command' }; await act(() => result.current.refresh()); await act(() => result.current.confirm());
  expect(resolves()).toHaveLength(0); expect(result.current.confirmation).toBeNull();
  await act(() => result.current.prepare(result.current.page!.items[0], 'deny')); vi.spyOn(Date, 'now').mockReturnValue(item.expiresAtMs + 1);
  await act(() => result.current.confirm()); expect(resolves()).toHaveLength(0);
});
it.each(['approval-outcome-unknown', 'unavailable', 'approval-changed', 'approvals-denied', 'approval-unavailable'] as const)('never replays attempted native identity after %s, even after explicit pending inspection', async code => {
  access.request.mockImplementation(async (path, init) => { if (path.endsWith('/resolve')) throw new ControlApiError(code); return response(path, init); });
  const { result } = renderHook(() => useApprovals(target, true)); await waitFor(() => expect(result.current.page).not.toBeNull());
  await act(() => result.current.prepare(result.current.page!.items[0], 'deny'));
  await act(async () => { await Promise.all([result.current.confirm(), result.current.confirm()]); }); expect(resolves()).toHaveLength(1);
  await act(() => result.current.refresh()); await act(() => result.current.inspect(item)); await act(() => result.current.prepare(item, 'deny')); await act(() => result.current.confirm());
  expect(resolves()).toHaveLength(1); expect(result.current.canDecide(item)).toBe(false);
});
it('reconciles unknown terminal truth only through explicit inspection without claiming operator success', async () => {
  access.request.mockImplementation(async (path, init) => { if (path.endsWith('/resolve')) throw new ControlApiError('approval-outcome-unknown'); return response(path, init); });
  const { result } = renderHook(() => useApprovals(target, true)); await waitFor(() => expect(result.current.page).not.toBeNull());
  await act(() => result.current.prepare(item, 'deny')); await act(() => result.current.confirm());
  expect(result.current.uncertain).toContain(item.id);
  access.request.mockImplementation(async (path, init) => path.endsWith('/inspect') ? { target, source: { state: 'current', observedAt: 2222 }, approval: { ...item, status: 'allowed', resolvedAtMs: 22, allowedDecisions: [] }, applied: false } : response(path, init));
  await act(() => result.current.inspect(item)); expect(result.current.uncertain).toEqual([]); expect(result.current.outcomes[0]).toMatchObject({ approval: { status: 'allowed' }, applied: false });
});
it('does not treat native first-answer applied:false as operator success', async () => {
  access.request.mockImplementation(async (path, init) => ({ ...response(path, init), ...(path.endsWith('/resolve') ? { applied: false } : {}) }));
  const { result } = renderHook(() => useApprovals(target, true)); await waitFor(() => expect(result.current.page).not.toBeNull());
  await act(() => result.current.prepare(item, 'deny')); await act(() => result.current.confirm()); expect(result.current.outcomes[0].applied).toBe(false);
});
it('cannot display an inspect response from an old conversation after replacement', async () => {
  let finish!: (value: unknown) => void; const original = access.request.getMockImplementation()!;
  access.request.mockImplementation((path, init) => path.endsWith('/inspect') ? new Promise(resolve => { finish = resolve; }) : original(path, init));
  let selected = target; const { result, rerender } = renderHook(() => useApprovals(selected, true));
  await waitFor(() => expect(result.current.page).not.toBeNull()); let request!: Promise<void>;
  act(() => { request = result.current.prepare(item, 'deny'); });
  selected = { ...target, sessionId: 'replaced-session' }; rerender();
  await act(async () => { finish({ target, source: { state: 'current', observedAt: 1234 }, approval: item, applied: false, observationId: observation }); await request; });
  expect(result.current.inspected).toBeNull(); expect(result.current.confirmation).toBeNull(); expect(resolves()).toHaveLength(0);
});
it('keeps an attempted native identity blocked across tab unmount/remount', async () => {
  const first = renderHook(() => useApprovals(target, true)); await waitFor(() => expect(first.result.current.page).not.toBeNull());
  await act(() => first.result.current.prepare(item, 'deny')); await act(() => first.result.current.confirm()); first.unmount();
  const second = renderHook(() => useApprovals(target, true)); await waitFor(() => expect(second.result.current.page).not.toBeNull());
  await act(() => second.result.current.inspect(item)); await act(() => second.result.current.prepare(item, 'allow-once')); await act(() => second.result.current.confirm());
  expect(resolves()).toHaveLength(1); expect(second.result.current.canDecide(item)).toBe(false);
});
it('fails closed when an inspection omits its pending observation identity', async () => {
  const original = access.request.getMockImplementation()!;
  access.request.mockImplementation(async (path, init) => { const value = await original(path, init); if (path.endsWith('/inspect')) delete value.observationId; return value; });
  const { result } = renderHook(() => useApprovals(target, true)); await waitFor(() => expect(result.current.page).not.toBeNull());
  await act(() => result.current.prepare(item, 'deny')); expect(result.current.confirmation).toBeNull(); expect(result.current.error?.code).toBe('invalid-source');
  expect(result.current.canDecide(item)).toBe(false);
});
it('a timed-out read preserves last-known time and releases the in-flight guard', async () => {
  const { result } = renderHook(() => useApprovals(target, true)); await waitFor(() => expect(result.current.page).not.toBeNull());
  vi.useFakeTimers(); access.request.mockImplementation((_path, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new ControlApiError('unavailable')), { once: true })));
  let read!: Promise<void>; act(() => { read = result.current.refresh(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); await read; });
  expect(result.current.error?.code).toBe('timed-out'); expect(result.current.page?.source).toEqual({ state: 'stale', observedAt: 1234 });
  vi.useRealTimers();
});
