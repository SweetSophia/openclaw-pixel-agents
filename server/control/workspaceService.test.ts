// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ControlGateway, GatewayEvent } from './gatewayClient';
import { createWorkspaceService } from './workspaceService';

function fixture() {
  const listeners = new Set<(event: GatewayEvent) => void>(); const registered = new Set(['cylena']);
  let entry = { path: 'notes/report.txt', name: 'report.txt', kind: 'file', size: 5, updatedAtMs: 100 };
  let file = { ...entry, mimeType: 'text/plain', encoding: 'utf8', content: 'hello' };
  let listAgent = 'cylena'; let hook: (() => void) | undefined; let state = 'ready';
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'agents.workspace.list') return { agentId: listAgent, path: params.path, entries: [entry], totalEntries: 1, offset: params.offset, workspaceDir: '/never-expose' };
    if (method === 'agents.workspace.get') { hook?.(); return { agentId: 'cylena', file }; }
    throw Error('unexpected RPC');
  });
  const gateway = { request, onEvent: (fn: (event: GatewayEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    status: () => ({ configured: true, state, canRead: state === 'ready', canSend: false }), start() {}, close() {} } as unknown as ControlGateway;
  const service = createWorkspaceService(gateway, () => registered);
  const list = () => service.list('cylena', { path: 'notes', offset: 0 });
  const input = async () => ({ path: entry.path, offset: 0, sourceRevision: (await list()).sourceRevision, expected: { size: entry.size, updatedAtMs: entry.updatedAtMs }, intent: 'download' as const });
  return { service, request, list, input, registered, setEntry: (next: Partial<typeof entry>) => { entry = { ...entry, ...next }; },
    setFile: (next: Partial<typeof file>) => { file = { ...file, ...next }; }, setAgent: (value: string) => { listAgent = value; },
    duringGet: (fn: () => void) => { hook = fn; }, disconnect: () => { for (const listener of listeners) listener({ event: 'source.invalidated', payload: null }); }, setState: (value: string) => { state = value; } };
}
describe('native workspace ownership and content', () => {
  it('lists metadata without reading content or exposing host paths', async () => {
    const f = fixture(); const page = await f.list();
    expect(page).toMatchObject({ agentId: 'cylena', path: 'notes', entries: [{ name: 'report.txt' }], source: { state: 'current' } });
    expect(JSON.stringify(page)).not.toContain('never-expose');
    expect(f.request.mock.calls.map(call => call[0])).toEqual(['agents.workspace.list']);
    expect(f.request.mock.calls[0][1]).toEqual({ agentId: 'cylena', path: 'notes', offset: 0, limit: 50 });
  });
  it('freshly preflights the selected page before returning exact text bytes', async () => {
    const f = fixture(); const input = await f.input(); f.request.mockClear();
    const value = await f.service.file('cylena', input);
    expect(value).toMatchObject({ kind: 'bytes', filename: 'report.txt', mimeType: 'text/plain' });
    if (value.kind === 'bytes') expect(Buffer.from(value.data).toString()).toBe('hello');
    expect(f.request.mock.calls.map(call => call[0])).toEqual(['agents.workspace.list', 'agents.workspace.get']);
  });
  it.each(['oversized', 'unknown', 'changed', 'moved'] as const)('refuses %s metadata before any content RPC', async mode => {
    const f = fixture(); const input = await f.input();
    f.setEntry(mode === 'oversized' ? { size: 262145 } : mode === 'unknown' ? { size: undefined as unknown as number } : mode === 'moved' ? { path: 'notes/other.txt', name: 'other.txt' } : { updatedAtMs: 101 });
    await expect(f.service.file('cylena', input)).rejects.toBeDefined();
    expect(f.request.mock.calls.some(call => call[0] === 'agents.workspace.get')).toBe(false);
  });
  it.each(['source', 'agent', 'metadata', 'path', 'bytes'] as const)('refuses bytes after %s changes', async mode => {
    const f = fixture(); const input = await f.input();
    if (mode === 'source') f.duringGet(f.disconnect);
    else if (mode === 'agent') f.duringGet(() => f.registered.clear());
    else if (mode === 'metadata') f.setFile({ updatedAtMs: 101 });
    else if (mode === 'path') f.setFile({ path: 'other/report.txt' });
    else f.setFile({ content: 'different bytes' });
    await expect(f.service.file('cylena', input)).rejects.toBeDefined();
  });
  it('rejects unregistered agents, foreign listings, stale revisions and aborts', async () => {
    const f = fixture(); await expect(f.service.list('other', { path: '', offset: 0 })).rejects.toMatchObject({ code: 'invalid-target' });
    expect(f.request).not.toHaveBeenCalled(); f.setAgent('other'); await expect(f.list()).rejects.toMatchObject({ code: 'invalid-source' });
    f.setAgent('cylena'); const input = await f.input(); f.disconnect();
    await expect(f.service.file('cylena', input)).rejects.toMatchObject({ code: 'workspace-changed' });
    const controller = new AbortController(); controller.abort();
    await expect(f.service.list('cylena', { path: '', offset: 0 }, controller.signal)).rejects.toBeDefined();
    f.setState('unavailable'); await expect(f.list()).rejects.toMatchObject({ code: 'unavailable' });
    f.service.close();
  });
  it('supports empty UTF-8 files and validates actual raster content', async () => {
    const f = fixture(); f.setEntry({ size: 0 }); f.setFile({ size: 0, content: '' });
    const empty = await f.service.file('cylena', { ...await f.input(), intent: 'preview' });
    expect(empty).toMatchObject({ kind: 'bytes', data: Buffer.alloc(0), truncated: false });
    const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1kAAAAASUVORK5CYII=', 'base64');
    f.setEntry({ path: 'notes/画像.png', name: '画像.png', size: data.length });
    f.setFile({ path: 'notes/画像.png', name: '画像.png', size: data.length, encoding: 'base64', mimeType: 'image/png', content: data.toString('base64') });
    const image = await f.service.file('cylena', { ...await f.input(), intent: 'preview' });
    expect(image).toMatchObject({ kind: 'bytes', data, mimeType: 'image/png' });
    f.setFile({ content: Buffer.alloc(data.length).toString('base64') });
    await expect(f.service.file('cylena', { ...await f.input(), intent: 'preview' })).rejects.toMatchObject({ code: 'preview-unsupported' });
  });
  it.each(['page.html', 'drawing.svg'])('renders native %s source as inert UTF-8 text', async name => {
    const f = fixture(); const content = '<script>literal source</script>';
    f.setEntry({ path: `notes/${name}`, name, size: Buffer.byteLength(content) });
    f.setFile({ path: `notes/${name}`, name, size: Buffer.byteLength(content), content });
    const result = await f.service.file('cylena', { ...await f.input(), intent: 'preview' });
    expect(result).toMatchObject({ kind: 'bytes', mimeType: 'text/plain; charset=utf-8', data: Buffer.from(content) });
  });
  it('rejects oversized current selections and malformed base64 before exporting bytes', async () => {
    const f = fixture(); f.setEntry({ size: 262145 });
    await expect(f.service.file('cylena', await f.input())).rejects.toMatchObject({ code: 'file-too-large' });
    expect(f.request.mock.calls.some(call => call[0] === 'agents.workspace.get')).toBe(false);
    f.setEntry({ path: 'notes/file.png', name: 'file.png', size: 5 });
    f.setFile({ path: 'notes/file.png', name: 'file.png', encoding: 'base64', mimeType: 'image/png', content: 'aGVsbG8=garbage' });
    await expect(f.service.file('cylena', await f.input())).rejects.toMatchObject({ code: 'invalid-source' });
  });
  it('refuses a late directory response after reconnect or disposal', async () => {
    const f = fixture(); let release!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.list(); f.disconnect();
    release({ agentId: 'cylena', path: 'notes', entries: [], totalEntries: 0, offset: 0 });
    await expect(pending).rejects.toMatchObject({ code: 'workspace-changed' });
    f.service.close(); await expect(f.list()).rejects.toMatchObject({ code: 'unavailable' });
  });
});
