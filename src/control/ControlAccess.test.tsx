import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlAccessProvider, useControlAccess, useConversationDrafts } from './ControlAccess';
import { controlFetch } from './api';

const status = { configured: true, state: 'ready', canRead: true, canSend: false };
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code });
const wrapper = ({ children }: React.PropsWithChildren) => <ControlAccessProvider>{children}</ControlAccessProvider>;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('tab-memory task access', () => {
  it('normalizes a late network failure to locked for an obsolete access generation', async () => {
    let reject: (error: Error) => void = () => {};
    const fetch = vi.fn().mockResolvedValueOnce(json(status)).mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; })); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(useControlAccess, { wrapper }); await act(() => result.current.unlock('fixture-key'));
    const oldRequest = result.current.request; const pending = oldRequest('/api/control/agents/cylena/send', { method: 'POST', body: '{}' }).catch(error => error);
    act(() => result.current.lock()); reject(Error('network abort after old consumer unmounted'));
    await act(async () => { expect(await pending).toMatchObject({ code: 'locked' }); });
  });
  it('clears private draft and submission caches on lock', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(status)));
    const { result } = renderHook(() => ({ access: useControlAccess(), drafts: useConversationDrafts()! }), { wrapper });
    await act(() => result.current.access.unlock('fixture-key')); result.current.drafts.set('target', { text: 'private draft' });
    act(() => result.current.access.lock()); expect(result.current.drafts.size).toBe(0);
  });
  it('attaches the key only to same-origin control paths and prevents redirects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(status)); vi.stubGlobal('fetch', fetch);
    for (const path of ['https://other.test/api/control/status', '//other.test/api/control/status', '/api/agents', '/api/control/../../other']) await expect(controlFetch(path, 'fixture-key')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); await controlFetch('/api/control/status', 'fixture-key');
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fixture-key'); expect(init.redirect).toBe('error'); expect(init.cache).toBe('no-store');
  });
  it('retains access between panel lifecycles without persistent browser storage', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem'); const fetch = vi.fn(async () => json(status)); vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(useControlAccess, { wrapper });
    await act(() => result.current.unlock('fixture-key')); rerender(); expect(result.current.state).toBe('unlocked');
    await act(() => result.current.request('/api/control/status')); expect(local).not.toHaveBeenCalled();
    act(() => result.current.lock()); expect(result.current.state).toBe('locked'); expect(result.current.status).toBeNull();
  });
  it('aborts outstanding private reads on lock and drops a late success', async () => {
    let resolve: (response: Response) => void = () => {};
    const fetch = vi.fn().mockResolvedValueOnce(json(status)).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(useControlAccess, { wrapper }); await act(() => result.current.unlock('fixture-key'));
    const pending = result.current.request('/api/control/agents/cylena/sessions').catch(error => error);
    const signal = (fetch.mock.calls[1][1] as RequestInit).signal!;
    act(() => result.current.lock()); expect(signal.aborted).toBe(true); resolve(json({ private: 'old-generation' }));
    expect(await pending).toBeInstanceOf(Error); expect(result.current.state).toBe('locked');
  });
  it('discards an older unlock after a new lock generation', async () => {
    let resolve: (response: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const { result } = renderHook(useControlAccess, { wrapper });
    const pending = result.current.unlock('old-key').catch(error => error); act(() => result.current.lock()); resolve(json(status));
    await act(async () => { expect(await pending).toBeInstanceOf(Error); }); expect(result.current.state).toBe('locked');
  });
  it.each([['locked', 401], ['scope-required', 403], ['pairing-required', 503]])('locks and clears private capability data after %s', async (code, httpStatus) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(status)).mockResolvedValueOnce(json({ code }, httpStatus as number)));
    const { result } = renderHook(useControlAccess, { wrapper }); await act(() => result.current.unlock('fixture-key'));
    await act(async () => { await expect(result.current.request('/api/control/status')).rejects.toThrow(); });
    expect(result.current.state).toBe('locked'); expect(result.current.status).toBeNull();
  });
});
