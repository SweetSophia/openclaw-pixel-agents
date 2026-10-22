import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentState } from '../shared/types';
import { getCachedAgentsUpdate, getSharedSocket, resetSharedSocketForTesting } from './socket';

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket = {
    connected: false,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
      return socket;
    }),
    disconnect: vi.fn(),
  };
  return { handlers, socket, io: vi.fn(() => socket) };
});

vi.mock('socket.io-client', () => ({ io: socketMock.io }));

function emit(event: string, ...args: unknown[]) {
  for (const handler of socketMock.handlers.get(event) ?? []) handler(...args);
}

describe('shared socket agent snapshots', () => {
  beforeEach(() => {
    resetSharedSocketForTesting();
    socketMock.handlers.clear();
    socketMock.socket.connected = false;
  });

  afterEach(() => resetSharedSocketForTesting());

  it('reuses a single connection and caches an empty authoritative snapshot', () => {
    const first = getSharedSocket();
    expect(getSharedSocket()).toBe(first);
    expect(socketMock.io).toHaveBeenCalledTimes(1);
    emit('agents:update', []);
    expect(getCachedAgentsUpdate()).toEqual([]);
  });

  it('invalidates the previous connection snapshot when the socket disconnects', () => {
    getSharedSocket();
    const agents: AgentState[] = [];
    emit('agents:update', agents);
    expect(getCachedAgentsUpdate()).toBe(agents);

    emit('disconnect');

    expect(getCachedAgentsUpdate()).toBeNull();
  });

  it('requires a new snapshot after a new connection opens', () => {
    getSharedSocket();
    emit('agents:update', []);

    emit('connect');

    expect(getCachedAgentsUpdate()).toBeNull();
    emit('agents:update', []);
    expect(getCachedAgentsUpdate()).toEqual([]);
  });
});
