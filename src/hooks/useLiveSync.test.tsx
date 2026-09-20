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
    },
  };
});

vi.mock('socket.io-client', () => ({ io: vi.fn(() => socketMock.socket) }));

describe('useLiveSync', () => {
  const refreshLayouts = vi.fn();
  const reconcileLayout = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    socketMock.handlers.clear();
    // Issue #218: the shared module-level socket caches across tests
    // within the same file. Reset between tests so each case starts
    // with a fresh singleton. The reset calls `disconnect()` on the
    // previous mock socket — clear that call from the mock so
    // assertions in the current test don't see it.
    resetSharedSocketForTesting();
    socketMock.socket.disconnect.mockClear();
  });

  it('skips the catalog refresh when the broadcast identifies the active layout (issue #218)', () => {
    renderHook(() => useLiveSync({
      activeLayoutId: 'office',
      refreshLayouts,
      reconcileLayout,
    }));

    act(() => socketMock.handlers.get('layout:update')?.({ id: 'office' }));

    // When event.id === activeLayoutId, the active-layout reconcile
    // already pulls the fresh content — the catalog listing would just
    // round-trip back unchanged, so we skip refreshLayouts entirely.
    expect(refreshLayouts).not.toHaveBeenCalled();
    expect(reconcileLayout).toHaveBeenCalledWith({ id: 'office' });
  });

  it('refreshes the catalog AND reloads when the broadcast targets a different layout (issue #218)', () => {
    renderHook(() => useLiveSync({
      activeLayoutId: 'office',
      refreshLayouts,
      reconcileLayout,
    }));

    act(() => socketMock.handlers.get('layout:update')?.({ id: 'other-layout' }));

    // When event.id !== activeLayoutId, the catalog may have changed
    // (new layout added / removed / renamed) so we refresh both.
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
    // Same active-layout path — catalog refresh skipped.
    expect(refreshLayouts).not.toHaveBeenCalled();
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
