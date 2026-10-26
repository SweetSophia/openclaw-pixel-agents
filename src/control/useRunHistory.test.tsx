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
  it('retains an explicitly loaded run after expiry on a tab switch while keeping fresh discovery and artifact proof separate', async () => {
    setup(); vi.useFakeTimers(); vi.setSystemTime(1000); let recovered = false;
    const loaded = { ...snapshot('run-a', 100), loadedRecords: 262, nextCursor: undefined,
      task: { ...snapshot('run-a', 100).task!, loadedRecords: 262, request: { id: 'old-request', role: 'user' as const, text: 'Previously loaded request', truncated: false, runId: 'run-a' }, requestAssociation: 'run' as const },
      messages: [{ id: 'old-answer', role: 'assistant' as const, text: 'Previously loaded response', truncated: false, runId: 'run-a' }] };
    f.request.mockImplementation(async (path, init) => {
      if (path.endsWith('/results')) return { target, scope: { kind: 'run', runId: 'run-a' }, source: { state: 'current', observedAt: 100 }, sourceRevision: 'revision', runState: 'unknown', responseKind: 'none', artifactState: 'ready', artifacts: [], artifactsTruncated: false };
      return Date.now() < 61000 || recovered ? loaded : { ...snapshot('run-a', 61000), loadedRecords: 200, task: undefined, nextCursor: 'fresh-earlier' };
    });
    const { result, rerender } = renderHook(({ resultsActive }) => useRunHistory({ target, runId: 'run-a', active: true, resultsActive }), { initialProps: { resultsActive: true } });
    await act(() => vi.advanceTimersByTimeAsync(0)); expect(result.current.results?.artifactState).toBe('ready');
    await act(() => vi.advanceTimersByTimeAsync(61000)); rerender({ resultsActive: false }); await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.snapshot?.loadedRecords).toBe(200); expect(result.current.snapshot?.task).toBeUndefined();
    expect(result.current.lastKnown?.loadedRecords).toBe(262); expect(result.current.lastKnown?.source).toEqual({ state: 'current', observedAt: 100 });
    expect(result.current.lastKnown?.task?.request?.text).toBe('Previously loaded request'); expect(result.current.lastKnown?.messages[0].text).toBe('Previously loaded response');
    expect(result.current.results).toBeNull(); f.request.mockClear(); rerender({ resultsActive: true }); await act(() => vi.advanceTimersByTimeAsync(0));
    expect(f.request.mock.calls.some(([path]) => path.endsWith('/results'))).toBe(false); expect(result.current.results).toBeNull();
    recovered = true; await act(() => result.current.loadEarlier()); expect(JSON.parse(f.request.mock.calls.find(([, init]) => JSON.parse(init.body).cursor)?.[1].body).cursor).toBe('fresh-earlier');
    expect(result.current.lastKnown).toBeNull(); expect(result.current.snapshot?.task?.runId).toBe('run-a'); expect(result.current.results?.artifactState).toBe('ready');
  });
  it.each(['run', 'target', 'lock', 'generation', 'lifecycle'])('clears the retained text after %s changes', async change => {
    setup(); let expired = false;
    f.request.mockImplementation(async () => expired ? { ...snapshot('run-a', 200), task: undefined } : snapshot('run-a', 100));
    const { result, rerender } = renderHook(({ runId, selected }) => useRunHistory({ target: selected, runId, active: true }), { initialProps: { runId: 'run-a', selected: target } });
    await waitFor(() => expect(result.current.snapshot?.task).toBeTruthy()); expired = true; await act(() => result.current.refresh()); expect(result.current.lastKnown?.task?.runId).toBe('run-a');
    if (change === 'run') rerender({ runId: 'run-b', selected: target });
    else if (change === 'target') rerender({ runId: 'run-a', selected: { ...target, sessionId: 'replacement' } });
    else if (change === 'lock') { f.state = 'locked'; rerender({ runId: 'run-a', selected: target }); }
    else if (change === 'generation') { f.generation++; rerender({ runId: 'run-a', selected: target }); }
    else { f.request.mockRejectedValue(new ControlApiError('session-changed')); await act(() => result.current.refresh()); }
    expect(result.current.lastKnown).toBeNull();
  });
});
