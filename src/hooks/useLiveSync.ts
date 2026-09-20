import { useEffect, useRef } from 'react';
import { getSharedSocket } from '../socket';
import type { RemoteLayoutEvent } from './useLayoutStore';

type Refresh = () => void | Promise<unknown>;

interface LiveSyncOptions {
  activeLayoutId: string | null;
  refreshLayouts: Refresh;
  reconcileLayout: (event: RemoteLayoutEvent) => void | Promise<unknown>;
}

interface LayoutUpdateEvent {
  id: string;
  deleted?: boolean;
}

function isLayoutUpdateEvent(value: unknown): value is LayoutUpdateEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === 'string'
    && /^[a-zA-Z0-9_-]+$/.test(event.id)
    && event.id.length <= 64
    && (event.deleted === undefined || typeof event.deleted === 'boolean');
}

function runRefresh(callback: Refresh, label: string): void {
  Promise.resolve(callback()).catch(error => {
    console.error(`Failed to apply ${label} live update:`, error);
  });
}

/**
 * Consume layout broadcasts as invalidation signals. The event payload is
 * intentionally not authoritative; the store resolves the current REST
 * document (or its absence) before changing active-layout state.
 *
 * Uses the shared module-level socket (`src/socket.ts`) so the dashboard
 * maintains a single WebSocket connection rather than three — issue #218.
 * The `socket.disconnect()` call is intentionally omitted from the cleanup:
 * the socket is shared across consumers and torn down at page unload.
 */
export function useLiveSync(options: LiveSyncOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const socket = getSharedSocket();

    const handleLayoutUpdate = (event: unknown) => {
      if (!isLayoutUpdateEvent(event)) return;
      const current = optionsRef.current;
      // Issue #218 perf: skip the catalog refresh when the broadcast
      // identifies the currently-active layout — `reconcileLayout` will
      // already pull the fresh content, so the catalog listing would
      // just round-trip back unchanged. For N connected clients per
      // active layout, this halves the HTTP fan-out per PUT.
      if (current.activeLayoutId !== event.id) {
        runRefresh(current.refreshLayouts, 'layout catalog');
      }
      runRefresh(() => current.reconcileLayout({ id: event.id }), 'active layout');
    };

    const handleConnect = () => {
      const current = optionsRef.current;
      runRefresh(current.refreshLayouts, 'layout reconnect');
      if (current.activeLayoutId) {
        runRefresh(
          () => current.reconcileLayout({ id: current.activeLayoutId! }),
          'active layout reconnect',
        );
      }
    };

    socket.on('connect', handleConnect);
    socket.on('layout:update', handleLayoutUpdate);
    return () => {
      socket.off('connect', handleConnect);
      socket.off('layout:update', handleLayoutUpdate);
      // Do NOT call socket.disconnect() — the socket is shared with
      // useAgentStore and MessageTicker.
    };
  }, []);
}
