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
  it('defaults to follow-up and retains intent with each exact conversation draft', async () => {
    setup(); const { result, rerender } = renderHook(({ target, active }) => useConversation(target, active), { initialProps: { target: a, active: true } });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.intent).toBe('followup'); act(() => { result.current.setDraft('draft A'); result.current.setIntent('steer'); });
    rerender({ target: b, active: true }); expect(result.current.intent).toBe('followup');
    act(() => result.current.setDraft('draft B')); rerender({ target: a, active: false });
    expect(result.current.draft).toBe('draft A'); expect(result.current.intent).toBe('steer');
    f.request.mockClear(); await act(() => result.current.send()); await act(() => result.current.refresh());
    expect(f.request).not.toHaveBeenCalled();
    rerender({ target: a, active: true }); await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.draft).toBe('draft A'); expect(result.current.intent).toBe('steer');
  });
  it('keeps original steering intent, message, target and ID across retries and coalesces duplicate clicks', async () => {
    setup(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((path, init) => path.endsWith('/send') ? Promise.resolve({ target: a, idempotencyKey: JSON.parse(String(init.body)).idempotencyKey, phase: 'unknown' }) : original(path, init));
    const { result } = renderHook(() => useConversation(a, true)); await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => { result.current.setDraft('original steer'); result.current.setIntent('steer'); });
    await act(async () => { await Promise.all([result.current.send(), result.current.send()]); });
    act(() => { result.current.setDraft('later follow-up'); result.current.setIntent('followup'); });
    await act(() => result.current.retryPending());
    const sends = f.request.mock.calls.filter(([path]) => String(path).endsWith('/send')).map(([, init]) => JSON.parse(String(init.body)));
    expect(sends).toHaveLength(2); expect(sends[0]).toEqual(sends[1]); expect(sends[0]).toMatchObject({ intent: 'steer', message: 'original steer', target: a });
    expect(result.current.intent).toBe('followup'); expect(result.current.draft).toBe('later follow-up');
  });
  it.each(['followup', 'steer'] as const)('excludes command drafts at the submission boundary for %s', async intent => {
    setup(); const { result } = renderHook(() => useConversation(a, true)); await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => { result.current.setDraft('/stop'); result.current.setIntent(intent); }); await act(() => result.current.send());
    expect(result.current.disabledReason).toContain('not slash commands');
    expect(f.request.mock.calls.some(([path]) => String(path).endsWith('/send'))).toBe(false);
  });
  it('settles loading immediately if a private invalidation aborts a pending history read', async () => {
    setup(); const listeners = new Map<string, (...args: any[]) => void>();
    f.openSocket.mockReturnValue({ on: (name: string, fn: (...args: any[]) => void) => listeners.set(name, fn), emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() });
    f.request.mockImplementation(() => new Promise(() => {})); const { result } = renderHook(() => useConversation(a, true));
    await waitFor(() => expect(result.current.loading).toBe(true)); act(() => listeners.get('conversation')?.({ target: a, kind: 'invalidated', source: { state: 'stale', observedAt: 20 } }));
    expect(result.current.loading).toBe(false); expect(result.current.error?.code).toBe('session-changed');
  });
  it('does not create a conversation without a handler that can adopt its exact target', async () => {
    setup(); const { result } = renderHook(() => useConversation(a, true)); await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.newConversation()); expect(result.current.isNew).toBe(false); expect(result.current.error?.code).toBe('unsupported');
    expect(f.request.mock.calls.some(([path]) => String(path).endsWith('/send'))).toBe(false);
  });
  it('retains explicitly loaded pages across automatic refresh of the same leaf', async () => {
    setup(); f.request.mockImplementation(async (_path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); return { target: a, messages: [{ id: body.cursor ? 'old' : 'latest', role: 'user', text: body.cursor ? 'older' : 'newer', truncated: false }], source: { state: 'current', observedAt: 10 }, ...(body.cursor ? {} : { nextCursor: 'older-cursor' }) };
    });
    const { result } = renderHook(() => useConversation(a, true)); await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await act(() => result.current.loadEarlier()); expect(result.current.messages).toHaveLength(2);
    await act(() => result.current.refresh()); expect(result.current.messages.map(m => m.id)).toEqual(['old', 'latest']);
  });
  it('drops a late submission response after a credential generation changes', async () => {
    setup(); let resolve: (value: unknown) => void = () => {};
    const original = f.request.getMockImplementation()!; f.request.mockImplementation((path, init) => path.endsWith('/send') ? new Promise(done => { resolve = done; }) : original(path, init));
    const { result, rerender } = renderHook(() => useConversation(a, true)); await waitFor(() => expect(result.current.ready).toBe(true)); act(() => result.current.setDraft('private draft'));
    let pending: Promise<void>; act(() => { pending = result.current.send(); });
    const call = f.request.mock.calls.find(([p]) => String(p).endsWith('/send'))!; const input = JSON.parse(String(call[1].body));
    f.generation++; f.state = 'locked'; rerender();
    await act(async () => { resolve({ target: a, idempotencyKey: input.idempotencyKey, phase: 'accepted' }); await pending; });
    expect(result.current.submission?.phase).not.toBe('accepted');
  });
  it('does not navigate away from recorded mode when a new-conversation response arrives after live composer unmount', async () => {
    setup(); let resolve!: (value: unknown) => void; const original = f.request.getMockImplementation()!; const onCreated = vi.fn();
    f.request.mockImplementation((path, init) => path.endsWith('/send') ? new Promise(done => { resolve = done; }) : original(path, init));
    const { result, unmount } = renderHook(() => useConversation(a, true, { agentId: 'cylena', onCreated }));
    await waitFor(() => expect(result.current.ready).toBe(true)); act(() => result.current.newConversation()); act(() => result.current.setDraft('create later'));
    let pending!: Promise<void>; act(() => { pending = result.current.send(); });
    const input = JSON.parse(String(f.request.mock.calls.find(([path]) => String(path).endsWith('/send'))![1].body)); unmount();
    await act(async () => { resolve({ target: b, idempotencyKey: input.idempotencyKey, phase: 'accepted' }); await pending; });
    expect(onCreated).not.toHaveBeenCalled();
  });
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
  it('keeps a timed-out submission unknown and retries its original identity and text', async () => {
    setup(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((path, init) => path.endsWith('/send') ? Promise.reject(new ControlApiError('timed-out')) : original(path, init));
    const { result } = renderHook(() => useConversation(a, true)); await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setDraft('original')); await act(() => result.current.send());
    expect(result.current.submission?.phase).toBe('unknown'); expect(result.current.draft).toBe('original');
    act(() => result.current.setDraft('edited')); await act(() => result.current.send());
    expect(f.request.mock.calls.filter(([path]) => String(path).endsWith('/send'))).toHaveLength(1);
    await act(() => result.current.retryPending());
    expect(result.current.submission?.phase).toBe('unknown'); expect(result.current.submission?.input.message).toBe('original');
    expect(result.current.draft).toBe('edited');
    const sends = f.request.mock.calls.filter(([path]) => String(path).endsWith('/send')).map(([, init]) => JSON.parse(String(init.body)));
    expect(sends).toHaveLength(2); expect(sends[1]).toEqual(sends[0]); expect(sends[1].message).toBe('original');
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
  it('retains new-conversation recovery text after adopting its target and retrying acceptance', async () => {
    setup(); const onCreated = vi.fn(); let phase = 'unknown';
    f.request.mockImplementation(async (path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); return path.endsWith('/history') ? { target: body, messages: [], source: { state: 'current', observedAt: 10 } }
        : { target: b, idempotencyKey: body.idempotencyKey, phase, ...(phase === 'persisted' ? { messageId: 'u1', messageSeq: 1 } : {}) };
    });
    const { result, rerender } = renderHook(({ target }) => useConversation(target, true, { agentId: 'cylena', onCreated }), { initialProps: { target: a } });
    await waitFor(() => expect(result.current.ready).toBe(true)); act(() => result.current.newConversation()); act(() => result.current.setDraft('new recovery draft')); await act(() => result.current.send());
    rerender({ target: b }); await waitFor(() => expect(result.current.draft).toBe('new recovery draft'));
    phase = 'accepted'; await act(() => result.current.retryPending()); expect(result.current.draft).toBe('new recovery draft'); expect(result.current.submission?.phase).toBe('accepted');
    phase = 'persisted'; await act(() => result.current.retryPending()); expect(result.current.draft).toBe(''); expect(result.current.submission?.phase).toBe('persisted');
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
