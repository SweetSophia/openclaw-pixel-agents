import React from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResultContent } from './useResultContent';
import { ControlAccessProvider, useControlAccess } from './ControlAccess';
import type { ControlArtifactScope } from '../../shared/controlResults';

const wrapper = ({ children }: React.PropsWithChildren) => <ControlAccessProvider>{children}</ControlAccessProvider>;
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 's1' };
const initial = { target, scope: { kind: 'run', runId: 'r1' } as ControlArtifactScope, active: true, current: true };
const status = () => new Response('{"configured":true,"state":"ready","canRead":true,"canSend":false}');
const file = (type = 'image/png', content = 'private') => new Response(content, { headers: { 'X-Pixel-Control-File': 'bytes', 'Content-Type': type, 'Content-Disposition': 'attachment; filename="report.txt"' } });
const create = vi.fn(() => 'blob:owned'); const revoke = vi.fn();
beforeEach(() => { vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; }); create.mockClear(); revoke.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe('private result content lifecycle', () => {
  it('revokes an existing image after a quick source reconnect even when access and task scope stay ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('status') ? status() : file()));
    const { result, rerender } = renderHook(props => ({ access: useControlAccess(), content: useResultContent(props) }), { wrapper, initialProps: { ...initial, sourceRevision: 'source-before' } });
    await act(() => result.current.access.unlock('fixture-key')); await act(() => result.current.content.act('image', 'preview'));
    expect(result.current.content.preview).toMatchObject({ kind: 'image' }); rerender({ ...initial, sourceRevision: 'source-after' });
    expect(result.current.content.preview).toBeNull(); expect(revoke).toHaveBeenCalledWith('blob:owned'); expect(result.current.access.state).toBe('unlocked');
  });
  it('reclaims image URLs on a scope change, close and loss of current verification', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('status') ? status() : file()));
    const { result, rerender } = renderHook(props => ({ access: useControlAccess(), content: useResultContent(props) }), { wrapper, initialProps: initial });
    await act(() => result.current.access.unlock('fixture-key'));
    await act(() => result.current.content.act('image', 'preview')); expect(result.current.content.preview).toMatchObject({ kind: 'image', url: 'blob:owned' });
    rerender({ ...initial, scope: { kind: 'run', runId: 'r2' } }); expect(revoke).toHaveBeenCalledWith('blob:owned'); expect(result.current.content.preview).toBeNull();
    await act(() => result.current.content.act('image', 'preview')); rerender({ ...initial, active: false }); expect(result.current.content.preview).toBeNull();
    rerender(initial); await act(() => result.current.content.act('image', 'preview')); rerender({ ...initial, current: false }); expect(result.current.content.preview).toBeNull();
    expect(localStorage.length).toBe(0);
  });
  it.each(['lock', 'hidden', 'close', 'scope'] as const)('aborts pending reads on %s and discards late bytes', async reason => {
    let resolve: (response: Response) => void = () => {};
    const fetch = vi.fn().mockResolvedValueOnce(status()).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(props => ({ access: useControlAccess(), content: useResultContent(props) }), { wrapper, initialProps: initial });
    await act(() => result.current.access.unlock('fixture-key'));
    let pending: Promise<void>; act(() => { pending = result.current.content.act('report', 'preview'); });
    const signal = (fetch.mock.calls[1][1] as RequestInit).signal!;
    if (reason === 'lock') act(() => result.current.access.lock());
    if (reason === 'close') rerender({ ...initial, active: false });
    if (reason === 'scope') rerender({ ...initial, scope: { kind: 'conversation' } });
    if (reason === 'hidden') act(() => { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); });
    expect(signal.aborted).toBe(true); await act(async () => { resolve(file()); await pending; });
    expect(result.current.content.preview).toBeNull(); expect(create).not.toHaveBeenCalled();
  });
  it('previews plain UTF-8 as text, reports shortening, and keeps external references explicit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(new Response('line one\n<script>literal</script>', { headers: { 'X-Pixel-Control-File': 'bytes', 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="text.txt"', 'X-Pixel-Preview-Truncated': 'true' } }))
      .mockResolvedValueOnce(new Response('{"kind":"external","title":"Report","url":"https://example.com/report","host":"example.com"}', { headers: { 'X-Pixel-Control-File': 'link' } })));
    const { result } = renderHook(() => ({ access: useControlAccess(), content: useResultContent(initial) }), { wrapper });
    await act(() => result.current.access.unlock('fixture-key')); await act(() => result.current.content.act('text', 'preview'));
    expect(result.current.content.preview).toEqual({ kind: 'text', artifactId: 'text', text: 'line one\n<script>literal</script>', truncated: true }); expect(create).not.toHaveBeenCalled();
    await act(() => result.current.content.act('link', 'download')); expect(result.current.content.external?.host).toBe('example.com'); expect(result.current.content.preview).toBeNull();
  });
  it('exports an owned temporary download anchor and reclaims its URL', async () => {
    vi.useFakeTimers(); const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(file('application/pdf')));
    const { result } = renderHook(() => ({ access: useControlAccess(), content: useResultContent(initial) }), { wrapper });
    await act(() => result.current.access.unlock('fixture-key')); await act(() => result.current.content.act('pdf', 'download'));
    expect(click).toHaveBeenCalledOnce(); expect(document.querySelector('a[download]')).toBeNull(); expect(result.current.content.preview).toBeNull();
    act(() => vi.runOnlyPendingTimers()); expect(revoke).toHaveBeenCalledWith('blob:owned');
  });
});
