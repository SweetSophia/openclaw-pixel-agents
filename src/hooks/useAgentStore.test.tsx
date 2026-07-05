import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from './useAgentStore';

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return socket;
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (handlers.get(event) === handler) handlers.delete(event);
      return socket;
    }),
    disconnect: vi.fn(),
  };

  return {
    handlers,
    io: vi.fn(() => socket),
    socket,
  };
});

vi.mock('socket.io-client', () => ({
  io: socketMock.io,
}));

type AgentStoreSnapshot = ReturnType<typeof useAgentStore>;

function StoreProbe({ onSnapshot }: { onSnapshot: (snapshot: AgentStoreSnapshot) => void }) {
  const store = useAgentStore();
  onSnapshot(store);
  return null;
}

function latest<T>(items: T[]): T {
  const item = items.at(-1);
  if (!item) throw new Error('Expected at least one item');
  return item;
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useAgentStore REST polling fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    socketMock.handlers.clear();
    socketMock.io.mockClear();
    socketMock.socket.on.mockClear();
    socketMock.socket.off.mockClear();
    socketMock.socket.disconnect.mockClear();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('continues polling while WebSocket is disconnected even when REST succeeds', async () => {
    const snapshots: AgentStoreSnapshot[] = [];
    const { unmount } = render(<StoreProbe onSnapshot={(snapshot) => snapshots.push(snapshot)} />);

    expect(fetch).toHaveBeenCalled();
    await flushMicrotasks();
    expect(latest(snapshots).connected).toBe(false);

    const callsAfterInitialFetches = vi.mocked(fetch).mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(fetch).toHaveBeenCalledTimes(callsAfterInitialFetches + 1);
    expect(latest(snapshots).connected).toBe(false);

    await act(async () => {
      socketMock.handlers.get('connect')?.();
    });

    expect(latest(snapshots).connected).toBe(true);

    const callsAfterReconnect = vi.mocked(fetch).mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(fetch).toHaveBeenCalledTimes(callsAfterReconnect);

    unmount();
    expect(socketMock.socket.disconnect).toHaveBeenCalledTimes(1);
  });
});
