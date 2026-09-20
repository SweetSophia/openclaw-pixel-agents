import { io as socketIO, Socket } from 'socket.io-client';
import type { AgentState, TickerMessage } from '../shared/types';

/**
 * Module-level socket singleton (issue #218).
 *
 * The dashboard previously opened a fresh `socket.io-client`
 * connection in three independent places — `useAgentStore`,
 * `useLiveSync`, and `MessageTicker`. Each browser ended up with
 * three WebSocket connections to the same `/api` namespace, which
 * tripled reconnect-storm exposure and inflated the server-side
 * connection count. The fix is a lazy singleton: the first consumer
 * creates the connection, every subsequent consumer reuses it.
 * Consumers subscribe via `socket.on(event, handler)` in their
 * `useEffect`s and unsubscribe via `socket.off(event, handler)` on
 * unmount — they must NOT call `socket.disconnect()` since the
 * lifecycle is shared.
 *
 * The browser's page-unload handlers handle teardown for production.
 * Tests should call `resetSharedSocketForTesting()` between cases to
 * drop the mock socket, force a fresh `socketIO(...)` on next
 * `getSharedSocket()`, and reset the cached-snapshot buffers below.
 *
 * ## Cached snapshots for late consumers
 *
 * The server emits `agents:update` and `ticker:messages` only in
 * its connection callback (server/index.ts). A consumer that mounts
 * after another consumer has already connected the singleton does
 * not receive the initial snapshot — the listener is registered
 * too late. To bridge this gap, the singleton keeps a copy of the
 * most recent `agents:update` and `ticker:messages` payload and
 * exposes it via `getCachedAgentsUpdate()` / `getCachedTickerMessages()`.
 * Late consumers can poll the cache on mount and apply the cached
 * payload synchronously. This trades a single extra in-memory copy
 * (bounded by the AgentState[] / TickerMessage[] size) for the
 * guarantee that any mounted consumer sees a recent snapshot
 * regardless of which consumer connected first.
 */
let sharedSocket: Socket | null = null;
let cachedAgentsUpdate: AgentState[] | null = null;
let cachedTickerMessages: TickerMessage[] | null = null;

export function getSharedSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = socketIO({ transports: ['websocket', 'polling'] });
    sharedSocket.on('agents:update', (agents: AgentState[]) => {
      cachedAgentsUpdate = agents;
    });
    sharedSocket.on('ticker:messages', (messages: TickerMessage[]) => {
      cachedTickerMessages = messages;
    });
  }
  return sharedSocket;
}

/**
 * Returns the most recent `agents:update` payload observed by the
 * shared socket, or `null` if none has been received yet. Late
 * consumers should call this on mount to seed their state.
 */
export function getCachedAgentsUpdate(): AgentState[] | null {
  return cachedAgentsUpdate;
}

/**
 * Returns the most recent `ticker:messages` payload observed by the
 * shared socket, or `null` if none has been received yet. Late
 * consumers should call this on mount to seed their state.
 */
export function getCachedTickerMessages(): TickerMessage[] | null {
  return cachedTickerMessages;
}

export function resetSharedSocketForTesting(): void {
  if (sharedSocket) {
    sharedSocket.disconnect();
  }
  sharedSocket = null;
  cachedAgentsUpdate = null;
  cachedTickerMessages = null;
}
