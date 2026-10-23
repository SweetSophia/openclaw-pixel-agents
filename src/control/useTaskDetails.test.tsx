import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskDetails } from './useTaskDetails';
import type { ControlSession, ControlTaskSnapshot } from '../../shared/control';
import { ControlApiError } from './api';

const f = vi.hoisted(() => ({ request: vi.fn(), generation: 1, state: 'unlocked' }));
vi.mock('./ControlAccess', () => ({ useControlAccess: () => ({ ...f, status: { configured: true, state: 'ready', canRead: true, canSend: false } }) }));
const session = (key: string, changes = {}): ControlSession => ({ agentId: 'cylena', sessionKey: `agent:cylena:${key}`, sessionId: `id-${key}`, name: key, isChild: false, hasActiveRun: true, updatedAt: 10, ...changes });
const a = session('a'); const b = session('b', { updatedAt: 20 });
const task = (target = a, at = 100): ControlTaskSnapshot => ({ target, source: { state: 'current', observedAt: at }, hasActiveRun: true, runId: 'run-1', runState: 'running', requestAssociation: 'unknown', requestState: 'not-loaded', activity: [], children: [], childrenComplete: true, loadedRecords: 200 });
const page = (sessions = [a, b], nextCursor?: string) => ({ sessions, source: { state: 'current', observedAt: 100 }, nextCursor });
function setup(sessions = [a, b]) {
  f.state = 'unlocked'; f.generation = 1;
  f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page(sessions) : task(JSON.parse(String(init?.body))));
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); f.request.mockReset(); });
describe('task selection and refresh lifecycle', () => {
  it('selects the exact roster conversation and keeps the choice while another becomes busier', async () => {
    setup(); const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true }));
    await waitFor(() => expect(result.current.task?.runState).toBe('running')); expect(result.current.selected?.sessionKey).toBe(a.sessionKey);
    await act(() => result.current.refresh()); expect(result.current.selected?.sessionKey).toBe(a.sessionKey);
    act(() => result.current.selectSession(b)); await waitFor(() => expect(result.current.task?.target.sessionKey).toBe(b.sessionKey));
  });
  it('explains newest non-child and child-only fallbacks', async () => {
    setup([session('child', { isChild: true, updatedAt: 30 }), a, b]);
    const first = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: 'missing', active: true }));
    await waitFor(() => expect(first.result.current.selected?.sessionKey).toBe(b.sessionKey)); expect(first.result.current.selectionNote).toMatch(/newest.*conversation/i); first.unmount();
    setup([session('child', { isChild: true })]); const second = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: 'missing', active: true }));
    await waitFor(() => expect(second.result.current.selected?.isChild).toBe(true)); expect(second.result.current.selectionNote).toMatch(/child/i);
  });
  it('pages the session selector without discarding the selected exact target', async () => {
    setup(); f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? path.includes('?') ? page([b]) : page([a], 'next-page') : task(JSON.parse(String(init?.body))));
    const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true }));
    await waitFor(() => expect(result.current.selected).toBeTruthy()); await act(() => result.current.loadMoreSessions());
    expect(result.current.sessions).toHaveLength(2); expect(result.current.selected?.sessionId).toBe(a.sessionId);
  });
  it('does not adopt a replacement session and requires an explicit new selection', async () => {
    setup(); const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true }));
    await waitFor(() => expect(result.current.task).toBeTruthy());
    const replacement = { ...a, sessionId: 'replacement' };
    f.request.mockImplementation(async (path: string) => { if (path.includes('/sessions')) return page([replacement]); throw new ControlApiError('session-changed'); });
    await act(() => result.current.refresh()); expect(result.current.selected?.sessionId).toBe(a.sessionId);
    expect(result.current.task).toBeNull(); expect(result.current.error?.code).toBe('session-changed');
  });
  it('refreshes every five seconds only while open and visible, with no overlapping reads', async () => {
    setup(); vi.useFakeTimers(); const { result, rerender } = renderHook(({ active }) => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active }), { initialProps: { active: true } });
    await act(() => vi.advanceTimersByTimeAsync(0)); expect(result.current.task).toBeTruthy(); f.request.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(5000)); expect(f.request.mock.calls.filter(([path]) => String(path).endsWith('/task'))).toHaveLength(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); act(() => document.dispatchEvent(new Event('visibilitychange')));
    f.request.mockClear(); await act(() => vi.advanceTimersByTimeAsync(15000)); expect(f.request).not.toHaveBeenCalled();
    rerender({ active: false }); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(() => vi.advanceTimersByTimeAsync(10000)); expect(f.request).not.toHaveBeenCalled();
  });
  it('keeps last known facts on failure and clears them immediately on lock', async () => {
    setup(); const { result, rerender } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true }));
    await waitFor(() => expect(result.current.task).toBeTruthy()); f.request.mockRejectedValue(new ControlApiError('unavailable'));
    await act(() => result.current.refresh()); expect(result.current.task?.source).toEqual({ state: 'stale', observedAt: 100 });
    f.state = 'locked'; f.generation++; rerender(); expect(result.current.task).toBeNull(); expect(result.current.sessions).toEqual([]);
  });
  it('does not overlap pending reads and aborts them when the panel closes', async () => {
    setup(); vi.useFakeTimers(); let signal: AbortSignal | undefined;
    f.request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/sessions')) return page();
      signal = init?.signal ?? undefined; return new Promise(() => {});
    });
    const { rerender } = renderHook(({ active }) => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active }), { initialProps: { active: true } });
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(f.request.mock.calls.filter(([path]) => String(path).endsWith('/task'))).toHaveLength(1);
    rerender({ active: false }); expect(signal?.aborted).toBe(true);
  });
  it('drops old-selection responses and does not regress a newer sampling timestamp', async () => {
    setup(); let resolveOld: (value: unknown) => void = () => {};
    f.request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/sessions')) return page();
      const target = JSON.parse(String(init?.body));
      return target.sessionId === a.sessionId ? new Promise(done => { resolveOld = done; }) : task(b, 200);
    });
    const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true }));
    await waitFor(() => expect(result.current.selected?.sessionId).toBe(a.sessionId));
    act(() => result.current.selectSession(b)); await waitFor(() => expect(result.current.task?.source.observedAt).toBe(200));
    await act(async () => resolveOld(task(a, 300))); expect(result.current.task?.target.sessionId).toBe(b.sessionId);
    f.request.mockImplementation(async (path: string) => path.includes('/sessions') ? page() : task(b, 100));
    await act(() => result.current.refresh()); expect(result.current.task?.source.observedAt).toBe(200);
  });
});
