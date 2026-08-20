import { useEffect, useRef } from 'react';
import { io as socketIO } from 'socket.io-client';
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
 */
export function useLiveSync(options: LiveSyncOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const socket = socketIO({ transports: ['websocket', 'polling'] });

    const handleLayoutUpdate = (event: unknown) => {
      if (!isLayoutUpdateEvent(event)) return;
      const current = optionsRef.current;
      runRefresh(current.refreshLayouts, 'layout catalog');
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
      socket.disconnect();
    };
  }, []);
}
