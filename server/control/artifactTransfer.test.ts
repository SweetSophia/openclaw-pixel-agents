// @vitest-environment node
import { createServer, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlFileRequest } from '../../shared/controlResults';
import type { ControlGateway, GatewayEvent } from './gatewayClient';
import { downloadArtifact } from './artifactTransfer';

const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture/encoded key', sessionId: 'session-1', lifecycleRevision: 'life-1' };
const input: ControlFileRequest = { target, scope: { kind: 'run', runId: 'run-1' }, artifactId: 'artifact-1', intent: 'download' };
const ticket = 't'.repeat(43); const uuid = '12345678-1234-4123-8123-123456789abc';
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
  let id = 'connection-1'; let generation = 1;
  const listeners = new Set<(event: GatewayEvent) => void>();
  const artifact = () => ({ id: input.artifactId, type: 'text', title: 'report.json', mimeType: 'application/json', sessionKey: target.sessionKey,
    runId: 'run-1', messageSeq: 2, source: 'session-transcript', download: { mode: 'bytes' } });
  const transfer = vi.fn(async (_params: Record<string, unknown>): Promise<unknown> => ({ artifact: artifact(), encoding: 'base64', data: Buffer.from('{"ok":true}').toString('base64') }));
  const request = vi.fn<ControlGateway['request']>(async (method, params) => method === 'artifacts.get' ? { artifact: artifact() } : transfer(params));
  const gateway: ControlGateway = { start() {}, close() {}, status: () => ({ configured: true, state: 'ready', canRead: true, canSend: false }), request,
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    artifactConnection: () => ({ id, generation, gatewayUrl: 'ws://127.0.0.1:18789/non-root/socket' }) };
  return { gateway, request, transfer, artifact, reconnect() { id = 'connection-2'; generation++; for (const listener of listeners) listener({ event: 'source.invalidated', payload: null }); } };
}
async function host(handler: RequestListener) {
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture address');
  closers.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { origin: `http://127.0.0.1:${address.port}`, socket: `ws://127.0.0.1:${address.port}/non-root/socket` };
}
const expiresAt = () => new Date(Date.now() + 60000).toISOString();

