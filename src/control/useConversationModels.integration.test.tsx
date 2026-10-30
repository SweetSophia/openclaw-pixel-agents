import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ControlAccessProvider, useControlAccess } from './ControlAccess';
import { useConversationModels } from './useConversationModels';
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:main', sessionId: 'session-1' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('keeps method-local 403 isolated while real provider credentials stay tab-local and lock clears model views', async () => {
  const calls: { path: string; init: RequestInit }[] = []; let denied = false;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    if (path.endsWith('/status')) return Response.json({ configured: true, state: 'ready', canRead: true, canSend: true });
    if (denied) return Response.json({ code: 'model-denied' }, { status: 403 });
    return Response.json({ target, selectionId: 'observation-1', observedAt: Date.now(), currentModel: 'p/old', choices: [], canChange: true, disabledReason: null });
  }));
  const { result } = renderHook(() => ({ access: useControlAccess(), models: useConversationModels(target, true) }), { wrapper: ({ children }) => <ControlAccessProvider>{children}</ControlAccessProvider> });
  await act(() => result.current.access.unlock('synthetic-model-key')); await waitFor(() => expect(result.current.models.snapshot?.currentModel).toBe('p/old'));
  denied = true; await act(() => result.current.models.refresh()); expect(result.current.access.state).toBe('unlocked'); expect(result.current.models.error).toMatchObject({ code: 'model-denied' }); expect(result.current.models.snapshot).toBeNull();
  expect(calls.every(({ init }) => init.cache === 'no-store' && init.credentials === 'same-origin')).toBe(true);
  expect(new Headers(calls[calls.length - 1].init.headers).get('Authorization')).toBe('Bearer synthetic-model-key');
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  act(() => result.current.access.lock()); expect(result.current.models.snapshot).toBeNull();
});
it('bounds a stalled HTTP response body without aborting its admitted request or adopting its late receipt', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let body!: ReadableStreamDefaultController<Uint8Array>; let mutationSignal: AbortSignal | undefined;
  let observation = 'body-observation';
  const snapshot = () => ({ target, selectionId: observation, observedAt: Date.now(), currentModel: 'p/old', choices: [], canChange: true, disabledReason: null });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith('/status')) return Response.json({ configured: true, state: 'ready', canRead: true, canSend: true });
    if (path.endsWith('/model')) {
      mutationSignal = init.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }));
    }
    return Response.json(snapshot());
  }));
  const { result } = renderHook(() => ({ access: useControlAccess(), models: useConversationModels(target, true) }), { wrapper: ({ children }) => <ControlAccessProvider>{children}</ControlAccessProvider> });
  await act(() => result.current.access.unlock('synthetic-body-key'));
  await act(async () => {}); expect(result.current.models.snapshot?.currentModel).toBe('p/old');
  act(() => { result.current.models.choose(null); result.current.models.prepare(); }); act(() => { void result.current.models.confirm(); });
  await act(() => vi.advanceTimersByTimeAsync(30000)); expect(result.current.models.pending).toBe(false); expect(result.current.models.uncertain).toBe(true); expect(result.current.models.error).toMatchObject({ code: 'timed-out' }); expect(mutationSignal?.aborted).toBe(false);
  observation = 'body-fresh'; await act(() => result.current.models.refresh()); expect(result.current.models.uncertain).toBe(false);
  await act(async () => { body.enqueue(new TextEncoder().encode(JSON.stringify({ target, outcome: 'confirmed', snapshot: { ...snapshot(), currentModel: 'p/late' } }))); body.close(); });
  expect(result.current.models.snapshot?.currentModel).toBe('p/old'); expect(result.current.models.uncertain).toBe(false); expect(mutationSignal?.aborted).toBe(false);
});
