import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveSync } from './useLiveSync';

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
  });

  it('refreshes and reloads a clean active layout update', () => {
    renderHook(() => useLiveSync({
      activeLayoutId: 'office',
      refreshLayouts,
      reconcileLayout,
    }));

    act(() => socketMock.handlers.get('layout:update')?.({ id: 'office' }));
    expect(refreshLayouts).toHaveBeenCalledOnce();
    expect(reconcileLayout).toHaveBeenCalledWith({ id: 'office' });
  });

  it('loads the default layout when the clean active layout is deleted', () => {
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

  it('rejects invalid event IDs and unregisters listeners on unmount', () => {
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
    expect(socketMock.socket.disconnect).toHaveBeenCalledOnce();
  });
});
