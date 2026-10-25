import React, { useEffect, useId, useRef, useState } from 'react';
import { useControlAccess } from '../control/ControlAccess';
import { ControlApiError } from '../control/api';
import { controlReadDeadline, controlReadError } from '../control/readDeadline';
import './TaskDetails.css';

export function ControlAccessPanel({ active, loading, allowRefreshWhileLoading = false, onRefresh, error, children }: React.PropsWithChildren<{
  active: boolean; loading: boolean; allowRefreshWhileLoading?: boolean; onRefresh(signal?: AbortSignal): Promise<void>; error?: React.ReactNode;
}>) {
  const access = useControlAccess(); const keyId = useId();
  const [key, setKey] = useState(''); const [unlocking, setUnlocking] = useState(false);
  const refreshBusy = useRef(false); const [refreshing, setRefreshing] = useState(false);
  const [accessError, setAccessError] = useState<ControlApiError | null>(null); const [unlockError, setUnlockError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<ControlApiError | null>(null);
  const statusError = refreshError ?? accessError;
  useEffect(() => { setKey(''); setRefreshError(null); }, [access.state]);
  useEffect(() => {
    if (!active) return;
    let disposed = false; const controller = new AbortController();
    const check = async () => {
      if (document.visibilityState === 'hidden') return;
      try { await access.request('/api/control/status', { signal: controller.signal }); if (!disposed) setAccessError(null); }
      catch (failure) { if (!disposed) setAccessError(failure instanceof ControlApiError ? failure : new ControlApiError()); }
    };
    void check(); const timer = access.state === 'unlocked' ? setInterval(() => { void check(); }, 5000) : undefined;
    return () => { disposed = true; controller.abort(); clearInterval(timer); };
  }, [active, access.state, access.request]);
  const refresh = async () => {
    if (refreshBusy.current || (loading && !allowRefreshWhileLoading)) return;
    refreshBusy.current = true; setRefreshing(true); setRefreshError(null);
    const controller = new AbortController(); const dispose = controlReadDeadline(controller);
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(controlReadError(controller));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      await Promise.race([aborted, (async () => {
        await access.request('/api/control/status', { signal: controller.signal });
        if (controller.signal.aborted) throw new ControlApiError('unavailable');
        setAccessError(null); await onRefresh(controller.signal);
      })()]);
    } catch (failure) { setRefreshError(controlReadError(controller, failure)); }
    finally { dispose(); controller.signal.removeEventListener('abort', abort); refreshBusy.current = false; setRefreshing(false); }
  };
  if (access.state === 'locked') {
    if (!access.status && !statusError && !unlockError && !unlocking) return <section className="task-details task-access" aria-label="Task access"><p role="status">Checking task access…</p></section>;
    const setup = access.status?.configured === false; const transport = statusError?.code === 'transport-required';
    return <section className="task-details task-access" aria-label="Task access">
      <p className="task-eyebrow">FROM OPENCLAW</p>
      <h3>{setup ? 'Task access is not connected' : transport ? 'A secure connection is required' : 'Unlock task details'}</h3>
      <p>{setup ? 'Connect the office to OpenClaw to see real requests, run state and recorded activity. Your office roster continues to update normally.'
        : transport ? 'Use HTTPS or the office’s configured private Tailnet connection before entering an access key.' : 'Use the office task access key. It stays in this tab until you lock it or reload the page.'}</p>
      <p>Ask the person who runs this office for its task access key. Hosting your own office? Follow the setup guide.</p>
      <a className="task-setup-link" href="https://github.com/SweetSophia/openclaw-pixel-agents/blob/main/docs/task-access-setup.md" target="_blank" rel="noreferrer">Task access setup guide</a>
      {!setup && !transport && <form onSubmit={async event => {
        event.preventDefault(); if (unlocking) return; setUnlocking(true); setAccessError(null); setUnlockError(null);
        try { await access.unlock(key); } catch (failure) { setUnlockError(failure instanceof ControlApiError && failure.code !== 'locked' ? failure.message : 'Unlock failed. Check your access key and try again.'); }
        finally { setKey(''); setUnlocking(false); }
      }}>
        <label htmlFor={keyId}>Task access key</label>
        <input id={keyId} type="password" autoComplete="off" value={key} maxLength={4096} onChange={event => setKey(event.target.value)} />
        <button type="submit" disabled={!key || unlocking}>{unlocking ? 'Unlocking…' : 'Unlock task details'}</button>
      </form>}
      {unlockError && <p role="alert">{unlockError}</p>}
      {statusError && !['locked', 'transport-required'].includes(statusError.code) && <p role="alert">{statusError.message}</p>}
      {(setup || transport || statusError?.code === 'unavailable') && <button type="button" aria-disabled={refreshing} onClick={() => { void refresh(); }}>{refreshing ? 'Checking…' : 'Check connection'}</button>}
    </section>;
  }
  return <div className="task-details">
    <div className="task-tools"><span className="task-eyebrow">FROM OPENCLAW</span><button type="button" onClick={access.lock}>Lock</button><button type="button" aria-disabled={refreshing || (loading && !allowRefreshWhileLoading)} onClick={() => { void refresh(); }}>Refresh</button></div>
    {access.status && !access.status.canRead && <p role="status">{new ControlApiError(access.status.state === 'pairing-required' ? 'pairing-required' : access.status.state === 'auth-error' ? 'scope-required' : access.status.state === 'unsupported' ? 'unsupported' : 'unavailable').message}</p>}
    {(refreshError || error || accessError) && <p className="task-notice" role="alert">{refreshError?.message || error || accessError?.message}</p>}
    {children}
  </div>;
}
