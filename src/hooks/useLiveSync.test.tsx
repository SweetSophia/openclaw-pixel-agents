import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveSync } from './useLiveSync';
import { resetSharedSocketForTesting } from '../socket';

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    handlers,
    socket: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn(),
      disconnect: vi.fn(),
      connected: false,
    },
  };
});

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    // Issue #218: each `io()` call would normally create a fresh
    // socket; for the singleton pattern, we reuse the same mock
    // across calls and let the test reset `socket.connected` as
    // needed.
    return socketMock.socket;
  }),
}));

describe('useLiveSync', () => {
  const refreshLayouts = vi.fn();
  const reconcileLayout = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    socketMock.handlers.clear();
    socketMock.socket.connected = false;
    // Issue #218: the shared module-level socket caches across tests
    // within the same file. Reset between tests so each case starts
    // with a fresh singleton. The reset calls `disconnect()` on the
    // previous mock socket — clear that call from the mock so
    // assertions in the current test don't see it.
    resetSharedSocketForTesting();
    socketMock.socket.disconnect.mockClear();
  });

  it('always refreshes the catalog AND reconciles when the broadcast identifies the active layout (issue #218 review)', () => {
    renderHook(() => useLiveSync({
      activeLayoutId: 'office',
      refreshLayouts,
      reconcileLayout,
    }));

    act(() => socketMock.handlers.get('layout:update')?.({ id: 'office' }));

    // The catalog-visible fields (name, etc.) may change on any PUT
    // even when the active layout is the affected one — e.g. a
    // rename. The active-layout reconcile updates only `activeLayout`,
    // not the catalog listing. Both refresh paths must fire so the
    // layout picker reflects the new name immediately.
    expect(refreshLayouts).toHaveBeenCalledOnce();
    expect(reconcileLayout).toHaveBeenCalledWith({ id: 'office' });
  });

  it('refreshes the catalog AND reconciles when the broadcast targets a different layout', () => {
    renderHook(() => useLiveSync({
      activeLayoutId: 'office',
      refreshLayouts,
      reconcileLayout,
    }));

    act(() => socketMock.handlers.get('layout:update')?.({ id: 'other-layout' }));

    expect(refreshLayouts).toHaveBeenCalledOnce();
    expect(reconcileLayout).toHaveBeenCalledWith({ id: 'other-layout' });
  });

  it('loads the default layout when a deleted layout was the active one', () => {
    renderHook(() => useLiveSync({
      activeLayoutId: 'custom',
      refreshLayouts,
      reconcileLayout,
    }));

    act(() => socketMock.handlers.get('layout:update')?.({ id: 'custom', deleted: true }));
    expect(refreshLayouts).toHaveBeenCalledOnce();
    expect(reconcileLayout).toHaveBeenCalledWith({ id: 'custom' });
  });

  it('refreshes agents, layouts, and the active layout after reconnect', () => {
    renderHook(() => useLiveSync({
      activeLayoutId: 'office',
      refreshLayouts,
      reconcileLayout,
    }));

    act(() => socketMock.handlers.get('connect')?.());
    expect(refreshLayouts).toHaveBeenCalledOnce();
    expect(reconcileLayout).toHaveBeenCalledWith({ id: 'office' });
  });

  it('runs the connect handler immediately when the shared socket is already connected on mount (issue #218)', () => {
    // Late-mount case: another consumer (e.g. useAgentStore) opened
    // the shared socket first. When this hook mounts, the socket is
    // already connected — there will be no `connect` event for us.
    // Without the immediate-run guard, we'd never run the refresh/
    // reconcile path that normally fires on first connect.
    socketMock.socket.connected = true;
    renderHook(() => useLiveSync({
      activeLayoutId: 'office',
      refreshLayouts,
      reconcileLayout,
    }));

    // Connect handler should have run synchronously inside the effect.
    expect(refreshLayouts).toHaveBeenCalledOnce();
    expect(reconcileLayout).toHaveBeenCalledWith({ id: 'office' });
  });

  it('rejects invalid event IDs and unregisters listeners on unmount without disconnecting the shared socket (issue #218)', () => {
    const { unmount } = renderHook(() => useLiveSync({
      activeLayoutId: 'office',
      refreshLayouts,
      reconcileLayout,
    }));

    act(() => socketMock.handlers.get('layout:update')?.({ id: '../escape' }));
    expect(refreshLayouts).not.toHaveBeenCalled();
    unmount();
    expect(socketMock.socket.off).toHaveBeenCalledWith(
      'connect',
      expect.any(Function),
    );
    expect(socketMock.socket.off).toHaveBeenCalledWith(
      'layout:update',
      expect.any(Function),
    );
    // The shared socket must NOT be disconnected on per-hook unmount.
    // It's torn down only on page unload.
    expect(socketMock.socket.disconnect).not.toHaveBeenCalled();
  });
});
