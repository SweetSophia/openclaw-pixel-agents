// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Duplex } from 'node:stream';
import { createAgentDocumentGateway } from './gatewayClient';
import { createAgentDocumentService } from './agentDocumentService';
import { documentFixture, documentHash, encodeDocumentFrame, nativeDocument, type DocumentFrame } from './fixtures/agentDocuments';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(options: Parameters<typeof documentFixture>[0] = {}) {
  const host = await documentFixture(options); cleanups.push(() => host.close());
  const gateway = createAgentDocumentGateway(host.config);
  const service = createAgentDocumentService(gateway, () => new Set(['main', 'other'])); cleanups.push(() => service.close());
  service.status('main'); await vi.waitFor(() => expect(gateway.status().canEdit).toBe(true));
  return { host, gateway, service };
}
const write = (revision: string, operationId = 'document-operation-1', content = 'updated') => ({ name: 'AGENTS.md' as const, revision, operationId, content });
describe('one-use agent document revisions and receipts over signed native frames', () => {
  it('requires exact registered canonical agent ownership before any native request', async () => {
    const { host, service } = await setup();
    for (const agent of ['MAIN', 'unregistered', '../main']) {
      expect(() => service.status(agent)).toThrow();
      await expect(service.read(agent, { name: 'AGENTS.md' })).rejects.toMatchObject({ code: 'invalid-target' });
    }
    await expect(service.read('main', { name: 'IDENTITY.md' as 'AGENTS.md' })).rejects.toMatchObject({ code: 'invalid-request' });
    expect(host.frames.map(frame => frame.method)).toEqual(['connect']);
  });
  it('reads validated bytes without revealing the host path and sends both stored preconditions exactly once', async () => {
    const { host, service } = await setup(); const snapshot = await service.read('main', { name: 'AGENTS.md' });
    expect(snapshot).toMatchObject({ agentId: 'main', name: 'AGENTS.md', content: 'original', bytes: 8, source: { state: 'current' } });
    expect(JSON.stringify(snapshot)).not.toContain('/fixture');
    const receipt = await service.save('main', write(snapshot.revision));
    expect(receipt).toMatchObject({ agentId: 'main', name: 'AGENTS.md', operationId: 'document-operation-1', state: 'saved', snapshot: { content: 'updated', bytes: 7 } });
    expect(receipt.snapshot!.revision).not.toBe(snapshot.revision);
    expect(host.frames[host.frames.length - 1]).toMatchObject({ method: 'agents.files.set', params: { agentId: 'main', name: 'AGENTS.md', content: 'updated', expectedHash: '0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5', expectedWorkspace: '/fixture/workspace' } });
    expect(Object.keys(host.frames[host.frames.length - 1].params).sort()).toEqual(['agentId', 'content', 'expectedHash', 'expectedWorkspace', 'name']);
    await expect(service.save('main', write(snapshot.revision, 'another-operation'))).rejects.toMatchObject({ code: 'document-changed' });
    expect(host.frames.map(frame => frame.method)).toEqual(['connect', 'agents.files.get', 'agents.files.set']);
  });
  it.each([
    ['missing', { ...nativeDocument().file, missing: true }, 'file-unavailable'],
    ['oversized', { ...nativeDocument().file, size: 32769, content: 'a'.repeat(32769) }, 'file-too-large'],
    ['binary', { ...nativeDocument().file, content: '\0' }, 'preview-unsupported'],
    ['lossy native decode', { ...nativeDocument('�').file, hash: documentHash(Buffer.from([0xff])), size: 1 }, 'invalid-source'],
    ['native raw hash mismatch', { ...nativeDocument().file, hash: 'f'.repeat(64) }, 'invalid-source'],
    ['missing native hash', { ...nativeDocument().file, hash: undefined }, 'invalid-source'],
    ['wrong byte size', { ...nativeDocument('é').file, size: 1 }, 'invalid-source'],
    ['wrong name', { ...nativeDocument().file, name: 'SOUL.md' }, 'invalid-source'],
    ['extra native field', { ...nativeDocument().file, extra: 'unsupported' }, 'invalid-source'],
  ])('rejects %s without issuing a write revision', async (_, file, code) => {
    const { host, service } = await setup({ onRequest(frame, socket) { if (frame.method !== 'agents.files.get') return; socket.write(encodeDocumentFrame({ type: 'res', id: frame.id, ok: true, payload: nativeDocument('original', { file }) })); return true; } });
    await expect(service.read('main', { name: 'AGENTS.md' })).rejects.toMatchObject({ code });
    await expect(service.save('main', write('guessed-revision'))).rejects.toMatchObject({ code: 'document-changed' });
    expect(host.frames.map(frame => frame.method)).toEqual(['connect', 'agents.files.get']);
  });
  it('accepts exact empty and multibyte native text', async () => {
    let content = '';
    const { host, service } = await setup({ onRequest(frame, socket) { if (frame.method !== 'agents.files.get') return; socket.write(encodeDocumentFrame({ type: 'res', id: frame.id, ok: true, payload: nativeDocument(content) })); return true; } });
    expect((await service.read('main', { name: 'AGENTS.md' })).bytes).toBe(0);
    content = '\ufeffé🙂\r\n'; expect((await service.read('main', { name: 'AGENTS.md' })).content).toBe(content);
    host.setDocument(content);
    const result = await service.save('main', write((await service.read('main', { name: 'AGENTS.md' })).revision, 'empty-operation', ''));
    expect(result).toMatchObject({ state: 'saved', snapshot: { content: '', bytes: 0 } });
    expect(host.frames[host.frames.length - 1].params.content).toBe('');
  });
  it('coalesces pending same-operation submissions and rejects changed selection/payload immutably', async () => {
    let pending: { frame: DocumentFrame; socket: Duplex } | undefined;
    const { host, service } = await setup({ onRequest(frame, socket) { if (frame.method !== 'agents.files.set') return; pending = { frame, socket }; return true; } });
    const snapshot = await service.read('main', { name: 'AGENTS.md' }); const input = write(snapshot.revision);
    const first = service.save('main', input); const second = service.save('main', { ...input }); input.content = 'mutated-after-submit';
    await vi.waitFor(() => expect(pending).toBeDefined());
    for (const [agent, change] of [['main', { content: 'different' }], ['other', {}], ['main', { name: 'SOUL.md' }], ['main', { revision: 'other-revision' }]] as const) await expect(service.save(agent, { ...write(snapshot.revision), ...change })).rejects.toMatchObject({ code: 'invalid-request' });
    host.respond(pending!.frame, pending!.socket, { ok: true, ...nativeDocument('updated') });
    const results = await Promise.all([first, second]); expect(results[0]).toEqual(results[1]); expect(results[0].state).toBe('saved');
    results[0].snapshot!.content = 'client-modified';
    expect((await service.save('main', write(snapshot.revision))).snapshot!.content).toBe('updated');
    expect(host.frames.filter(frame => frame.method === 'agents.files.set')).toHaveLength(1);
    expect(pending!.frame.params.content).toBe('updated');
  });
  it('keeps native conflicts as retained conflict receipts, never force/replay', async () => {
    const { host, service } = await setup({ onRequest(frame, socket) { if (frame.method !== 'agents.files.set') return; socket.write(encodeDocumentFrame({ type: 'res', id: frame.id, ok: false, error: { code: 'INVALID_REQUEST', details: { type: 'agent_file_conflict', currentHash: 'secret' } } })); return true; } });
    const input = write((await service.read('main', { name: 'AGENTS.md' })).revision);
    expect(await service.save('main', input)).toEqual({ agentId: 'main', name: 'AGENTS.md', operationId: input.operationId, state: 'conflict' });
    expect((await service.save('main', input)).state).toBe('conflict'); expect(host.frames).toHaveLength(3);
  });
  it.each(['external-bytes', 'workspace-root', 'file-removed'])('preserves server-bound preconditions when native %s changes without an event', async change => {
    const { host, service } = await setup(); const input = write((await service.read('main', { name: 'AGENTS.md' })).revision);
    if (change === 'workspace-root') host.setDocument('original', '/fixture/new-workspace');
    else host.setDocument(change === 'file-removed' ? null : 'external editor bytes');
    expect((await service.save('main', input)).state).toBe('conflict'); expect((await service.save('main', input)).state).toBe('conflict');
    expect(host.frames.filter(frame => frame.method === 'agents.files.set')).toHaveLength(1);
    expect(host.frames[2].params).toMatchObject({ expectedWorkspace: '/fixture/workspace', expectedHash: '0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5' });
  });
  it('rejects mismatched agent/document tickets without consuming their original selection', async () => {
    const { host, service } = await setup(); const input = write((await service.read('main', { name: 'AGENTS.md' })).revision);
    await expect(service.save('other', input)).rejects.toMatchObject({ code: 'document-changed' });
    await expect(service.save('main', { ...input, name: 'SOUL.md' })).rejects.toMatchObject({ code: 'document-changed' });
    expect((await service.save('main', input)).state).toBe('saved'); expect(host.frames).toHaveLength(3);
  });
  it('a lost connection consumes its revision and retains unknown across signed reconnect', async () => {
    const { host, service, gateway } = await setup({ onRequest: frame => frame.method === 'agents.files.set' });
    const input = write((await service.read('main', { name: 'AGENTS.md' })).revision); const before = gateway.status().epoch;
    const saving = service.save('main', input); await vi.waitFor(() => expect(host.frames).toHaveLength(3));
    for (const socket of host.sockets) socket.destroy();
    expect((await saving).state).toBe('unknown'); await vi.waitFor(() => expect(gateway.status().canEdit).toBe(true), { timeout: 2000 });
    expect(gateway.status().epoch).not.toBe(before); expect((await service.save('main', input)).state).toBe('unknown');
    await expect(service.save('main', { ...input, operationId: 'replacement-operation' })).rejects.toMatchObject({ code: 'document-changed' });
    expect(host.frames.filter(frame => frame.method === 'agents.files.set')).toHaveLength(1);
  });
  it.each(['agentId', 'workspace', 'hash', 'size', 'content', 'ok', 'extra'])('classifies malformed post-write %s acknowledgements as retained unknown', async field => {
    const { host, service } = await setup({ onRequest(frame, socket) {
      if (frame.method !== 'agents.files.set') return;
      const ack = { ok: true, ...nativeDocument('updated') } as Record<string, any>;
      if (field === 'hash') ack.file.hash = documentHash('other');
      else if (field === 'size') ack.file.size = 1;
      else if (field === 'content') { ack.file.content = 'other'; ack.file.size = 5; ack.file.hash = documentHash('other'); }
      else ack[field] = field === 'ok' ? false : 'different';
      socket.write(encodeDocumentFrame({ type: 'res', id: frame.id, ok: true, payload: ack })); return true;
    } });
    const input = write((await service.read('main', { name: 'AGENTS.md' })).revision);
    expect((await service.save('main', input)).state).toBe('unknown'); expect((await service.save('main', input)).state).toBe('unknown');
    expect(host.frames.filter(frame => frame.method === 'agents.files.set')).toHaveLength(1);
  });
  it('fences config/connection changes before save and after awaited reads/writes', async () => {
    let held: { frame: DocumentFrame; socket: Duplex } | undefined; let hold = false;
    const { host, service } = await setup({ onRequest(frame, socket) { if (hold && frame.method !== 'connect') { held = { frame, socket }; return true; } } });
    const original = await service.read('main', { name: 'AGENTS.md' }); host.event('config.changed'); await new Promise(resolve => setTimeout(resolve, 20));
    await expect(service.save('main', write(original.revision))).rejects.toMatchObject({ code: 'document-changed' });
    hold = true; const reading = service.read('main', { name: 'AGENTS.md' }).catch(error => error);
    await vi.waitFor(() => expect(held).toBeDefined()); host.event('config.changed'); host.respond(held!.frame, held!.socket, nativeDocument());
    expect(await reading).toMatchObject({ code: 'document-changed' });
    hold = false; const current = await service.read('main', { name: 'AGENTS.md' }); held = undefined; hold = true;
    const writing = service.save('main', write(current.revision)); await vi.waitFor(() => expect(held).toBeDefined());
    host.event('config.changed'); host.respond(held!.frame, held!.socket, { ok: true, ...nativeDocument('updated') });
    expect((await writing).state).toBe('unknown');
    expect(host.frames.filter(frame => frame.method === 'agents.files.set')).toHaveLength(1);
  });
  it('does not consume or dispatch on pre-abort but retains unknown on post-dispatch abort', async () => {
    const { host, service } = await setup({ onRequest: frame => frame.method === 'agents.files.set' });
    const input = write((await service.read('main', { name: 'AGENTS.md' })).revision);
    const before = new AbortController(); before.abort(); await expect(service.save('main', input, before.signal)).rejects.toMatchObject({ code: 'unavailable' });
    expect(host.frames).toHaveLength(2);
    const after = new AbortController(); const saving = service.save('main', input, after.signal);
    await vi.waitFor(() => expect(host.frames).toHaveLength(3)); after.abort();
    expect((await saving).state).toBe('unknown'); expect((await service.save('main', input)).state).toBe('unknown'); expect(host.frames).toHaveLength(3);
  });
  it('bounds 32 one-use read tickets with expiry and 128 receipts without eviction/replay', async () => {
    const { host, service } = await setup(); vi.useFakeTimers({ toFake: ['Date'] });
    const tickets = []; for (let i = 0; i < 32; i++) tickets.push(await service.read('main', { name: 'AGENTS.md' }));
    await expect(service.read('main', { name: 'AGENTS.md' })).rejects.toMatchObject({ code: 'rate-limited' });
    expect(host.frames.filter(frame => frame.method === 'agents.files.get')).toHaveLength(32);
    vi.setSystemTime(Date.now() + 600000);
    await expect(service.save('main', write(tickets[0].revision))).rejects.toMatchObject({ code: 'document-changed' });
    let current = await service.read('main', { name: 'AGENTS.md' });
    for (let i = 0; i < 128; i++) current = (await service.save('main', write(current.revision, `operation-${i}`))).snapshot!;
    await expect(service.save('main', write(current.revision, 'operation-overflow'))).rejects.toMatchObject({ code: 'rate-limited' });
    expect(host.frames.filter(frame => frame.method === 'agents.files.set')).toHaveLength(128);
    vi.setSystemTime(Date.now() + 600000);
    await expect(service.save('main', write(current.revision, 'operation-overflow'))).rejects.toMatchObject({ code: 'document-changed' });
    current = await service.read('main', { name: 'AGENTS.md' }); expect((await service.save('main', write(current.revision, 'operation-after-expiry'))).state).toBe('saved');
  });
  it('close invalidates revisions, late results, private contents and the document connection', async () => {
    const { host, gateway, service } = await setup(); const snapshot = await service.read('main', { name: 'AGENTS.md' }); service.close();
    await expect(service.save('main', write(snapshot.revision))).rejects.toMatchObject({ code: 'unavailable' });
    expect(gateway.connection()).toBeNull(); expect(host.frames.filter(frame => frame.method === 'agents.files.set')).toHaveLength(0);
  });
});
