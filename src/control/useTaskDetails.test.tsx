import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskDetails } from './useTaskDetails';
import type { ControlSession, ControlTaskSnapshot } from '../../shared/control';
import { ControlApiError } from './api';
import type { ControlResultsSnapshot } from '../../shared/controlResults';
import type { ControlUsageSnapshot } from '../../shared/controlUsage';

const f = vi.hoisted(() => ({ request: vi.fn(), generation: 1, state: 'unlocked', sourceState: 'ready' }));
vi.mock('./ControlAccess', () => ({ useControlAccess: () => ({ ...f, status: { configured: true, state: f.sourceState, canRead: f.sourceState === 'ready', canSend: false } }) }));
const session = (key: string, changes = {}): ControlSession => ({ agentId: 'cylena', sessionKey: `agent:cylena:${key}`, sessionId: `id-${key}`, name: key, isChild: false, hasActiveRun: true, updatedAt: 10, ...changes });
const a = session('a'); const b = session('b', { updatedAt: 20 });
const task = (target = a, at = 100): ControlTaskSnapshot => ({ target, source: { state: 'current', observedAt: at }, hasActiveRun: true, runId: 'run-1', runState: 'running', requestAssociation: 'unknown', requestState: 'not-loaded', activity: [], children: [], childrenComplete: true, loadedRecords: 200 });
const page = (sessions = [a, b], nextCursor?: string) => ({ sessions, source: { state: 'current', observedAt: 100 }, nextCursor });
function setup(sessions = [a, b]) {
  f.state = 'unlocked'; f.generation = 1; f.sourceState = 'ready';
  f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page(sessions) : path.endsWith('/selection') ? { session: null } : task(JSON.parse(String(init?.body))));
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); f.request.mockReset(); });
describe('task selection and refresh lifecycle', () => {
  const usage = (target = a): ControlUsageSnapshot => ({ target, source: { state: 'current', observedAt: 100 }, state: 'ready', tokens: { input: 0, output: 20 }, cost: {}, computedAt: 50 });
  it('shares the selected conversation with Usage and polls no task/history/results on that tab', async () => {
    setup(); vi.useFakeTimers(); f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page() : path.endsWith('/usage') ? usage(JSON.parse(String(init?.body))) : task(JSON.parse(String(init?.body))));
    const { result, rerender } = renderHook(({ usageActive }) => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true, usageActive, taskActive: !usageActive }), { initialProps: { usageActive: false } });
    await act(() => vi.advanceTimersByTimeAsync(0)); act(() => result.current.selectSession(b)); await act(() => vi.advanceTimersByTimeAsync(0));
    rerender({ usageActive: true }); await act(() => vi.advanceTimersByTimeAsync(0)); expect(result.current.usage?.target.sessionId).toBe(b.sessionId);
    f.request.mockClear(); await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(f.request.mock.calls.filter(([path]) => String(path).endsWith('/usage'))).toHaveLength(1);
    expect(f.request.mock.calls.some(([path]) => /\/(task|history|results)$/.test(String(path)))).toBe(false);
  });
  it('retains Usage computation/observation times on failure and clears it on identity or auth rejection', async () => {
    setup(); f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page() : usage(JSON.parse(String(init?.body))));
    const { result, rerender } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true, usageActive: true, taskActive: false }));
    await waitFor(() => expect(result.current.usage).toBeTruthy());
    f.request.mockRejectedValue(new ControlApiError('unavailable')); await act(() => result.current.refresh());
    expect(result.current.usage?.source).toEqual({ state: 'stale', observedAt: 100 }); expect(result.current.usage?.computedAt).toBe(50);
    f.request.mockRejectedValue(new ControlApiError('session-changed')); await act(() => result.current.refresh()); expect(result.current.usage).toBeNull();
    f.state = 'locked'; rerender(); expect(result.current.usage).toBeNull();
  });
  it('marks retained Usage stale as soon as the private source becomes unavailable', async () => {
    setup(); f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page() : usage(JSON.parse(String(init?.body))));
    const { result, rerender } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true, usageActive: true, taskActive: false }));
    await waitFor(() => expect(result.current.usage?.state).toBe('ready'));
    f.sourceState = 'unavailable'; rerender();
    expect(result.current.usage?.source).toEqual({ state: 'stale', observedAt: 100 });
    f.sourceState = 'auth-error'; rerender(); expect(result.current.usage).toBeNull();
  });
  it.each(['usage', 'results'] as const)('does not relabel the untouched Task snapshot after a %s-only refresh failure', async mode => {
    setup(); f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page() : path.endsWith('/usage') ? usage(JSON.parse(String(init?.body))) : path.endsWith('/results') ? results(JSON.parse(String(init?.body))) : task(JSON.parse(String(init?.body))));
    const { result, rerender } = renderHook(({ selectedMode }) => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true, usageActive: selectedMode === 'usage', resultsActive: selectedMode === 'results', taskActive: selectedMode === 'task' }), { initialProps: { selectedMode: 'task' as 'task' | 'results' | 'usage' } });
    await waitFor(() => expect(result.current.task).toBeTruthy()); rerender({ selectedMode: mode });
    await waitFor(() => expect(result.current[mode]).toBeTruthy());
    f.request.mockImplementation(async (path: string) => { if (path.endsWith(`/${mode}`)) throw new ControlApiError('unavailable'); return page(); });
    await act(() => result.current.refresh());
    expect(result.current[mode]?.source).toEqual({ state: 'stale', observedAt: 100 });
    expect(result.current.task?.source).toEqual({ state: 'current', observedAt: 100 });
  });
  it('clears only Usage after an optional-method denial but clears all snapshots after global authority loss', async () => {
    setup(); f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page() : path.endsWith('/usage') ? usage(JSON.parse(String(init?.body))) : path.endsWith('/results') ? results(JSON.parse(String(init?.body))) : task(JSON.parse(String(init?.body))));
    const { result, rerender } = renderHook(({ mode }) => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true, usageActive: mode === 'usage', resultsActive: mode === 'results', taskActive: mode === 'task' }), { initialProps: { mode: 'task' as 'task' | 'results' | 'usage' | 'conversation' } });
    await waitFor(() => expect(result.current.task).toBeTruthy()); rerender({ mode: 'results' }); await waitFor(() => expect(result.current.results).toBeTruthy());
    rerender({ mode: 'usage' }); await waitFor(() => expect(result.current.usage).toBeTruthy());
    f.request.mockImplementation(async (path: string) => { if (path.endsWith('/usage')) throw new ControlApiError('usage-denied'); return page(); });
    await act(() => result.current.refresh());
    expect(result.current.usage).toBeNull(); expect(result.current.task?.source.state).toBe('current'); expect(result.current.results?.source.state).toBe('current');
    expect(result.current.error).toBeNull(); expect(result.current.usageError?.code).toBe('usage-denied');
    rerender({ mode: 'conversation' }); await act(() => result.current.refresh()); expect(result.current.error).toBeNull();
    f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page() : usage(JSON.parse(String(init?.body))));
    rerender({ mode: 'usage' }); await waitFor(() => expect(result.current.usage).toBeTruthy()); expect(result.current.usageError).toBeNull();
    f.request.mockImplementation(async (path: string) => { if (path.endsWith('/usage')) throw new ControlApiError('scope-required'); return page(); });
    await act(() => result.current.refresh()); expect(result.current.error?.code).toBe('scope-required');
    expect(result.current.task).toBeNull(); expect(result.current.results).toBeNull(); expect(result.current.usage).toBeNull();
  });
  it.each(['tab', 'lock', 'hidden', 'target'])('suppresses a late Usage response after a %s change', async change => {
    setup(); let finish!: (value: unknown) => void; let signal!: AbortSignal;
    f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page() : new Promise(resolve => { finish = resolve; signal = init!.signal!; }));
    const { result, rerender, unmount } = renderHook(({ active }) => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active, usageActive: true, taskActive: false }), { initialProps: { active: true } });
    await waitFor(() => expect(finish).toBeTypeOf('function')); const oldFinish = finish; const oldSignal = signal;
    if (change === 'tab') rerender({ active: false });
    else if (change === 'lock') { f.state = 'locked'; rerender({ active: true }); }
    else if (change === 'hidden') { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); act(() => document.dispatchEvent(new Event('visibilitychange'))); }
    else act(() => result.current.selectSession(b));
    expect(oldSignal.aborted).toBe(true); await act(async () => oldFinish(usage(a))); expect(result.current.usage).toBeNull(); unmount();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });
  const results = (target = a): ControlResultsSnapshot => ({ target, scope: { kind: 'run', runId: 'run-1' }, source: { state: 'current', observedAt: 100 }, sourceRevision: 'source-1', runState: 'running', responseKind: 'none', artifactState: 'ready', artifacts: [], artifactsTruncated: false });
  it.each(['sessions', 'task', 'results'])('times out a stalled %s read and frees its request slot', async stalled => {
    setup(); vi.useFakeTimers();
    const normal = async (path: string, init?: RequestInit) => path.includes('/sessions') ? page() : stalled === 'results' ? results(JSON.parse(String(init?.body))) : task(JSON.parse(String(init?.body)));
    f.request.mockImplementation(normal);
    const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true, resultsActive: stalled === 'results' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    let signal!: AbortSignal;
    f.request.mockImplementation((path: string, init?: RequestInit) => {
      if (!path.endsWith(`/${stalled}`)) return normal(path, init);
      signal = init!.signal!; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new ControlApiError('invalid-source')), { once: true }));
    });
    let pending!: Promise<void>; act(() => { pending = result.current.refresh(); });
    await act(() => vi.advanceTimersByTimeAsync(60000)); await act(async () => { await pending; });
    expect(signal.aborted).toBe(true); expect(result.current.loading).toBe(false); expect(result.current.sessionsLoading).toBe(false);
    expect(result.current.error?.code).toBe('timed-out');
    if (stalled !== 'sessions') expect((stalled === 'results' ? result.current.results : result.current.task)?.source).toEqual({ state: 'stale', observedAt: 100 });
    f.request.mockImplementation(normal); f.request.mockClear(); await act(() => result.current.refresh());
    expect(f.request.mock.calls.some(([path]) => String(path).endsWith(`/${stalled}`))).toBe(true);
  });
  it('forwards manual cancellation to both Task refresh reads', async () => {
    setup(); vi.useFakeTimers();
    const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true }));
    await act(() => vi.advanceTimersByTimeAsync(0)); const signals: AbortSignal[] = [];
    f.request.mockImplementation((_path: string, init?: RequestInit) => {
      const signal = init!.signal!; signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new ControlApiError('invalid-source')), { once: true }));
    });
    const controller = new AbortController(); let pending!: Promise<void>;
    act(() => { pending = result.current.refresh(controller.signal); controller.abort(); });
    await act(async () => { await pending; });
    expect(signals).toHaveLength(2); expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(result.current.loading).toBe(false); expect(result.current.sessionsLoading).toBe(false);
  });
  it('clears a timed-out session-list error after a successful empty-list retry', async () => {
    setup([]); vi.useFakeTimers();
    const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: '', active: true }));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    f.request.mockImplementationOnce((_path: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new ControlApiError('invalid-source')), { once: true });
    }));
    let pending!: Promise<void>; act(() => { pending = result.current.refresh(); });
    await act(() => vi.advanceTimersByTimeAsync(60000)); await act(async () => { await pending; });
    expect(result.current.error?.code).toBe('timed-out');
    await act(() => result.current.refresh()); expect(result.current.error).toBeNull(); expect(result.current.sessions).toEqual([]);
  });
  it('allows a slow session list and gives its nested task read a fresh budget', async () => {
    setup(); vi.useFakeTimers(); let firstList = true;
    const delayed = (value: unknown, milliseconds: number, signal?: AbortSignal | null) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(value), milliseconds);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new ControlApiError('invalid-source')); }, { once: true });
    });
    f.request.mockImplementation((path: string, init?: RequestInit) => {
      if (path.includes('/sessions')) { if (firstList) { firstList = false; return delayed(page(), 55000, init?.signal); } return Promise.resolve(page()); }
      return delayed(task(JSON.parse(String(init?.body))), 12000, init?.signal);
    });
    const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true }));
    await act(() => vi.advanceTimersByTimeAsync(67000));
    expect(result.current.task?.target.sessionId).toBe(a.sessionId); expect(result.current.error).toBeNull();
  });
  it('does not let an aborted session read overwrite the replacement tab read', async () => {
    setup(); const initial = { taskActive: true };
    const { result, rerender } = renderHook(({ taskActive }) => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true, taskActive }), { initialProps: initial });
    await waitFor(() => expect(result.current.task).toBeTruthy()); let release!: (value: unknown) => void;
    f.request.mockImplementation((path: string, init?: RequestInit) => {
      if (!path.includes('/sessions')) return Promise.resolve(task(JSON.parse(String(init?.body))));
      return new Promise((resolve, reject) => { release = resolve; init?.signal?.addEventListener('abort', () => reject(new ControlApiError('invalid-source')), { once: true }); });
    });
    let pending!: Promise<void>; act(() => { pending = result.current.refresh(); }); await act(async () => {});
    rerender({ taskActive: false }); await act(async () => {});
    expect(result.current.error).toBeNull(); expect(result.current.sessionsLoading).toBe(true);
    await act(async () => { release(page()); await pending; }); expect(result.current.sessionsLoading).toBe(false);
  });
  it('shares selection across tabs and uses only one results read per visible five-second tick', async () => {
    setup(); vi.useFakeTimers(); f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page() : path.endsWith('/results') ? results(JSON.parse(String(init?.body))) : task(JSON.parse(String(init?.body))));
    const { result, rerender } = renderHook(({ resultsActive, active }) => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active, resultsActive, taskActive: !resultsActive }), { initialProps: { resultsActive: false, active: true } });
    await act(() => vi.advanceTimersByTimeAsync(0)); act(() => result.current.selectSession(b)); await act(() => vi.advanceTimersByTimeAsync(0));
    rerender({ resultsActive: true, active: true }); await act(() => vi.advanceTimersByTimeAsync(0)); expect(result.current.results?.target.sessionId).toBe(b.sessionId);
    f.request.mockClear(); await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(f.request.mock.calls.filter(([path]) => String(path).endsWith('/results'))).toHaveLength(1); expect(f.request.mock.calls.filter(([path]) => String(path).endsWith('/task'))).toHaveLength(0);
    rerender({ resultsActive: true, active: false }); f.request.mockClear(); await act(() => vi.advanceTimersByTimeAsync(10000)); expect(f.request).not.toHaveBeenCalled();
  });
  it('coalesces manual Results refresh and preserves last-known timestamps while disabling current content', async () => {
    setup(); f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page() : results(JSON.parse(String(init?.body))));
    const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true, resultsActive: true, taskActive: false }));
    await waitFor(() => expect(result.current.results).toBeTruthy()); let finish: (value: unknown) => void = () => {};
    f.request.mockImplementation(async (path: string) => path.includes('/sessions') ? page() : new Promise(done => { finish = done; })); f.request.mockClear();
    let pending: Promise<void>; act(() => { pending = result.current.refresh(); }); await act(() => result.current.refresh());
    expect(f.request.mock.calls.filter(([path]) => String(path).endsWith('/results'))).toHaveLength(1);
    await act(async () => { finish(results()); await pending; });
    f.request.mockRejectedValue(new ControlApiError('unavailable')); await act(() => result.current.refresh()); expect(result.current.results?.source).toEqual({ state: 'stale', observedAt: 100 });
    f.request.mockRejectedValue(new ControlApiError('session-changed')); await act(() => result.current.refresh()); expect(result.current.results).toBeNull();
  });
  it('retains loaded conversation pages and the advanced cursor across polling refreshes', async () => {
    setup(); const c = session('c');
    f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? path.includes('page-three') ? page([c]) : path.includes('page-two') ? page([b], 'page-three') : page([a], 'page-two') : task(JSON.parse(String(init?.body))));
    const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true }));
    await waitFor(() => expect(result.current.selected).toBeTruthy()); await act(() => result.current.loadMoreSessions()); await act(() => result.current.refresh());
    expect(result.current.sessions).toContainEqual(b); expect(result.current.nextSessionsCursor).toBe('page-three');
    await act(() => result.current.loadMoreSessions()); await act(() => result.current.refresh());
    expect(result.current.sessions).toContainEqual(c); expect(result.current.nextSessionsCursor).toBeUndefined();
  });
  it('keeps only parsed target fields when adopting a newly created session', async () => {
    setup(); const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true }));
    await waitFor(() => expect(result.current.selected).toBeTruthy()); act(() => result.current.selectCreatedSession({ ...b, sessionId: 'created', extra: 'not-contract-data' } as typeof b));
    expect(result.current.selected?.sessionId).toBe('created'); expect(result.current.selected).not.toHaveProperty('extra');
  });
  it('updates selected metadata when the same conversation starts working', async () => {
    setup([{ ...a, hasActiveRun: false }]); const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true }));
    await waitFor(() => expect(result.current.selected?.hasActiveRun).toBe(false));
    f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page([{ ...a, hasActiveRun: true }]) : task(JSON.parse(String(init?.body))));
    await act(() => result.current.refresh()); expect(result.current.selected?.hasActiveRun).toBe(true);
  });
  it('resolves the exact roster conversation even when it is beyond the first page', async () => {
    setup([b]); f.request.mockImplementation(async (path: string, init?: RequestInit) => path.includes('/sessions') ? page([b], 'more') : path.endsWith('/selection') ? { session: a } : task(JSON.parse(String(init?.body))));
    const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true, taskActive: false }));
    await waitFor(() => expect(result.current.selected?.sessionId).toBe(a.sessionId)); expect(result.current.sessions).toContainEqual(a);
    expect(f.request.mock.calls.some(([path]) => String(path).endsWith('/task'))).toBe(false);
  });
  it('selects the exact roster conversation and keeps the choice while another becomes busier', async () => {
    setup(); const { result } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true }));
    await waitFor(() => expect(result.current.task?.runState).toBe('running')); expect(result.current.selected?.sessionKey).toBe(a.sessionKey);
    const body = JSON.parse(String(f.request.mock.calls.find(([path]) => String(path).endsWith('/task'))![1].body));
    expect(body).toEqual({ agentId: a.agentId, sessionKey: a.sessionKey, sessionId: a.sessionId });
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
  it('clears private facts on confirmed Gateway auth rejection and requires a fresh choice on recovery', async () => {
    setup(); const { result, rerender } = renderHook(() => useTaskDetails({ agentId: 'cylena', initialSessionKey: a.sessionKey, active: true }));
    await waitFor(() => expect(result.current.task).toBeTruthy()); f.sourceState = 'auth-error'; rerender();
    expect(result.current.task).toBeNull(); expect(result.current.sessions).toEqual([]);
    f.sourceState = 'ready'; rerender(); await waitFor(() => expect(result.current.sessions).toHaveLength(2));
    expect(result.current.selected).toBeNull(); expect(result.current.task).toBeNull();
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
