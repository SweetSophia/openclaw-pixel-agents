import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConversation } from './useConversation';
import { ControlApiError } from './api';
const f = vi.hoisted(() => ({ request: vi.fn(), openSocket: vi.fn(), generation: 1, state: 'unlocked', canSend: true }));
vi.mock('./ControlAccess', () => ({ useControlAccess: () => ({ ...f, status: { canRead: true, canSend: f.canSend } }), useConversationDrafts: () => undefined }));
const a = { agentId: 'cylena', sessionKey: 'agent:cylena:a', sessionId: 's1', activeLeafEntryId: 'leaf1' };
const b = { ...a, sessionKey: 'agent:cylena:b', sessionId: 's2' };
function setup() {
  f.generation = 1; f.state = 'unlocked'; f.canSend = true; f.openSocket.mockReturnValue(null);
  f.request.mockImplementation(async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return path.endsWith('/history') ? { target: body, messages: [], source: { state: 'current', observedAt: 10 } }
      : { target: body.target ?? a, idempotencyKey: body.idempotencyKey, phase: 'accepted', runId: body.idempotencyKey };
  });
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('manual conversation submissions', () => {
  it('retains drafts across exact target switches and fences replacements', async () => {
    setup(); const { result, rerender } = renderHook(({ target }) => useConversation(target, true), { initialProps: { target: a } });
    await waitFor(() => expect(result.current.loading).toBe(false)); act(() => result.current.setDraft('draft A'));
    rerender({ target: b }); act(() => result.current.setDraft('draft B')); rerender({ target: a }); expect(result.current.draft).toBe('draft A');
    rerender({ target: { ...a, sessionId: 'replacement' } }); expect(result.current.draft).toBe('');
    expect(f.request.mock.calls.some(([path]) => String(path).endsWith('/send'))).toBe(false);
  });
  it('keeps immutable original key/text across unknown retries and clears only on persistence', async () => {
    setup(); let phase = 'unknown';
    f.request.mockImplementation(async (path: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); return path.endsWith('/history') ? { target: body, messages: [], source: { state: 'current', observedAt: 10 } } : { target: a, idempotencyKey: body.idempotencyKey, phase, ...(phase === 'persisted' ? { messageId: 'u1', messageSeq: 1 } : {}) }; });
    const { result } = renderHook(() => useConversation(a, true)); await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setDraft('original')); await act(() => result.current.send()); expect(result.current.submission?.phase).toBe('unknown'); expect(result.current.draft).toBe('original');
    act(() => result.current.setDraft('edited')); phase = 'persisted'; await act(() => result.current.retryPending());
    const sends = f.request.mock.calls.filter(([path]) => String(path).endsWith('/send')).map(([, init]) => JSON.parse(String(init.body)));
    expect(sends).toHaveLength(2); expect(sends[0]).toEqual(sends[1]); expect(sends[0].message).toBe('original');
    expect(result.current.submission?.phase).toBe('persisted'); expect(result.current.draft).toBe('edited');
  });
  it('does not replay after reconnect, keeps rejected drafts and enforces limits', async () => {
    setup(); const { result, rerender } = renderHook(() => useConversation(a, true)); await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setDraft('x'.repeat(8001))); await act(() => result.current.send()); expect(f.request.mock.calls.filter(([p]) => String(p).endsWith('/send'))).toHaveLength(0);
    act(() => result.current.setDraft('keep me')); f.request.mockRejectedValue(new ControlApiError('session-changed')); await act(() => result.current.send()); expect(result.current.draft).toBe('keep me');
    f.generation++; rerender(); await Promise.resolve(); expect(f.request.mock.calls.filter(([p]) => String(p).endsWith('/send'))).toHaveLength(1);
  });
  it('starts a new draft without issuing a create or send until the explicit submission', async () => {
    setup(); const onCreated = vi.fn(); const { result } = renderHook(() => useConversation(a, true, { agentId: 'cylena', onCreated }));
    await waitFor(() => expect(result.current.ready).toBe(true)); act(() => result.current.setDraft('old')); act(() => result.current.newConversation());
    expect(result.current.draft).toBe(''); act(() => result.current.setDraft('new')); await act(() => result.current.send());
    const send = f.request.mock.calls.find(([p]) => String(p).endsWith('/send'))!; expect(JSON.parse(String(send[1].body))).toMatchObject({ agentId: 'cylena', newConversation: true, message: 'new' }); expect(JSON.parse(String(send[1].body))).not.toHaveProperty('target'); expect(onCreated).toHaveBeenCalledWith(a);
  });
  it('tears down private subscriptions on target/lock/close and never sends from an event', async () => {
    setup(); const listeners = new Map<string, (...args: any[]) => void>();
    const socket = { on: vi.fn((name, fn) => { listeners.set(name, fn); }), emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() };
    f.openSocket.mockReturnValue(socket);
    const { rerender, unmount } = renderHook(({ target, active }) => useConversation(target, active), { initialProps: { target: a, active: true } });
    await waitFor(() => expect(socket.connect).toHaveBeenCalled()); act(() => listeners.get('connect')?.()); expect(socket.emit).toHaveBeenCalledWith('watch', a, expect.any(Function));
    rerender({ target: b, active: true }); expect(socket.disconnect).toHaveBeenCalled();
    f.state = 'locked'; f.generation++; rerender({ target: b, active: true }); expect(socket.emit).toHaveBeenCalledWith('unwatch'); unmount();
    expect(f.request.mock.calls.some(([path]) => String(path).endsWith('/send'))).toBe(false);
  });
});
