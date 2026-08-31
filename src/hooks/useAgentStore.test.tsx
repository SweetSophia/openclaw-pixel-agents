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

async function emitSocketEvent(event: 'connect' | 'disconnect' | 'agents:update', ...args: unknown[]) {
  await act(async () => {
    socketMock.handlers.get(event)?.(...args);
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

    expect(fetch).toHaveBeenCalledTimes(1);
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
    expect(latest(snapshots).connected).toBe(false);

    await emitSocketEvent('agents:update', []);
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
    await emitSocketEvent('agents:update', []);
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

  it('does not let an in-flight REST response overwrite a newer socket snapshot', async () => {
    const restResolvers: Array<(response: Response) => void> = [];
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>((resolve) => {
      restResolvers.push(resolve);
    }));

    const { snapshots, unmount } = await renderStoreProbe();
    expect(restResolvers.length).toBeGreaterThan(0);

    const socketAgent = {
      id: 'agent-1',
      name: 'Fresh socket state',
      activity: 'typing' as const,
      model: 'test',
      sessionKey: 'socket',
      active: true,
      lastActivity: 2,
      pixelEnabled: false,
      tags: [],
    };
    await emitSocketEvent('agents:update', [socketAgent]);

    await act(async () => {
      for (const resolve of restResolvers) {
        resolve(new Response(JSON.stringify({
          agents: [{ ...socketAgent, name: 'Stale REST state', lastActivity: 1, pixelEnabled: true }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(latest(snapshots).agents).toEqual([socketAgent]);
    expect(latest(snapshots).connected).toBe(true);

    unmount();
  });
});

describe('useAgentStore mutation failures', () => {
  const agent = {
    id: 'agent-1',
    name: 'Test Agent',
    activity: 'typing' as const,
    model: 'test',
    sessionKey: 's1',
    active: true,
    lastActivity: 1,
    pixelEnabled: true,
    tags: [],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    socketMock.handlers.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rolls back an optimistic toggle and exposes an HTTP 500 error', async () => {
    let resolveToggle: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveToggle = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ agents: [agent] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { snapshots, unmount } = await renderStoreProbe();
    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(true);

    let mutation: Promise<void> | undefined;
    act(() => {
      mutation = latest(snapshots).toggleAgent(agent.id, false);
    });
    await flushMicrotasks();
    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(false);

    await act(async () => {
      resolveToggle?.(new Response(JSON.stringify({ error: 'Toggle failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await mutation;
    });

    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(true);
    expect(latest(snapshots).error).toBe('Toggle failed');

    await act(async () => {
      await latest(snapshots).toggleAll(true);
    });
    expect(latest(snapshots).error).toBe('Toggle failed');

    unmount();
  });

  it('does not let an older failed toggle roll back a newer optimistic toggle', async () => {
    const toggleResolvers: Array<(response: Response) => void> = [];
    const reconciledAgent = { ...agent, pixelEnabled: false };
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => toggleResolvers.push(resolve));
      }
      getCount += 1;
      return Promise.resolve(new Response(JSON.stringify({
        agents: getCount === 1 ? [agent] : [reconciledAgent],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { snapshots, unmount } = await renderStoreProbe();
    let older: Promise<void> | undefined;
    let newer: Promise<void> | undefined;
    const storeBeforeRerender = latest(snapshots);

    act(() => {
      older = storeBeforeRerender.toggleAgent(agent.id, false);
      newer = storeBeforeRerender.toggleAgent(agent.id, false);
    });
    await flushMicrotasks();

    await act(async () => {
      toggleResolvers[1]?.(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await newer;
      toggleResolvers[0]?.(new Response(JSON.stringify({ error: 'Older toggle failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await older;
    });

    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(false);
    expect(latest(snapshots).error).toBeNull();

    unmount();
  });

  it('does not let an in-flight REST poll overwrite an optimistic toggle', async () => {
    let resolvePoll: ((response: Response) => void) | undefined;
    let resolveToggle: ((response: Response) => void) | undefined;
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveToggle = resolve;
        });
      }
      getCount += 1;
      if (getCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({ agents: [agent] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return new Promise<Response>((resolve) => {
        resolvePoll = resolve;
      });
    }));

    const { snapshots, unmount } = await renderStoreProbe();
    let poll: Promise<void> | undefined;
    let mutation: Promise<void> | undefined;

    act(() => {
      poll = latest(snapshots).refresh();
    });
    await flushMicrotasks();
    act(() => {
      mutation = latest(snapshots).toggleAgent(agent.id, false);
    });
    await flushMicrotasks();
    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(false);

    await act(async () => {
      resolvePoll?.(new Response(JSON.stringify({ agents: [agent] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await poll;
    });
    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(false);

    await act(async () => {
      resolveToggle?.(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await mutation;
    });

    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(false);
    expect(latest(snapshots).error).toBeNull();

    unmount();
  });

  it('does not expose a stale failing REST poll that races with an optimistic toggle', async () => {
    let resolvePoll: ((response: Response) => void) | undefined;
    let resolveToggle: ((response: Response) => void) | undefined;
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveToggle = resolve;
        });
      }
      getCount += 1;
      if (getCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({ agents: [agent] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return new Promise<Response>((resolve) => {
        resolvePoll = resolve;
      });
    }));

    const { snapshots, unmount } = await renderStoreProbe();
    let poll: Promise<void> | undefined;
    let mutation: Promise<void> | undefined;

    act(() => {
      poll = latest(snapshots).refresh();
    });
    await flushMicrotasks();
    act(() => {
      mutation = latest(snapshots).toggleAgent(agent.id, false);
    });
    await flushMicrotasks();

    await act(async () => {
      resolvePoll?.(new Response(JSON.stringify({ error: 'Stale REST failure' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await poll;
    });
    expect(latest(snapshots).error).toBeNull();

    await act(async () => {
      resolveToggle?.(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await mutation;
    });

    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(false);
    expect(latest(snapshots).error).toBeNull();

    unmount();
  });

  it('reconciles after two superseding single-agent toggles fail', async () => {
    const toggleResolvers: Array<(response: Response) => void> = [];
    const serverAgent = { ...agent, name: 'Server fixture', pixelEnabled: true };
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => toggleResolvers.push(resolve));
      }
      getCount += 1;
      return Promise.resolve(new Response(JSON.stringify({
        agents: getCount === 1 ? [agent] : [serverAgent],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { snapshots, unmount } = await renderStoreProbe();
    const storeBeforeRerender = latest(snapshots);
    let older: Promise<void> | undefined;
    let newer: Promise<void> | undefined;

    act(() => {
      older = storeBeforeRerender.toggleAgent(agent.id, false);
      newer = storeBeforeRerender.toggleAgent(agent.id, true);
    });
    await flushMicrotasks();

    await act(async () => {
      toggleResolvers[1]?.(new Response(JSON.stringify({ error: 'Newer toggle failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await newer;
    });
    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(false);

    await act(async () => {
      toggleResolvers[0]?.(new Response(JSON.stringify({ error: 'Older toggle failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await older;
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(latest(snapshots).agents[0]?.name).toBe('Server fixture');
    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(true);
    expect(latest(snapshots).error).toBeNull();

    unmount();
  });

  it('preserves a socket snapshot when an optimistic toggle later fails', async () => {
    let resolveToggle: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveToggle = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ agents: [agent] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { snapshots, unmount } = await renderStoreProbe();
    let mutation: Promise<void> | undefined;

    act(() => {
      mutation = latest(snapshots).toggleAgent(agent.id, false);
    });
    await flushMicrotasks();

    const socketAgent = { ...agent, name: 'Socket fixture', pixelEnabled: false };
    await emitSocketEvent('agents:update', [socketAgent]);

    await act(async () => {
      resolveToggle?.(new Response(JSON.stringify({ error: 'Toggle failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await mutation;
    });

    expect(latest(snapshots).agents[0]?.name).toBe('Socket fixture');
    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(false);
    expect(latest(snapshots).error).toBe('Toggle failed');

    unmount();
  });

  it('keeps successful toggle-all changes while rolling back only failed agents', async () => {
    const agents = [agent, { ...agent, id: 'agent-2', name: 'Second Agent' }];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const failed = String(input).includes('/agent-2/');
        return Promise.resolve(new Response(
          failed ? JSON.stringify({ error: 'Second toggle failed' }) : JSON.stringify({ success: true }),
          {
            status: failed ? 500 : 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ));
      }
      return Promise.resolve(new Response(JSON.stringify({ agents }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { snapshots, unmount } = await renderStoreProbe();

    await act(async () => {
      await latest(snapshots).toggleAll(false);
    });

    expect(latest(snapshots).agents.map(current => [current.id, current.pixelEnabled])).toEqual([
      ['agent-1', false],
      ['agent-2', true],
    ]);
    expect(latest(snapshots).error).toBe('Failed to toggle 1 agent: agent-2 (Second toggle failed)');

    unmount();
  });

  it('reports every failed agent from a bulk toggle', async () => {
    const agents = [agent, { ...agent, id: 'agent-2', name: 'Second Agent' }];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const id = String(input).includes('/agent-2/') ? 'agent-2' : 'agent-1';
        return Promise.resolve(new Response(JSON.stringify({ error: `${id} rejected` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({ agents }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { snapshots, unmount } = await renderStoreProbe();

    await act(async () => {
      await latest(snapshots).toggleAll(false);
    });

    expect(latest(snapshots).error).toBe(
      'Failed to toggle 2 agents: agent-1 (agent-1 rejected), agent-2 (agent-2 rejected)',
    );

    unmount();
  });

  it('reconciles after a superseded bulk failure and a newer failure both roll back', async () => {
    const postResolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => postResolvers.push(resolve));
      }
      return Promise.resolve(new Response(JSON.stringify({ agents: [agent] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { snapshots, unmount } = await renderStoreProbe();
    const storeBeforeRerender = latest(snapshots);
    let bulk: Promise<void> | undefined;
    let newer: Promise<void> | undefined;

    act(() => {
      bulk = storeBeforeRerender.toggleAll(false);
      newer = storeBeforeRerender.toggleAgent(agent.id, true);
    });
    await flushMicrotasks();

    await act(async () => {
      postResolvers[1]?.(new Response(JSON.stringify({ error: 'Newer toggle failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await newer;
    });
    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(false);

    await act(async () => {
      postResolvers[0]?.(new Response(JSON.stringify({ error: 'Bulk toggle failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await bulk;
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(latest(snapshots).agents[0]?.pixelEnabled).toBe(true);

    unmount();
  });

  it('rolls back an optimistic sprite change and exposes an HTTP 500 error', async () => {
    let resolveSprite: ((response: Response) => void) | undefined;
    const agentWithSprite = { ...agent, characterSpriteId: 'char_1' };
    vi.stubGlobal('fetch', vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveSprite = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ agents: [agentWithSprite] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { snapshots, unmount } = await renderStoreProbe();

    let mutation: Promise<void> | undefined;
    act(() => {
      mutation = latest(snapshots).setCharacterSprite(agent.id, 'char_2');
    });
    await flushMicrotasks();
    expect(latest(snapshots).agents[0]?.characterSpriteId).toBe('char_2');

    await act(async () => {
      resolveSprite?.(new Response(JSON.stringify({ error: 'Sprite failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await mutation;
    });

    expect(latest(snapshots).agents[0]?.characterSpriteId).toBe('char_1');
    expect(latest(snapshots).error).toBe('Sprite failed');

    unmount();
  });

  it('restores an unset sprite field when an optimistic sprite request fails', async () => {
    let resolveSprite: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveSprite = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ agents: [agent] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { snapshots, unmount } = await renderStoreProbe();
    let mutation: Promise<void> | undefined;

    act(() => {
      mutation = latest(snapshots).setCharacterSprite(agent.id, 'char_2');
    });
    await flushMicrotasks();
    expect(latest(snapshots).agents[0]?.characterSpriteId).toBe('char_2');

    await act(async () => {
      resolveSprite?.(new Response(JSON.stringify({ error: 'Sprite failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await mutation;
    });

    expect(latest(snapshots).agents[0]?.characterSpriteId).toBeUndefined();

    unmount();
  });

  it('does not let an older failed sprite request replace a newer optimistic sprite', async () => {
    const spriteResolvers: Array<(response: Response) => void> = [];
    const agentWithSprite = { ...agent, characterSpriteId: 'char_1' };
    const reconciledAgent = { ...agent, characterSpriteId: 'char_3' };
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => spriteResolvers.push(resolve));
      }
      getCount += 1;
      return Promise.resolve(new Response(JSON.stringify({
        agents: getCount === 1 ? [agentWithSprite] : [reconciledAgent],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { snapshots, unmount } = await renderStoreProbe();
    let older: Promise<void> | undefined;
    let newer: Promise<void> | undefined;
    const storeBeforeRerender = latest(snapshots);

    act(() => {
      older = storeBeforeRerender.setCharacterSprite(agent.id, 'char_2');
      newer = storeBeforeRerender.setCharacterSprite(agent.id, 'char_3');
    });
    await flushMicrotasks();

    await act(async () => {
      spriteResolvers[1]?.(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await newer;
      spriteResolvers[0]?.(new Response(JSON.stringify({ error: 'Older sprite failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await older;
    });

    expect(latest(snapshots).agents[0]?.characterSpriteId).toBe('char_3');

    unmount();
  });

  it('reconciles after two superseding sprite changes fail', async () => {
    const spriteResolvers: Array<(response: Response) => void> = [];
    const initialAgent = { ...agent, characterSpriteId: 'char_1' };
    const serverAgent = { ...agent, name: 'Server fixture', characterSpriteId: 'char_4' };
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => spriteResolvers.push(resolve));
      }
      getCount += 1;
      return Promise.resolve(new Response(JSON.stringify({
        agents: getCount === 1 ? [initialAgent] : [serverAgent],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { snapshots, unmount } = await renderStoreProbe();
    const storeBeforeRerender = latest(snapshots);
    let older: Promise<void> | undefined;
    let newer: Promise<void> | undefined;

    act(() => {
      older = storeBeforeRerender.setCharacterSprite(agent.id, 'char_2');
      newer = storeBeforeRerender.setCharacterSprite(agent.id, 'char_3');
    });
    await flushMicrotasks();

    await act(async () => {
      spriteResolvers[1]?.(new Response(JSON.stringify({ error: 'Newer sprite failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await newer;
    });
    expect(latest(snapshots).agents[0]?.characterSpriteId).toBe('char_2');

    await act(async () => {
      spriteResolvers[0]?.(new Response(JSON.stringify({ error: 'Older sprite failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
      await older;
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(latest(snapshots).agents[0]?.name).toBe('Server fixture');
    expect(latest(snapshots).agents[0]?.characterSpriteId).toBe('char_4');
    expect(latest(snapshots).error).toBeNull();

    unmount();
  });
});

describe('useAgentStore mutation rate limits', () => {
  const baseAgent = {
    id: 'agent-1',
    name: 'First Agent',
    activity: 'typing' as const,
    model: 'test',
    sessionKey: 's1',
    active: true,
    lastActivity: 1,
    pixelEnabled: true,
    tags: [],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    socketMock.handlers.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconciles toggle-all with server state after a partial 429 failure', async () => {
    let serverAgents = [
      baseAgent,
      { ...baseAgent, id: 'agent-2', name: 'Second Agent' },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (String(input).includes('/agent-1/')) {
          serverAgents = serverAgents.map(agent => (
            agent.id === 'agent-1' ? { ...agent, pixelEnabled: false } : agent
          ));
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: 'Too many requests' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        });
      }
      return new Response(JSON.stringify({ agents: serverAgents }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { snapshots, unmount } = await renderStoreProbe();
    expect(latest(snapshots).agents.map(agent => agent.pixelEnabled)).toEqual([true, true]);

    await act(async () => {
      await latest(snapshots).toggleAll(false);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(latest(snapshots).agents.map(agent => [agent.id, agent.pixelEnabled])).toEqual([
      ['agent-1', false],
      ['agent-2', true],
    ]);

    unmount();
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
