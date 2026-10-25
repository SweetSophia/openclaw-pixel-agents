import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlFetch, controlFetchFile } from './api';
import { CONTROL_RESULT_LIMITS } from '../../shared/controlResults';

afterEach(() => vi.unstubAllGlobals());
const headers = { 'X-Pixel-Control-File': 'bytes', 'Content-Type': 'application/json', 'Content-Disposition': "attachment; filename=report.json; filename*=UTF-8''R%C3%A9sum%C3%A9.json" };
it('does not accept a browser-only timeout as a server rejection code', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":"timed-out"}', { status: 504 })));
  await expect(controlFetch('/api/control/agents/cylena/send', 'fixture-key', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'unavailable' });
});
describe('private file response boundary', () => {
  it('preserves JSON bytes and the UTF-8 filename without treating content as metadata', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"ok":true}', { headers })); vi.stubGlobal('fetch', fetch);
    const value = await controlFetchFile('/api/control/agents/cylena/results/file', 'fixture-key', { method: 'POST', body: '{}' });
    expect(value.kind).toBe('bytes'); if (value.kind !== 'bytes') throw Error();
    expect(await value.blob.text()).toBe('{"ok":true}'); expect(value.filename).toBe('Résumé.json');
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fixture-key');
    expect(init).toMatchObject({ redirect: 'error', cache: 'no-store', credentials: 'same-origin' });
  });
  it('accepts only normalized explicit link descriptors and typed HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ kind: 'external', title: 'Report', host: 'example.com', url: 'https://example.com/report' }), { headers: { 'X-Pixel-Control-File': 'link' } })));
    expect(await controlFetchFile('/api/control/file', 'k')).toMatchObject({ kind: 'external', host: 'example.com' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":"scope-required"}', { status: 403, headers })));
    await expect(controlFetchFile('/api/control/file', 'k')).rejects.toMatchObject({ code: 'scope-required' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"kind":"external","host":"wrong","url":"https://example.com","title":"X"}', { headers: { 'X-Pixel-Control-File': 'link' } })));
    await expect(controlFetchFile('/api/control/file', 'k')).rejects.toMatchObject({ code: 'invalid-source' });
  });
  it('rejects missing discriminators, unsafe filenames and non-private or redirected paths', async () => {
    const fetch = vi.fn(async () => new Response('data')); vi.stubGlobal('fetch', fetch);
    for (const path of ['https://other.test/api/control/file', '//other.test/api/control/file', '/api/control/../../other', '/api/agents', '/api/control/file#fragment']) await expect(controlFetchFile(path, 'k')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); await expect(controlFetchFile('/api/control/file', 'k')).rejects.toMatchObject({ code: 'invalid-source' });
    fetch.mockImplementation(async () => new Response('data', { headers: { ...headers, 'Content-Disposition': 'attachment; filename="../../private.txt"' } }));
    await expect(controlFetchFile('/api/control/file', 'k')).rejects.toMatchObject({ code: 'invalid-source' });
  });
  it('bounds actual streamed bytes even with a false or absent content length and cancels the reader', async () => {
    for (const length of [undefined, '1']) {
      const cancel = vi.fn(); const data = new Uint8Array(CONTROL_RESULT_LIMITS.transferBytes / 2 + 1);
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.enqueue(data); }, cancel });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { ...headers, ...(length ? { 'Content-Length': length } : {}) } })));
      await expect(controlFetchFile('/api/control/file', 'k')).rejects.toMatchObject({ code: 'file-too-large' }); expect(cancel).toHaveBeenCalled();
    }
  });
});
