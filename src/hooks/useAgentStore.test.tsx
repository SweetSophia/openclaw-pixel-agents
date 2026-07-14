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

describe('useAgentStore room filtering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    socketMock.handlers.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function renderWithAgents(agents: unknown[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ agents }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    const snapshots: AgentStoreSnapshot[] = [];
    const view = render(<StoreProbe onSnapshot={(snapshot) => snapshots.push(snapshot)} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    return { snapshots, ...view };
  }

  const baseAgent = {
    id: 'agent-1',
    name: 'Test Agent',
    activity: 'typing',
    model: 'test',
    sessionKey: 's1',
    active: true,
    lastActivity: Date.now(),
    pixelEnabled: true,
    tags: [] as string[],
  };

  it('includes agents whose roomId matches the active room', async () => {
    const { snapshots } = await renderWithAgents([
      { ...baseAgent, id: 'a1', roomId: 'office' },
      { ...baseAgent, id: 'a2', roomId: 'lab' },
    ]);

    expect(latest(snapshots).roomAgents.map(a => a.id)).toEqual(['a1']);
  });

  it('derives roomId from tags when roomId is missing (Bug #40)', async () => {
    const { snapshots } = await renderWithAgents([
      { ...baseAgent, id: 'a1', tags: ['research'] },
      { ...baseAgent, id: 'a2', tags: ['coding'] },
    ]);

    // Default room is 'office' (coding tag → office)
    expect(latest(snapshots).roomAgents.map(a => a.id)).toEqual(['a2']);

    // Switch to 'lab' (research tag → lab)
    act(() => { latest(snapshots).setActiveRoomId('lab'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(latest(snapshots).roomAgents.map(a => a.id)).toEqual(['a1']);
  });

  it('keeps agents visible across room switches without disappearing (Bug #40)', async () => {
    const { snapshots } = await renderWithAgents([
      { ...baseAgent, id: 'a1', tags: ['coding'], roomId: 'office' },
      { ...baseAgent, id: 'a2', tags: ['research'], roomId: 'lab' },
    ]);

    // Start in office
    expect(latest(snapshots).roomAgents.map(a => a.id)).toEqual(['a1']);

    // Switch to lab
    act(() => { latest(snapshots).setActiveRoomId('lab'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(latest(snapshots).roomAgents.map(a => a.id)).toEqual(['a2']);

    // Switch back to office
    act(() => { latest(snapshots).setActiveRoomId('office'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(latest(snapshots).roomAgents.map(a => a.id)).toEqual(['a1']);
  });

  it('falls back to office for agents with no tags and no roomId', async () => {
    const { snapshots } = await renderWithAgents([
      { ...baseAgent, id: 'a1', tags: [] },
    ]);

    // Agent with no tags → defaults to office
    expect(latest(snapshots).roomAgents.map(a => a.id)).toEqual(['a1']);

    // Switching to lab should exclude the agent
    act(() => { latest(snapshots).setActiveRoomId('lab'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(latest(snapshots).roomAgents.map(a => a.id)).toEqual([]);
  });

  it('routes by secondary tag (frontend → office)', async () => {
    // 'frontend' is a secondary tag for the 'office' room
    const { snapshots } = await renderWithAgents([
      { ...baseAgent, id: 'a1', tags: ['frontend'] },
    ]);

    expect(latest(snapshots).roomAgents.map(a => a.id)).toEqual(['a1']);

    // 'analysis' is a secondary tag for 'lab'
    act(() => { latest(snapshots).setActiveRoomId('lab'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(latest(snapshots).roomAgents.map(a => a.id)).toEqual([]);
  });

  it('falls back to office for tags not in DEFAULT_ROOMS', async () => {
    const { snapshots } = await renderWithAgents([
      { ...baseAgent, id: 'a1', tags: ['unknown-tag'] as string[] },
    ]);

    // Unknown tag → office
    expect(latest(snapshots).roomAgents.map(a => a.id)).toEqual(['a1']);

    // Switching to lab excludes the agent
    act(() => { latest(snapshots).setActiveRoomId('lab'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(latest(snapshots).roomAgents.map(a => a.id)).toEqual([]);
  });
});
