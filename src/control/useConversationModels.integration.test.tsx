import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ControlAccessProvider, useControlAccess } from './ControlAccess';
import { useConversationModels } from './useConversationModels';
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:main', sessionId: 'session-1' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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