describe('native filtered artifact transfer', () => {
  it('reads inline bytes with exact assistant/agent/session/run filters on get and download', async () => {
    const f = fixture(); const result = await downloadArtifact(f.gateway, input, new AbortController().signal);
    expect(result).toMatchObject({ kind: 'bytes', mimeType: 'application/json', filename: 'report.json', truncated: false });
    if (result.kind !== 'bytes') throw Error('expected bytes'); expect(Buffer.from(result.data).toString()).toBe('{"ok":true}');
    expect(f.request.mock.calls.map(([method, params]) => ({ method, params }))).toEqual([
      { method: 'artifacts.get', params: { agentId: 'cylena', sessionKey: target.sessionKey, runId: 'run-1', messageRole: 'assistant', artifactId: 'artifact-1' } },
      { method: 'artifacts.download', params: { agentId: 'cylena', sessionKey: target.sessionKey, runId: 'run-1', messageRole: 'assistant', artifactId: 'artifact-1', transport: 'http' } },
    ]);
  });
  it('uses the configured origin and documented root grant route even with a non-root WebSocket endpoint', async () => {
    const seen: { url?: string; auth?: string }[] = [];
    const h = await host((request, response) => { seen.push({ url: request.url, auth: request.headers.authorization }); response.setHeader('Content-Type', 'application/json'); response.end('{"native":true}'); });
    const f = fixture(); f.gateway.artifactConnection = () => ({ id: 'connection-1', generation: 1, gatewayUrl: h.socket });
    f.transfer.mockResolvedValue({ artifact: { ...f.artifact(), download: { mode: 'url' } }, url: `/api/artifacts/download/connection-1/${ticket}`, expiresAt: expiresAt() });
    const result = await downloadArtifact(f.gateway, input, new AbortController().signal);
    expect(seen).toEqual([{ url: `/api/artifacts/download/connection-1/${ticket}`, auth: undefined }]);
    if (result.kind !== 'bytes') throw Error('expected bytes'); expect(Buffer.from(result.data).toString()).toBe('{"native":true}');
  });
  it('accepts only canonical encoded selected-session managed paths and the source-provided media ticket', async () => {
    const mediaTicket = `v1.${Buffer.from('synthetic-ticket').toString('base64url')}.${'s'.repeat(43)}`;
    const path = `/api/chat/media/outgoing/${encodeURIComponent(target.sessionKey)}/${uuid}/full?mediaTicket=${mediaTicket}`;
    const h = await host((request, response) => { expect(request.url).toBe(path); response.setHeader('Content-Type', 'text/plain'); response.end('managed fixture'); });
    const f = fixture(); f.gateway.artifactConnection = () => ({ id: 'connection-1', generation: 1, gatewayUrl: h.socket });
    f.transfer.mockResolvedValue({ artifact: { ...f.artifact(), download: { mode: 'url' } }, url: path, expiresAt: expiresAt() });
    const result = await downloadArtifact(f.gateway, input, new AbortController().signal);
    if (result.kind !== 'bytes') throw Error('expected bytes'); expect(Buffer.from(result.data).toString()).toBe('managed fixture');
  });
  it('returns external descriptors without any external server fetch', async () => {
    const f = fixture(); const fetchSpy = vi.spyOn(globalThis, 'fetch');
    f.transfer.mockResolvedValue({ artifact: { ...f.artifact(), download: { mode: 'url' } }, url: 'https://example.com/report' });
    expect(await downloadArtifact(f.gateway, input, new AbortController().signal)).toEqual({ kind: 'external', url: 'https://example.com/report', host: 'example.com', title: 'report.json' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('keeps an ordinary external document fragment while refusing incomplete grant URLs as external links', async () => {
    const f = fixture(); const fetchSpy = vi.spyOn(globalThis, 'fetch');
    f.transfer.mockResolvedValue({ artifact: { ...f.artifact(), download: { mode: 'url' } }, url: 'https://example.com/report.pdf#page=2' });
    expect(await downloadArtifact(f.gateway, input, new AbortController().signal)).toMatchObject({ kind: 'external', url: 'https://example.com/report.pdf#page=2', host: 'example.com' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('never exposes a Gateway grant ticket by downgrading missing expiry to an external link', async () => {
    const f = fixture(); const fetchSpy = vi.spyOn(globalThis, 'fetch');
    f.transfer.mockResolvedValue({ artifact: { ...f.artifact(), download: { mode: 'url' } }, url: `http://127.0.0.1:18789/api/artifacts/download/connection-1/${ticket}` });
    await expect(downloadArtifact(f.gateway, input, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-source' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each([
    `https://elsewhere.example/api/artifacts/download/connection-1/${ticket}`,
    `http://user:pass@127.0.0.1:18789/api/artifacts/download/connection-1/${ticket}`,
    `/api/artifacts/download/wrong-connection/${ticket}`, `/api/artifacts/download/connection-1/../${ticket}`,
    `/non-root/api/artifacts/download/connection-1/${ticket}`, `/api/artifacts/download/connection-1/%2e%2e`,
    `/api/chat/media/outgoing/${encodeURIComponent('agent:other:secret')}/${uuid}/full?mediaTicket=v1.eA.${'s'.repeat(43)}`,
    `/api/chat/media/outgoing/${encodeURIComponent(target.sessionKey).replace('%3A', '%253A')}/${uuid}/full?mediaTicket=v1.eA.${'s'.repeat(43)}`,
  ])('rejects origin, credential, connection and raw-path broadening: %s', async url => {
    const f = fixture(); const fetchSpy = vi.spyOn(globalThis, 'fetch');
    f.transfer.mockResolvedValue({ artifact: { ...f.artifact(), download: { mode: 'url' } }, url, expiresAt: expiresAt() });
    await expect(downloadArtifact(f.gateway, input, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-source' });
    expect(fetchSpy).not.toHaveBeenCalled(); expect(f.transfer).toHaveBeenCalledTimes(1);
  });
  it('does not follow HTTP redirects and permits only one fully filtered inline fallback', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('synthetic redirect refused'));
    const f = fixture(); const inline = { artifact: f.artifact(), encoding: 'base64', data: Buffer.from('safe fallback').toString('base64') };
    f.transfer.mockResolvedValueOnce({ artifact: { ...f.artifact(), download: { mode: 'url' } }, url: `/api/artifacts/download/connection-1/${ticket}`, expiresAt: expiresAt() }).mockResolvedValueOnce(inline);
    const result = await downloadArtifact(f.gateway, input, new AbortController().signal);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(f.transfer.mock.calls.map(([params]) => params)).toEqual([
      { agentId: 'cylena', sessionKey: target.sessionKey, runId: 'run-1', messageRole: 'assistant', artifactId: 'artifact-1', transport: 'http' },
      { agentId: 'cylena', sessionKey: target.sessionKey, runId: 'run-1', messageRole: 'assistant', artifactId: 'artifact-1' },
    ]);
    if (result.kind !== 'bytes') throw Error('expected bytes'); expect(Buffer.from(result.data).toString()).toBe('safe fallback');
  });
  it('reacquires an expired grant instead of fetching or replaying it', async () => {
    const f = fixture(); const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('fresh', { headers: { 'Content-Type': 'text/plain' } }));
    const grant = { artifact: { ...f.artifact(), download: { mode: 'url' } }, url: `/api/artifacts/download/connection-1/${ticket}` };
    f.transfer.mockResolvedValueOnce({ ...grant, expiresAt: new Date(0).toISOString() }).mockResolvedValueOnce({ ...grant, url: grant.url.replace(ticket, 'n'.repeat(43)), expiresAt: expiresAt() });
    await downloadArtifact(f.gateway, input, new AbortController().signal);
    expect(f.transfer).toHaveBeenCalledTimes(2); expect(fetchSpy).toHaveBeenCalledTimes(1); expect(String(fetchSpy.mock.calls[0][0])).toContain('n'.repeat(43));
  });
  it.each([{}, { 'Content-Length': '1' }] as Record<string, string>[])('bounds actual HTTP bytes despite absent/false declared lengths: %j', async headers => {
    const f = fixture(); const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close();
    } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { headers }));
    f.transfer.mockResolvedValue({ artifact: { ...f.artifact(), download: { mode: 'url' } }, url: `/api/artifacts/download/connection-1/${ticket}`, expiresAt: expiresAt() });
    await expect(downloadArtifact(f.gateway, input, new AbortController().signal)).rejects.toMatchObject({ code: 'file-too-large' });
    expect(f.transfer).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched artifact ownership and malformed base64 without a host-file fallback', async () => {
    const f = fixture(); f.transfer.mockResolvedValue({ artifact: { ...f.artifact(), sessionKey: 'agent:other:secret' }, encoding: 'base64', data: 'c2VjcmV0' });
    await expect(downloadArtifact(f.gateway, input, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-source' });
    f.transfer.mockResolvedValue({ artifact: f.artifact(), encoding: 'base64', data: '/fake-host-file' });
    await expect(downloadArtifact(f.gateway, input, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-source' });
  });
  it('discards late bytes when the paired connection generation changes', async () => {
    const f = fixture(); let release: (value: unknown) => void = () => {};
    f.transfer.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = downloadArtifact(f.gateway, input, new AbortController().signal).catch(error => error);
    await vi.waitFor(() => expect(f.transfer).toHaveBeenCalledTimes(1)); f.reconnect();
    release({ artifact: f.artifact(), encoding: 'base64', data: 'b2xk' }); expect(await pending).toMatchObject({ code: 'session-changed' });
  });
});
