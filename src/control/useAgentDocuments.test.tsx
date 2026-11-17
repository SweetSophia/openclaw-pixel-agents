import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAgentDocuments } from './useAgentDocuments';
import { ControlApiError } from './api';

const access = vi.hoisted(() => ({ request: vi.fn(), state: 'unlocked', generation: 1, status: { canRead: true, state: 'ready' } }));
vi.mock('./ControlAccess', () => ({ useControlAccess: () => access }));
vi.mock('../util/id', () => ({ newEntityId: () => 'operation-1' }));
const management = { configured: true, state: 'ready', canEdit: true, epoch: 'epoch-1', reason: null };
const snapshot = (changes = {}) => ({ agentId: 'cylena', name: 'AGENTS.md', revision: 'revision-1', content: 'original', bytes: 8, source: { state: 'current', observedAt: 100 }, ...changes });
const initial = { agentId: 'cylena', active: true, opened: true };
beforeEach(() => {
  access.state = 'unlocked'; access.generation = 1; access.status.canRead = true;
  access.request.mockReset().mockImplementation(async (path, init) => {
    if (path.endsWith('/status')) return management;
    const body = JSON.parse(init.body);
    if (path.endsWith('/read')) return snapshot({ name: body.name });
    return { agentId: 'cylena', name: body.name, operationId: body.operationId, state: 'saved', snapshot: snapshot({ content: body.content, bytes: new TextEncoder().encode(body.content).length, revision: 'revision-2' }) };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function selected() {
  const hook = renderHook(props => useAgentDocuments(props), { initialProps: initial });
  await waitFor(() => expect(hook.result.current.management?.canEdit).toBe(true));
  await act(() => hook.result.current.select('AGENTS.md'));
  return hook;
}
it('does not start document management before explicit opening or automatically read a document', async () => {
  const { result, rerender } = renderHook(props => useAgentDocuments(props), { initialProps: { ...initial, opened: false } });
  await act(async () => {}); expect(access.request).not.toHaveBeenCalled();
  rerender(initial); await waitFor(() => expect(result.current.management?.canEdit).toBe(true));
  expect(access.request.mock.calls.every(([path]) => path.endsWith('/status'))).toBe(true);
});
it('starts explicit management under React StrictMode effect replay', async () => {
  const { result } = renderHook(() => useAgentDocuments(initial), { wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode> });
  await waitFor(() => expect(result.current.management?.canEdit).toBe(true));
});
it.each(['disabled', 'pairing-required', 'unsupported', 'permission'])('does not read or save when management is %s', async reason => {
  access.request.mockResolvedValue({ configured: reason !== 'disabled', state: reason === 'permission' ? 'auth-error' : reason, canEdit: false, epoch: null, reason });
  const { result } = renderHook(() => useAgentDocuments(initial));
  await waitFor(() => expect(result.current.management?.reason).toBe(reason));
  await act(() => result.current.select('AGENTS.md')); act(() => result.current.setDraft('changed'));
  await act(() => result.current.save()); expect(result.current.canSave).toBe(false);
  expect(access.request.mock.calls.every(([path]) => path.endsWith('/status'))).toBe(true);
});
it('reads an explicitly selected empty document and submits exactly one immutable save', async () => {
  const { result } = await selected(); expect(result.current.draft).toBe('original');
  act(() => result.current.setDraft(''));
  expect(result.current.dirty).toBe(true); expect(result.current.canSave).toBe(true);
  await act(async () => { await Promise.all([result.current.save(), result.current.save()]); });
  const saves = access.request.mock.calls.filter(([path]) => path.endsWith('/save'));
  expect(saves).toHaveLength(1); expect(JSON.parse(saves[0][1].body)).toEqual({ name: 'AGENTS.md', revision: 'revision-1', operationId: 'operation-1', content: '' });
  expect(result.current.draft).toBe(''); expect(result.current.dirty).toBe(false); expect(result.current.receipt?.state).toBe('saved');
});
it.each(['\u0000', '\ud800', 'é'.repeat(16385)])('rejects invalid draft text without dispatching', async content => {
  const { result } = await selected(); act(() => result.current.setDraft(content));
  expect(result.current.valid).toBe(false); await act(() => result.current.save());
  expect(access.request.mock.calls.some(([path]) => path.endsWith('/save'))).toBe(false);
});
it.each([{ agentId: 'other' }, { name: 'SOUL.md' }, { bytes: 7 }, { content: '\ud800', bytes: 3 }, { content: 'x'.repeat(32769), bytes: 32769 }, { source: { state: 'stale', observedAt: 100 } }])('rejects invalid or mismatched snapshots %j', async changes => {
  access.request.mockImplementation(async path => path.endsWith('/status') ? management : snapshot(changes));
  const { result } = await selected(); expect(result.current.snapshot).toBeNull(); expect(result.current.error?.code).toBe('invalid-source'); expect(result.current.canSave).toBe(false);
});
it.each(['conflict', 'unknown', 'transport', 'malformed'])('retains text and forbids replay after %s', async outcome => {
  const { result } = await selected(); act(() => result.current.setDraft('new draft'));
  access.request.mockImplementation(async path => {
    if (path.endsWith('/status')) return management;
    if (outcome === 'transport') throw new ControlApiError();
    return { agentId: 'cylena', name: 'AGENTS.md', operationId: outcome === 'malformed' ? 'wrong' : 'operation-1', state: outcome === 'conflict' ? 'conflict' : 'unknown' };
  });
  await act(() => result.current.save()); expect(result.current.draft).toBe('new draft'); expect(result.current.dirty).toBe(true); expect(result.current.canSave).toBe(false);
  const count = access.request.mock.calls.length; await act(() => result.current.save()); expect(access.request).toHaveBeenCalledTimes(count);
});
it.each(['hidden', 'inactive', 'unavailable', 'epoch'])('retains draft but invalidates its revision on %s', async reason => {
  const { result, rerender } = await selected(); act(() => result.current.setDraft('private draft'));
  if (reason === 'hidden') act(() => { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); });
  if (reason === 'inactive') rerender({ ...initial, active: false });
  if (reason === 'unavailable') { access.status.canRead = false; rerender(initial); }
  if (reason === 'epoch') { access.request.mockResolvedValue({ ...management, epoch: 'epoch-2' }); await act(() => result.current.refreshManagement()); }
  expect(result.current.draft).toBe('private draft'); expect(result.current.canSave).toBe(false);
});
it.each(['lock', 'generation', 'agent'])('clears private text on %s and drops a late read', async reason => {
  const { result, rerender } = await selected(); act(() => result.current.setDraft('private draft'));
  let release!: (value: unknown) => void;
  access.request.mockImplementation(path => path.endsWith('/status') ? Promise.resolve(management) : new Promise(resolve => { release = resolve; }));
  let pending!: Promise<void>; act(() => { pending = result.current.reload(); }); await act(async () => {});
  if (reason === 'lock') access.state = 'locked';
  if (reason === 'generation') access.generation++;
  rerender(reason === 'agent' ? { ...initial, agentId: 'other' } : initial);
  await act(async () => { release(snapshot()); await pending; });
  expect(result.current.draft).toBe(''); expect(result.current.snapshot).toBeNull();
});
it('does not replace newer typing with a late saved receipt', async () => {
  const { result } = await selected(); act(() => result.current.setDraft('submitted'));
  let release!: (value: unknown) => void;
  access.request.mockImplementation(path => path.endsWith('/status') ? Promise.resolve(management) : new Promise(resolve => { release = resolve; }));
  let pending!: Promise<void>; act(() => { pending = result.current.save(); }); await act(async () => {});
  act(() => result.current.setDraft('newer text'));
  await act(async () => { release({ agentId: 'cylena', name: 'AGENTS.md', operationId: 'operation-1', state: 'saved', snapshot: snapshot({ content: 'submitted', bytes: 9 }) }); await pending; });
  expect(result.current.draft).toBe('newer text'); expect(result.current.canSave).toBe(false);
});
it('keeps an undo to the old baseline dirty after a different submitted version is acknowledged', async () => {
  const { result } = await selected(); act(() => result.current.setDraft('submitted'));
  let release!: (value: unknown) => void;
  access.request.mockImplementation(path => path.endsWith('/status') ? Promise.resolve(management) : new Promise(resolve => { release = resolve; }));
  let pending!: Promise<void>; act(() => { pending = result.current.save(); }); await act(async () => {});
  act(() => result.current.setDraft('original'));
  await act(async () => { release({ agentId: 'cylena', name: 'AGENTS.md', operationId: 'operation-1', state: 'saved', snapshot: snapshot({ content: 'submitted', bytes: 9, revision: 'revision-2' }) }); await pending; });
  expect(result.current.draft).toBe('original'); expect(result.current.dirty).toBe(true);
  expect(result.current.snapshot).toMatchObject({ content: 'submitted', revision: 'revision-2' });
  expect(result.current.canSave).toBe(false); expect(result.current.epoch).toBeNull();
  const calls = access.request.mock.calls.length; await act(() => result.current.save()); expect(access.request).toHaveBeenCalledTimes(calls);
});
it('uses the verified saved snapshot for a subsequent explicit edit', async () => {
  const { result } = await selected(); act(() => result.current.setDraft('saved text'));
  await act(() => result.current.save()); act(() => result.current.setDraft('another edit'));
  expect(result.current.snapshot?.revision).toBe('revision-2'); expect(result.current.canSave).toBe(true);
});
it.each(['unknown', 'transport', 'malformed', 'post-ack-status'])('protects an undo to the old baseline during and after an uncertain %s save', async outcome => {
  const { result } = await selected(); act(() => result.current.setDraft('submitted'));
  let release!: (value: unknown) => void; let reject!: (reason: unknown) => void; let statuses = 0;
  access.request.mockImplementation(path => {
    if (path.endsWith('/status')) {
      if (++statuses > 1 && outcome === 'post-ack-status') return Promise.reject(new ControlApiError());
      return Promise.resolve(management);
    }
    return new Promise((resolve, fail) => { release = resolve; reject = fail; });
  });
  let pending!: Promise<void>; act(() => { pending = result.current.save(); }); await act(async () => {});
  act(() => result.current.setDraft('original'));
  expect(result.current.saving).toBe(true); expect(result.current.dirty).toBe(true);
  await act(async () => {
    if (outcome === 'transport') reject(new ControlApiError());
    else release({ agentId: 'cylena', name: 'AGENTS.md', operationId: outcome === 'malformed' ? 'wrong' : 'operation-1',
      state: outcome === 'post-ack-status' ? 'saved' : 'unknown',
      ...(outcome === 'post-ack-status' ? { snapshot: snapshot({ content: 'submitted', bytes: 9 }) } : {}) });
    await pending;
  });
  expect(result.current.draft).toBe('original'); expect(result.current.dirty).toBe(true);
  expect(result.current.saving).toBe(false); expect(result.current.error?.code).toBe('document-outcome-unknown');
  expect(result.current.epoch).toBeNull(); expect(result.current.canSave).toBe(false);
  const calls = access.request.mock.calls.length; await act(() => result.current.save()); expect(access.request).toHaveBeenCalledTimes(calls);
  access.request.mockImplementation(async path => path.endsWith('/status') ? management : snapshot({ content: 'submitted', bytes: 9 }));
  await act(() => result.current.reload()); expect(result.current.dirty).toBe(false); expect(result.current.draft).toBe('submitted');
});
it('bounds a stalled save and marks its outcome unknown without retry', async () => {
  const { result } = await selected(); vi.useFakeTimers(); act(() => result.current.setDraft('changed'));
  access.request.mockImplementation(path => path.endsWith('/status') ? Promise.resolve(management) : new Promise(() => {}));
  let pending!: Promise<void>; act(() => { pending = result.current.save(); }); await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(15000)); await pending;
  expect(result.current.saving).toBe(false); expect(result.current.error?.code).toBe('document-outcome-unknown'); expect(result.current.draft).toBe('changed');
  expect(access.request.mock.calls.filter(([path]) => path.endsWith('/save'))).toHaveLength(1);
});
it('rejects a read whose management epoch changes before its result is published', async () => {
  const { result } = await selected();
  let statuses = 0; access.request.mockImplementation(async path => path.endsWith('/status') ? { ...management, epoch: ++statuses === 1 ? 'epoch-1' : 'epoch-2' } : snapshot({ content: 'new text', bytes: 8 }));
  await act(() => result.current.reload()); expect(result.current.draft).toBe('original'); expect(result.current.canSave).toBe(false); expect(result.current.loading).toBe(false);
});
it('does not overwrite typing made during an outstanding reload', async () => {
  const { result } = await selected(); let release!: (value: unknown) => void;
  access.request.mockImplementation(path => path.endsWith('/status') ? Promise.resolve(management) : new Promise(resolve => { release = resolve; }));
  let pending!: Promise<void>; act(() => { pending = result.current.reload(); }); await act(async () => {});
  act(() => result.current.setDraft('newer private text'));
  await act(async () => { release(snapshot()); await pending; });
  expect(result.current.draft).toBe('newer private text'); expect(result.current.canSave).toBe(false);
});
it('shows source unavailability and an unknown outcome when the connection changes after save dispatch', async () => {
  const { result, rerender } = await selected(); act(() => result.current.setDraft('private draft'));
  let release!: (value: unknown) => void;
  access.request.mockImplementation(path => path.endsWith('/status') ? Promise.resolve(management) : new Promise(resolve => { release = resolve; }));
  let pending!: Promise<void>; act(() => { pending = result.current.save(); }); await act(async () => {});
  access.status.canRead = false; rerender(initial);
  await act(async () => { release({ agentId: 'cylena', name: 'AGENTS.md', operationId: 'operation-1', state: 'saved', snapshot: snapshot({ content: 'private draft', bytes: 13 }) }); await pending; });
  expect(result.current.draft).toBe('private draft'); expect(result.current.management?.canEdit).toBe(false);
  expect(result.current.error?.code).toBe('document-outcome-unknown'); expect(result.current.canSave).toBe(false);
});
it('does not confirm success if the management check fails after the save acknowledgement', async () => {
  const { result } = await selected(); act(() => result.current.setDraft('updated'));
  let statuses = 0;
  access.request.mockImplementation(async path => {
    if (path.endsWith('/status')) { if (++statuses > 1) throw new ControlApiError(); return management; }
    return { agentId: 'cylena', name: 'AGENTS.md', operationId: 'operation-1', state: 'saved', snapshot: snapshot({ content: 'updated', bytes: 7 }) };
  });
  await act(() => result.current.save()); expect(result.current.draft).toBe('updated'); expect(result.current.error?.code).toBe('document-outcome-unknown'); expect(result.current.receipt).toBeNull();
});
