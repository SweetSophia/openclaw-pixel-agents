import { io as socketIO, Socket } from 'socket.io-client';

/**
 * Module-level socket singleton.
 *
 * The dashboard previously opened a fresh `socket.io-client`
 * connection in three independent places — `useAgentStore`,
 * `useLiveSync`, and `MessageTicker`. Each browser ended up with
 * three WebSocket connections to the same `/api` namespace, which
 * tripled reconnect-storm exposure and inflated the server-side
 * connection count. Issue #218.
 *
 * The fix is a lazy singleton: the first consumer creates the
 * connection, every subsequent consumer reuses it. Consumers
 * subscribe via `socket.on(event, handler)` in their `useEffect`s
 * and unsubscribe via `socket.off(event, handler)` on unmount — they
 * must NOT call `socket.disconnect()` since the lifecycle is shared.
 *
 * The browser's page-unload handlers handle teardown for production.
 * Tests should call `resetSharedSocketForTesting()` between cases to
 * drop the mock socket and force a fresh `socketIO(...)` on next
 * `getSharedSocket()`.
 */
let sharedSocket: Socket | null = null;

export function getSharedSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = socketIO({ transports: ['websocket', 'polling'] });
  }
  return sharedSocket;
}

export function resetSharedSocketForTesting(): void {
  if (sharedSocket) {
    sharedSocket.disconnect();
  }
  sharedSocket = null;
}
