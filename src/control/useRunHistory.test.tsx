import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRunHistory } from './useRunHistory';
import { ControlApiError } from './api';
import type { ControlRunHistorySnapshot } from '../../shared/controlRunHistory';
const f = vi.hoisted(() => ({ request: vi.fn(), state: 'unlocked', generation: 1, sourceState: 'ready' }));
vi.mock('./ControlAccess', () => ({ useControlAccess: () => ({ ...f, status: { configured: true, state: f.sourceState, canRead: f.sourceState === 'ready', canSend: true } }) }));
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 'session-1' };
const snapshot = (runId?: string, at = 100): ControlRunHistorySnapshot => ({ target, source: { state: 'current', observedAt: at }, runs: [{ runId: 'run-a' }, { runId: 'run-b' }], runsTruncated: false,
  loadedRecords: 20, limitReached: false, nextCursor: 'earlier', selectedRunId: runId, messages: [], messagesTruncated: false,
  ...(runId ? { task: { target, source: { state: 'current', observedAt: at }, hasActiveRun: null, runId, runState: 'unknown', requestAssociation: 'unknown', requestState: 'unavailable', activity: [], children: [], childrenComplete: false, loadedRecords: 20 } } : {}) });
function setup() { f.state = 'unlocked'; f.generation = 1; f.sourceState = 'ready'; f.request.mockImplementation(async (_path, init) => snapshot(JSON.parse(init.body).runId)); }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); f.request.mockReset(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });
describe('run selection source fences', () => {
  it('sends the exact selected run and retains its identity through earlier discovery', async () => {
    setup(); const { result } = renderHook(() => useRunHistory({ target, runId: 'run-a', active: true }));
    await waitFor(() => expect(result.current.snapshot?.task?.runId).toBe('run-a'));
    await act(() => result.current.loadEarlier()); expect(JSON.parse(f.request.mock.lastCall![1].body)).toMatchObject({ ...target, runId: 'run-a', cursor: 'earlier' });
    await act(() => result.current.refresh()); expect(JSON.parse(f.request.mock.lastCall![1].body)).toMatchObject({ runId: 'run-a', refresh: true });
  });
  it('rejects a mismatched run from Results instead of displaying current-conversation files', async () => {
    setup(); f.request.mockImplementation(async (path, init) => path.endsWith('/runs') ? snapshot(JSON.parse(init.body).runId) : {
      target, scope: { kind: 'run', runId: 'another-run' }, source: { state: 'current', observedAt: 100 }, sourceRevision: 'revision', runState: 'unknown', responseKind: 'none', artifactState: 'ready', artifacts: [], artifactsTruncated: false,
    });
    const { result } = renderHook(() => useRunHistory({ target, runId: 'run-a', active: true, resultsActive: true }));
    await waitFor(() => expect(result.current.error?.code).toBe('invalid-source')); expect(result.current.results).toBeNull();
    expect(f.request.mock.calls.find(([path]) => path.endsWith('/results'))?.[1].body).toContain('"runId":"run-a"');
  });
  it.each(['run', 'session', 'lock', 'generation', 'hidden', 'close'])('discards a late history response after %s changes', async change => {
    setup(); let finish!: (value: unknown) => void; let signal!: AbortSignal;
    f.request.mockImplementation((_path, init) => { signal = init.signal; return new Promise(resolve => { finish = resolve; }); });
    const { result, rerender } = renderHook(({ runId, selected, active }) => useRunHistory({ target: selected, runId, active }), { initialProps: { runId: 'run-a', selected: target, active: true } });
    await waitFor(() => expect(finish).toBeTypeOf('function')); const oldFinish = finish; const oldSignal = signal;
    if (change === 'run') rerender({ runId: 'run-b', selected: target, active: true });
    else if (change === 'session') rerender({ runId: 'run-a', selected: { ...target, sessionId: 'replacement' }, active: true });
    else if (change === 'lock') { f.state = 'locked'; rerender({ runId: 'run-a', selected: target, active: true }); }
    else if (change === 'generation') { f.generation++; rerender({ runId: 'run-a', selected: target, active: true }); }
    else if (change === 'hidden') { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); act(() => document.dispatchEvent(new Event('visibilitychange'))); }
    else rerender({ runId: 'run-a', selected: target, active: false });
    expect(oldSignal.aborted).toBe(true); await act(async () => oldFinish(snapshot('run-a'))); expect(result.current.snapshot).toBeNull();
  });
  it('retains original observation time on source loss and clears facts on lifecycle rejection', async () => {
    setup(); const { result, rerender } = renderHook(() => useRunHistory({ target, runId: 'run-a', active: true }));
    await waitFor(() => expect(result.current.snapshot).toBeTruthy());
    f.request.mockRejectedValue(new ControlApiError('unavailable')); await act(() => result.current.refresh()); expect(result.current.snapshot?.source).toEqual({ state: 'stale', observedAt: 100 });
    f.sourceState = 'unavailable'; rerender(); expect(result.current.snapshot?.task?.source).toEqual({ state: 'stale', observedAt: 100 });
    f.sourceState = 'ready'; f.request.mockRejectedValue(new ControlApiError('session-changed')); rerender();
    await waitFor(() => expect(result.current.snapshot).toBeNull());
  });
  it('frees a timed-out slot and exposes the timeout rather than keeping loading forever', async () => {
    setup(); vi.useFakeTimers(); let signal!: AbortSignal;
    f.request.mockImplementation((_path, init) => { signal = init.signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new ControlApiError('unavailable')))); });
    const { result } = renderHook(() => useRunHistory({ target, runId: 'run-a', active: true }));
    await act(() => vi.advanceTimersByTimeAsync(60000)); expect(signal.aborted).toBe(true); expect(result.current.error?.code).toBe('timed-out'); expect(result.current.loading).toBe(false);
    f.request.mockResolvedValue(snapshot('run-a')); await act(() => result.current.refresh()); expect(result.current.snapshot?.task?.runId).toBe('run-a');
  });
});
