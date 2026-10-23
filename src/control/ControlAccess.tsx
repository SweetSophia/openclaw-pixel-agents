import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { parseControlStatus, type ControlStatus } from '../../shared/control';
import { ControlApiError, controlFetch } from './api';

export interface ControlAccess {
  state: 'locked' | 'unlocked'; status: ControlStatus | null; generation: number;
  unlock(key: string): Promise<void>; lock(): void; request(path: string, init?: RequestInit): Promise<unknown>;
}
const disabled: ControlStatus = { configured: false, state: 'disabled', canRead: false, canSend: false };
const Context = createContext<ControlAccess>({ state: 'locked', status: disabled, generation: 0,
  unlock: async () => { throw new ControlApiError('disabled'); }, lock() {}, request: async () => disabled });

export function ControlAccessProvider({ children }: React.PropsWithChildren) {
  const key = useRef<string | undefined>(undefined); const revision = useRef(0); const controllers = useRef(new Set<AbortController>());
  const [state, setState] = useState<'locked' | 'unlocked'>('locked'); const [status, setStatus] = useState<ControlStatus | null>(null);
  const [generation, setGeneration] = useState(0);
  const clear = useCallback(() => {
    revision.current++; key.current = undefined;
    for (const controller of controllers.current) controller.abort(); controllers.current.clear();
  }, []);
  const lock = useCallback(() => { clear(); setGeneration(revision.current); setState('locked'); setStatus(null); }, [clear]);
  useEffect(() => () => clear(), [clear]);
  const perform = useCallback(async (path: string, candidate: string | undefined, init: RequestInit = {}) => {
    const current = revision.current; const controller = new AbortController(); controllers.current.add(controller);
    const cancel = () => controller.abort(); init.signal?.addEventListener('abort', cancel, { once: true });
    if (init.signal?.aborted) controller.abort();
    try {
      const value = await controlFetch(path, candidate, { ...init, signal: controller.signal });
      if (controller.signal.aborted || current !== revision.current) throw new ControlApiError('locked');
      return value;
    } finally { init.signal?.removeEventListener('abort', cancel); controllers.current.delete(controller); }
  }, []);
  const unlock = useCallback(async (candidate: string) => {
    lock(); const current = revision.current;
    if (!candidate || candidate.length > 4096 || /[\r\n]/.test(candidate)) throw new ControlApiError('locked');
    const value = parseControlStatus(await perform('/api/control/status', candidate));
    if (current !== revision.current) throw new ControlApiError('locked');
    if (!value) throw new ControlApiError('invalid-source');
    if (!value.configured) throw new ControlApiError('disabled');
    key.current = candidate; setStatus(value); setState('unlocked');
  }, [lock, perform]);
  const request = useCallback(async (path: string, init?: RequestInit) => {
    const current = revision.current;
    if (!key.current && path !== '/api/control/status') throw new ControlApiError('locked');
    try {
      const value = await perform(path, key.current, init);
      if (path === '/api/control/status') {
        const checked = parseControlStatus(value); if (!checked) throw new ControlApiError('invalid-source'); setStatus(checked);
      }
      return value;
    } catch (error) {
      if (current === revision.current && error instanceof ControlApiError && ['locked', 'scope-required'].includes(error.code)) lock();
      throw error;
    }
  }, [lock, perform]);
  const value = useMemo(() => ({ state, status, generation, unlock, lock, request }), [state, status, generation, unlock, lock, request]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useControlAccess(): ControlAccess { return useContext(Context); }
