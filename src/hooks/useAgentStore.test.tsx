import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
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
const POLL_INTERVAL_MS = 2000;

function StoreProbe({ onSnapshot }: { onSnapshot: (snapshot: AgentStoreSnapshot) => void }) {
  const store = useAgentStore();

  useEffect(() => {
    onSnapshot(store);
  }, [onSnapshot, store]);

  return null;
}

function latest<T>(items: T[]): T {
  const item = items[items.length - 1];
  if (!item) throw new Error('Expected at least one item');
  return item;
}

async function flushMicrotasks() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function emitSocketEvent(event: 'connect' | 'disconnect') {
  await act(async () => {
    socketMock.handlers.get(event)?.();
  });
  await flushMicrotasks();
}

async function renderStoreProbe() {
  const snapshots: AgentStoreSnapshot[] = [];
  const view = render(<StoreProbe onSnapshot={(snapshot) => snapshots.push(snapshot)} />);
  await flushMicrotasks();

  return { snapshots, ...view };
}

describe('useAgentStore REST polling fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    socketMock.handlers.clear();

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

  it('keeps connected=false when REST fallback succeeds while WebSocket is disconnected', async () => {
    const { snapshots, unmount } = await renderStoreProbe();

    expect(fetch).toHaveBeenCalled();
    expect(latest(snapshots).connected).toBe(false);

    unmount();
  });

  it('continues polling while WebSocket is disconnected', async () => {
    const { unmount } = await renderStoreProbe();

    const callsAfterInitialFetches = vi.mocked(fetch).mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    expect(fetch).toHaveBeenCalledTimes(callsAfterInitialFetches + 1);

    unmount();
  });

  it('stops polling once the WebSocket reconnects', async () => {
    const { snapshots, unmount } = await renderStoreProbe();

    await emitSocketEvent('connect');

    expect(latest(snapshots).connected).toBe(true);

    const callsAfterReconnect = vi.mocked(fetch).mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    });

    expect(fetch).toHaveBeenCalledTimes(callsAfterReconnect);

    unmount();
  });

  it('resumes polling after the WebSocket disconnects again', async () => {
    const { snapshots, unmount } = await renderStoreProbe();

    await emitSocketEvent('connect');
    expect(latest(snapshots).connected).toBe(true);

    const callsBeforeDisconnect = vi.mocked(fetch).mock.calls.length;

    await emitSocketEvent('disconnect');

    expect(latest(snapshots).connected).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(callsBeforeDisconnect + 1);

    unmount();
  });

  it('disconnects the socket on unmount', async () => {
    const { unmount } = await renderStoreProbe();

    unmount();
    expect(socketMock.socket.disconnect).toHaveBeenCalledTimes(1);
  });
});
