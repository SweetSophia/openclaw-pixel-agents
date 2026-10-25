import { Blob as NodeBlob } from 'node:buffer';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspace } from './useWorkspace';
import { ControlApiError } from './api';

const access = vi.hoisted(() => ({ request: vi.fn(), requestFile: vi.fn(), state: 'unlocked', generation: 1, status: { configured: true, state: 'ready', canRead: true, canSend: false } }));
vi.mock('./ControlAccess', () => ({ useControlAccess: () => access }));
const entry = { path: 'report.txt', name: 'report.txt', kind: 'file' as const, size: 5, updatedAtMs: 100 };
const page = (path = '', offset = 0, changes = {}) => ({ agentId: 'cylena', path, offset, entries: [{ ...entry, path: path ? `${path}/report.txt` : 'report.txt' }], totalEntries: 101,
  sourceRevision: 'source-1', source: { state: 'current', observedAt: 100 }, ...changes });
const create = vi.fn(() => 'blob:workspace'); const revoke = vi.fn();
beforeEach(() => {
  access.state = 'unlocked'; access.generation = 1; access.status.canRead = true; access.status.state = 'ready';
  access.request.mockReset().mockImplementation(async (_path, init) => { const input = JSON.parse(init.body); return page(input.path, input.offset); });
  access.requestFile.mockReset().mockResolvedValue({ kind: 'bytes', blob: new NodeBlob(['hello'], { type: 'text/plain' }), filename: 'report.txt', truncated: false });
  vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; }); create.mockClear(); revoke.mockClear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('agent workspace lifecycle', () => {
  it('browses directory/pages without any conversation or automatic content reads', async () => {
    const { result } = renderHook(() => useWorkspace({ agentId: 'cylena', active: true }));
    await waitFor(() => expect(result.current.page?.path).toBe('')); expect(access.requestFile).not.toHaveBeenCalled();
    act(() => result.current.navigate('notes', 50)); await waitFor(() => expect(result.current.page?.offset).toBe(50));
    let refreshing!: Promise<void>; act(() => { refreshing = result.current.refresh(); });
    await act(async () => { await refreshing; }); expect(result.current.page?.offset).toBe(0); expect(result.current.path).toBe('notes');
    expect(access.request.mock.calls.every(([path]) => String(path).endsWith('/workspace'))).toBe(true);
  });
  it('retains the original stale observation and disables file actions after failed refresh', async () => {
    vi.useFakeTimers(); const { result } = renderHook(() => useWorkspace({ agentId: 'cylena', active: true }));
    await act(async () => {}); expect(result.current.page?.source.observedAt).toBe(100);
    access.request.mockRejectedValueOnce(new ControlApiError()); await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.page?.source).toEqual({ state: 'stale', observedAt: 100 });
    await act(() => result.current.act(entry, 'download')); expect(access.requestFile).not.toHaveBeenCalled();
  });
  it.each(['source', 'metadata'] as const)('clears an existing preview when refreshed %s changes', async change => {
    vi.useFakeTimers(); access.requestFile.mockResolvedValue({ kind: 'bytes', blob: new NodeBlob(['hello'], { type: 'image/png' }), filename: 'report.txt', truncated: false });
    const { result } = renderHook(() => useWorkspace({ agentId: 'cylena', active: true })); await act(async () => {});
    await act(() => result.current.act(entry, 'preview')); expect(result.current.preview?.kind).toBe('image');
    access.request.mockResolvedValueOnce(page('', 0, change === 'source' ? { sourceRevision: 'source-2' } : { entries: [{ ...entry, updatedAtMs: 101 }] }));
    await act(() => vi.advanceTimersByTimeAsync(5000)); expect(result.current.preview).toBeNull(); expect(revoke).toHaveBeenCalledWith('blob:workspace');
    expect(result.current.error?.code).toBe('workspace-changed');
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.error?.code).toBe('workspace-changed');
    await act(() => result.current.refresh()); expect(result.current.error).toBeNull();
  });
  it('retains an unchanged preview on a first-page manual refresh', async () => {
    const { result } = renderHook(() => useWorkspace({ agentId: 'cylena', active: true }));
    await waitFor(() => expect(result.current.page).not.toBeNull());
    await act(() => result.current.act(entry, 'preview'));
    await act(() => result.current.refresh());
    expect(result.current.preview).toMatchObject({ kind: 'text', text: 'hello' });
  });
  it('keeps a paginated Refresh pending until the first-page listing is applied', async () => {
    const { result } = renderHook(() => useWorkspace({ agentId: 'cylena', active: true }));
    await waitFor(() => expect(result.current.page).not.toBeNull());
    act(() => result.current.navigate('notes', 50)); await waitFor(() => expect(result.current.page?.offset).toBe(50));
    let release!: (value: unknown) => void;
    access.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    let settled = false; let refreshing!: Promise<void>;
    act(() => { refreshing = result.current.refresh().then(() => { settled = true; }); });
    await act(async () => {});
    expect(settled).toBe(false);
    await act(async () => { release(page('notes', 0)); await refreshing; });
    expect(settled).toBe(true); expect(result.current.page?.offset).toBe(0);
  });
  it.each(['error', 'tab', 'agent', 'directory', 'hidden', 'unmount'] as const)('settles a paginated Refresh after %s', async reason => {
    const initial = { agentId: 'cylena', active: true };
    const { result, rerender, unmount } = renderHook(props => useWorkspace(props), { initialProps: initial });
    await waitFor(() => expect(result.current.page).not.toBeNull());
    act(() => result.current.navigate('notes', 50)); await waitFor(() => expect(result.current.page?.offset).toBe(50));
    let reject!: (error: Error) => void;
    access.request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    let refreshing!: Promise<void>; let settled = false;
    act(() => { refreshing = result.current.refresh().then(() => { settled = true; }); });
    await act(async () => {}); expect(settled).toBe(false);
    if (reason === 'error') act(() => { reject(new ControlApiError()); });
    if (reason === 'tab') rerender({ ...initial, active: false });
    if (reason === 'agent') rerender({ ...initial, agentId: 'other' });
    if (reason === 'directory') act(() => result.current.navigate('other'));
    if (reason === 'hidden') act(() => { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); });
    if (reason === 'unmount') unmount();
    await act(async () => { await refreshing; }); expect(settled).toBe(true);
  });
  it.each(['tab', 'agent', 'lock', 'hidden', 'directory'] as const)('aborts file reads and drops late bytes on %s', async reason => {
    let release!: (value: unknown) => void; access.requestFile.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const initial = { agentId: 'cylena', active: true }; const { result, rerender } = renderHook(props => useWorkspace(props), { initialProps: initial });
    await waitFor(() => expect(result.current.page).not.toBeNull()); let pending!: Promise<void>; act(() => { pending = result.current.act(entry, 'preview'); });
    const signal = access.requestFile.mock.calls[0][1].signal as AbortSignal;
    if (reason === 'tab') rerender({ ...initial, active: false });
    if (reason === 'agent') rerender({ ...initial, agentId: 'other' });
    if (reason === 'lock') { access.state = 'locked'; access.generation++; rerender(initial); }
    if (reason === 'directory') act(() => result.current.navigate('notes'));
    if (reason === 'hidden') act(() => { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); });
    expect(signal.aborted).toBe(true);
    await act(async () => { release({ kind: 'bytes', blob: new NodeBlob(['hello'], { type: 'image/png' }), filename: 'report.txt', truncated: false }); await pending; });
    expect(result.current.preview).toBeNull(); expect(create).not.toHaveBeenCalled();
  });
  it('ignores old directory responses and refuses unsupported or stale file selectors', async () => {
    let release!: (value: unknown) => void; access.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { result } = renderHook(() => useWorkspace({ agentId: 'cylena', active: true }));
    act(() => result.current.navigate('notes')); await waitFor(() => expect(result.current.page?.path).toBe('notes'));
    await act(async () => release(page())); expect(result.current.page?.path).toBe('notes');
    await act(() => result.current.act(entry, 'download')); expect(access.requestFile).not.toHaveBeenCalled();
  });
  it('downloads only on explicit action and reclaims the temporary anchor', async () => {
    vi.useFakeTimers(); const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { result } = renderHook(() => useWorkspace({ agentId: 'cylena', active: true })); await act(async () => {});
    await act(() => result.current.act(entry, 'download')); expect(click).toHaveBeenCalledOnce(); expect(document.querySelector('a[download]')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1000)); expect(revoke).toHaveBeenCalledWith('blob:workspace');
  });
});
