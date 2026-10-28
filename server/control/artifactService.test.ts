// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlByteSize, type ControlTarget } from '../../shared/control';
import type { ControlFileRequest } from '../../shared/controlResults';
import { createArtifactService } from './artifactService';
import { GatewayRequestError, type ControlGateway, type GatewayEvent } from './gatewayClient';
import { createTaskService } from './taskService';
import { createRunHistoryService } from './runHistoryService';

const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 'session-1', lifecycleRevision: 'life-1' };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.useRealTimers(); });
function fixture(withHistory = false) {
  let runId: string | undefined = 'run-1'; let text: string | undefined = 'The shared fixture report.';
  let state: 'ready' | 'unavailable' | 'auth-error' = 'ready'; let generation = 1; let completed = false;
  const listeners = new Set<(event: GatewayEvent) => void>();
  const rows = new Map<string, Record<string, unknown>>([[target.sessionKey, { ...target, key: target.sessionKey }]]);
  const nativeArtifact = () => ({ id: 'artifact-1', type: 'text', title: 'report.txt', mimeType: 'text/plain',
    sessionKey: target.sessionKey, ...(runId ? { runId } : {}), messageSeq: 2, source: 'session-transcript', download: { mode: 'bytes' } });
  const list = vi.fn(async (_params: Record<string, unknown>, _signal?: AbortSignal): Promise<unknown> => ({ artifacts: [nativeArtifact()] }));
  const download = vi.fn(async (_params: Record<string, unknown>, _signal?: AbortSignal): Promise<unknown> => ({ artifact: nativeArtifact(), encoding: 'base64', data: Buffer.from('fixture bytes').toString('base64') }));
  const rpc = vi.fn<ControlGateway['request']>(async (method, params, signal) => {
    if (state !== 'ready') throw new GatewayRequestError(state === 'auth-error' ? 'scope-required' : 'unavailable');
    const row: Record<string, unknown> = { ...rows.get(String(params.key ?? params.sessionKey)), hasActiveRun: runId ? !completed : null,
      ...(completed ? { lastRunId: runId, status: 'completed' } : {}), snapshotAt: 100 };
    if (method === 'sessions.describe') return { session: row };
    if (method === 'sessions.list') return { sessions: [], hasMore: false };
    if (method === 'chat.history') return { sessionKey: params.sessionKey, sessionId: row.sessionId, sessionInfo: row,
      messages: [{ role: 'user', content: 'Create the fixture report', __openclaw: { id: 'request', runId } },
        ...(text ? [{ role: 'assistant', content: text, stopReason: 'stop', __openclaw: { id: 'response', runId } }] : [])],
      ...(runId && !completed ? { inFlightRun: { runId } } : {}), hasMore: false, totalMessages: 2 };
    if (method === 'artifacts.list') return list(params, signal);
    if (method === 'artifacts.get') return { artifact: nativeArtifact() };
    if (method === 'artifacts.download') return download(params, signal);
    return {};
  });
  const gateway: ControlGateway = { start() {}, close() {}, status: () => ({ configured: true, state, canRead: state === 'ready', canSend: false }),
    request: rpc, onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    artifactConnection: () => state === 'ready' ? { id: `fixture-${generation}`, generation, gatewayUrl: 'ws://127.0.0.1:18789/' } : null };
  const tasks = createTaskService(gateway, () => new Set(['cylena'])); const runHistory = withHistory ? createRunHistoryService(gateway, tasks) : undefined;
  const artifacts = createArtifactService(gateway, tasks, runHistory);
  cleanups.push(() => { artifacts.close(); runHistory?.close(); tasks.close(); });
  return { artifacts, tasks, runHistory, rpc, list, download, nativeArtifact, setRun: (value: string | undefined) => { runId = value; },
    setText: (value: string | undefined) => { text = value; }, complete: () => { completed = true; },
    setStatus: (value: typeof state) => { state = value; }, reconnect: () => { generation++; },
    add: (value: ControlTarget) => rows.set(value.sessionKey, { ...value, key: value.sessionKey }),
    patch: (value: Record<string, unknown>) => rows.set(target.sessionKey, { ...rows.get(target.sessionKey), ...value }),
    event: (event: GatewayEvent) => { for (const listener of listeners) listener(event); } };
}

describe('assistant-delivered results discovery', () => {
  const fileInput: ControlFileRequest = { target, scope: { kind: 'run', runId: 'run-1' }, artifactId: 'artifact-1', intent: 'preview' };
  it('reads explicitly selected historical files without weakening the live/latest file fence', async () => {
    const f = fixture(true); await f.runHistory!.read({ ...target, runId: 'run-1' }); const oldArtifact = f.nativeArtifact();
    f.setRun('run-2'); f.list.mockResolvedValue({ artifacts: [oldArtifact] });
    const results = await f.artifacts.read({ ...target, runId: 'run-1' }); expect(results.scope).toEqual({ kind: 'run', runId: 'run-1' }); expect(results.runState).toBe('unknown');
    expect(f.list.mock.lastCall?.[0]).toMatchObject({ runId: 'run-1', sessionKey: target.sessionKey });
    await expect(f.artifacts.file(fileInput)).rejects.toMatchObject({ code: 'session-changed' });
    const rpc = f.rpc.getMockImplementation()!; f.rpc.mockImplementation((method, params, signal) => method === 'artifacts.get' ? Promise.resolve({ artifact: oldArtifact }) : rpc(method, params, signal));
    f.download.mockResolvedValue({ artifact: oldArtifact, encoding: 'base64', data: Buffer.from('old bytes').toString('base64') });
    await expect(f.artifacts.file({ ...fileInput, historical: true })).resolves.toMatchObject({ kind: 'bytes' });
  });
  it('does not fetch artifacts for an unobserved historical run or fall back to another run cache', async () => {
    const f = fixture(true); await f.artifacts.read(target); f.list.mockClear();
    await expect(f.artifacts.read({ ...target, runId: 'unobserved' })).rejects.toMatchObject({ code: 'invalid-target' }); expect(f.list).not.toHaveBeenCalled();
    await expect(f.artifacts.file({ ...fileInput, scope: { kind: 'run', runId: 'unobserved' }, historical: true })).rejects.toMatchObject({ code: 'invalid-target' });
    expect(f.rpc.mock.calls.filter(([method]) => method === 'artifacts.get' || method === 'artifacts.download')).toHaveLength(0);
  });
  it('never serves a historical cache entry as the last-known live result', async () => {
    const f = fixture(true); await f.runHistory!.read({ ...target, runId: 'run-1' });
    const historical = await f.artifacts.read({ ...target, runId: 'run-1' }); expect(historical.scope).toEqual({ kind: 'run', runId: 'run-1' });
    f.setStatus('unavailable');
    await expect(f.artifacts.read(target)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('requires explicit run ownership on every historical artifact summary', async () => {
    const f = fixture(true); await f.runHistory!.read({ ...target, runId: 'run-1' });
    f.setRun('run-2'); const artifact = f.nativeArtifact(); delete (artifact as { runId?: string }).runId;
    f.list.mockResolvedValue({ artifacts: [artifact] });
    const result = await f.artifacts.read({ ...target, runId: 'run-1' });
    expect(result).toMatchObject({ scope: { kind: 'run', runId: 'run-1' }, artifactState: 'unavailable', artifacts: [] });
  });
  it('starts final content verification after transfer instead of joining an earlier fresh read', async () => {
    const f = fixture(); const artifact = f.nativeArtifact(); let finishDownload: (value: unknown) => void = () => {};
    f.download.mockImplementation(() => new Promise(resolve => { finishDownload = resolve; }));
    const pending = f.artifacts.file(fileInput).catch(error => error); await vi.waitFor(() => expect(f.download).toHaveBeenCalledOnce());
    const rpc = f.rpc.getMockImplementation()!; let finishChildren: (value: unknown) => void = () => {}; let held = false;
    f.rpc.mockImplementation((method, params, signal) => {
      if (method === 'sessions.list' && params.spawnedBy && !held) { held = true; return new Promise(resolve => { finishChildren = resolve; }); }
      return rpc(method, params, signal);
    });
    const older = f.tasks.getTask(target, undefined, { fresh: true }); await vi.waitFor(() => expect(held).toBe(true));
    f.setRun('run-2'); f.event({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey, reason: 'activity' } });
    finishDownload({ artifact, encoding: 'base64', data: Buffer.from('old private bytes').toString('base64') });
    await new Promise(resolve => setImmediate(resolve)); finishChildren({ sessions: [], hasMore: false }); await older;
    expect(await pending).toMatchObject({ code: 'session-changed' });
  });
  it('rejects a newly started content fence invalidated while its child lookup is pending', async () => {
    const f = fixture(); const artifact = f.nativeArtifact(); const rpc = f.rpc.getMockImplementation()!;
    let hold = false, held = false; let finishChildren: (value: unknown) => void = () => {};
    f.rpc.mockImplementation((method, params, signal) => {
      if (method === 'sessions.list' && params.spawnedBy && hold && !held) { held = true; return new Promise(resolve => { finishChildren = resolve; }); }
      return rpc(method, params, signal);
    });
    f.download.mockImplementation(async () => { hold = true; return { artifact, encoding: 'base64', data: Buffer.from('old private bytes').toString('base64') }; });
    const pending = f.artifacts.file(fileInput).catch(error => error); await vi.waitFor(() => expect(held).toBe(true));
    f.setRun('run-2'); f.event({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey, reason: 'activity' } }); finishChildren({ sessions: [], hasMore: false });
    expect(await pending).toMatchObject({ code: 'session-changed' });
  });
  it('changes the opaque private source revision across a fast reconnect with identical task scope', async () => {
    const f = fixture(); const first = await f.artifacts.read(target); f.reconnect();
    f.event({ event: 'source.invalidated', payload: null }); f.event({ event: 'source.ready', payload: null });
    const second = await f.artifacts.read(target); expect(second.sourceRevision).toEqual(expect.any(String)); expect(second.sourceRevision).not.toBe(first.sourceRevision);
    expect(second.target).toEqual(first.target); expect(second.scope).toEqual(first.scope); expect(second.source.state).toBe('current');
    expect(second.sourceRevision).not.toContain('fixture-');
  });
  it('requires the displayed task scope to remain canonical before content reads', async () => {
    const f = fixture(); f.setRun('run-2');
    await expect(f.artifacts.file(fileInput)).rejects.toMatchObject({ code: 'session-changed' });
    expect(f.rpc.mock.calls.filter(([method]) => method.startsWith('artifacts.'))).toHaveLength(0);
  });
  it.each(['run', 'session', 'branch', 'generation', 'revocation'] as const)('never exposes late content after %s changes', async change => {
    const f = fixture(); const originalArtifact = f.nativeArtifact(); let release: (value: unknown) => void = () => {};
    f.download.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = f.artifacts.file(fileInput).catch(error => error); await vi.waitFor(() => expect(f.download).toHaveBeenCalledTimes(1));
    if (change === 'run') f.setRun('run-2');
    if (change === 'session') f.patch({ sessionId: 'replacement' });
    if (change === 'branch') f.event({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey, reason: 'branch-switch' } });
    if (change === 'generation') f.reconnect();
    if (change === 'revocation') { f.setStatus('auth-error'); f.event({ event: 'source.invalidated', payload: null }); }
    release({ artifact: originalArtifact, encoding: 'base64', data: Buffer.from('old-private-bytes').toString('base64') });
    expect(await pending).toMatchObject({ code: change === 'revocation' ? 'scope-required' : 'session-changed' });
  });
  it('aborts a total content operation after thirty seconds without returning partial bytes', async () => {
    const f = fixture(); let upstream: AbortSignal | undefined;
    f.download.mockImplementation((_params, signal) => { upstream = signal; return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Error('cancelled')))); });
    vi.useFakeTimers();
    const deadline = f.artifacts.file(fileInput).catch(error => error); await vi.advanceTimersByTimeAsync(0);
    expect(f.download).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000); expect(await deadline).toMatchObject({ code: 'unavailable' }); expect(upstream?.aborted).toBe(true);
  });
  it('keeps assistant, agent, session and canonical run filters on discovery and strips private raw fields', async () => {
    const f = fixture(); f.complete();
    f.list.mockResolvedValue({ artifacts: [{ ...f.nativeArtifact(), image: { url: '/private-image-ticket' }, url: '/fake-host-file' }] });
    const result = await f.artifacts.read(target);
    expect(f.list.mock.calls.map(([params]) => params)).toEqual([{ agentId: 'cylena', sessionKey: target.sessionKey, runId: 'run-1', messageRole: 'assistant' }]);
    expect(result).toMatchObject({ scope: { kind: 'run', runId: 'run-1' }, responseKind: 'result', runState: 'completed',
      response: { text: 'The shared fixture report.' }, artifactState: 'ready', artifactsTruncated: false });
    expect(result.artifacts[0]).toEqual({ id: 'artifact-1', title: 'report.txt', type: 'text', mimeType: 'text/plain', runId: 'run-1', messageSeq: 2, download: 'bytes' });
    expect(JSON.stringify(result)).not.toContain('private-image-ticket'); expect(result.artifacts[0]).not.toHaveProperty('sizeBytes');
  });
  it('labels unverified text and missing-run conversation scope honestly', async () => {
    const f = fixture(); f.setRun(undefined);
    const result = await f.artifacts.read(target);
    expect(result).toMatchObject({ scope: { kind: 'conversation' }, runState: 'unknown', responseKind: 'latest' });
    expect(f.list.mock.calls[0][0]).toEqual({ agentId: 'cylena', sessionKey: target.sessionKey, messageRole: 'assistant' });
    f.setText(undefined); f.event({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey } });
    expect((await f.artifacts.read(target)).responseKind).toBe('none');
  });
  it('keeps usable task text when assistant filtering is unsupported and never drops the filter', async () => {
    const f = fixture(); f.list.mockRejectedValue(new GatewayRequestError('unsupported'));
    const result = await f.artifacts.read(target);
    expect(result).toMatchObject({ responseKind: 'latest', artifactState: 'unsupported', artifacts: [], source: { state: 'current' } });
    expect(f.list).toHaveBeenCalledTimes(1); expect(f.list.mock.calls[0][0].messageRole).toBe('assistant');
  });
  it('discards cached metadata when the native artifact owner rejects the selected scope', async () => {
    const f = fixture(); await f.artifacts.read(target);
    f.event({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey } });
    f.list.mockRejectedValue(new GatewayRequestError('session-changed'));
    await expect(f.artifacts.read(target)).rejects.toMatchObject({ code: 'session-changed' });
  });
  it.each(['run', 'session', 'lifecycle', 'branch', 'generation', 'revocation'] as const)('discards pending metadata after %s changes', async change => {
    const f = fixture(); let release: (value: unknown) => void = () => {};
    f.list.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = f.artifacts.read(target).catch(error => error);
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledTimes(1));
    if (change === 'run') f.setRun('run-2');
    if (change === 'session') f.patch({ sessionId: 'replacement' });
    if (change === 'lifecycle') f.patch({ lifecycleRevision: 'life-2' });
    if (change === 'generation') f.reconnect();
    if (change === 'branch') f.event({ event: 'sessions.changed', payload: { reason: 'branch-switch', sessionKey: target.sessionKey } });
    if (change === 'revocation') { f.setStatus('auth-error'); f.event({ event: 'source.invalidated', payload: null }); }
    release({ artifacts: [f.nativeArtifact()] });
    expect(await pending).toMatchObject({ code: change === 'revocation' ? 'scope-required' : 'session-changed' });
  });
  it('does not starve pending metadata on ordinary activity but refreshes the resulting dirty entry', async () => {
    const f = fixture(); let release: (value: unknown) => void = () => {};
    f.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.artifacts.read(target); await vi.waitFor(() => expect(f.list).toHaveBeenCalledTimes(1));
    f.event({ event: 'sessions.changed', payload: { reason: 'activity', sessionKey: target.sessionKey } });
    release({ artifacts: [f.nativeArtifact()] }); expect((await pending).source.state).toBe('current');
    await f.artifacts.read(target); expect(f.list).toHaveBeenCalledTimes(2);
  });
  it('reuses successful metadata for at most two seconds and returns independent copies', async () => {
    const f = fixture(); const first = await f.artifacts.read(target); first.artifacts[0].title = 'mutated';
    expect((await f.artifacts.read(target)).artifacts[0].title).toBe('report.txt'); expect(f.list).toHaveBeenCalledTimes(1);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 2001);
    await f.artifacts.read(target); expect(f.list).toHaveBeenCalledTimes(2);
  });
  it('keeps same-scope stale metadata at its original timestamp and expires it after sixty seconds', async () => {
    const f = fixture(); const initial = await f.artifacts.read(target);
    vi.useFakeTimers(); const now = Date.now(); vi.setSystemTime(now + 2100); f.setStatus('unavailable');
    const stale = await f.artifacts.read(target);
    expect(stale.artifacts).toEqual(initial.artifacts); expect(stale.source).toEqual({ state: 'stale', observedAt: initial.source.observedAt });
    vi.setSystemTime(now + 60001); await expect(f.artifacts.read(target)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('bounds metadata cache reuse to thirty-two selections', async () => {
    const f = fixture(); f.list.mockResolvedValue({ artifacts: [] });
    for (let index = 0; index < 33; index++) {
      const selected = { ...target, sessionKey: `agent:cylena:selection-${index}`, sessionId: `selection-${index}` }; f.add(selected); await f.artifacts.read(selected);
    }
    const oldest = { ...target, sessionKey: 'agent:cylena:selection-0', sessionId: 'selection-0' };
    await f.artifacts.read(oldest); expect(f.list).toHaveBeenCalledTimes(34);
  });
  it('keeps the newest hundred summaries with stable sequence ties and bounded metadata bytes', async () => {
    const f = fixture();
    f.list.mockResolvedValue({ artifacts: Array.from({ length: 125 }, (_, index) => ({ ...f.nativeArtifact(), id: `file-${index}`, messageSeq: index + 1 })) });
    const result = await f.artifacts.read(target);
    expect(result.artifacts.map(item => item.id)).toEqual(Array.from({ length: 100 }, (_, index) => `file-${124 - index}`));
    expect(result.artifactsTruncated).toBe(true);
    f.event({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey } });
    f.list.mockResolvedValue({ artifacts: ['first-tie', 'second-tie'].map(id => ({ ...f.nativeArtifact(), id, messageSeq: 10 })) });
    expect((await f.artifacts.read(target)).artifacts.map(item => item.id)).toEqual(['first-tie', 'second-tie']);
    f.event({ event: 'sessions.changed', payload: { sessionKey: target.sessionKey } });
    f.list.mockResolvedValue({ artifacts: Array.from({ length: 100 }, (_, index) => ({ ...f.nativeArtifact(), id: `${index}-${'€'.repeat(506)}`, title: '€'.repeat(512) })) });
    const bounded = await f.artifacts.read(target);
    expect(bounded.artifacts.length).toBeLessThan(100); expect(bounded.artifactsTruncated).toBe(true);
    expect(controlByteSize(bounded)).toBeLessThanOrEqual(256 * 1024);
  });
  it('shares discovery until its final subscriber aborts and ignores abandoned late results', async () => {
    const f = fixture(); let upstream: AbortSignal | undefined; let release: (value: unknown) => void = () => {};
    f.list.mockImplementation((_params, signal) => { upstream = signal; return new Promise(resolve => { release = resolve; }); });
    const a = new AbortController(); const b = new AbortController();
    const first = f.artifacts.read(target, a.signal).catch(error => error); const second = f.artifacts.read(target, b.signal).catch(error => error);
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledTimes(1));
    a.abort(); await first; expect(upstream?.aborted).toBe(false);
    b.abort(); await second; expect(upstream?.aborted).toBe(true);
    release({ artifacts: [f.nativeArtifact()] });
    f.list.mockResolvedValue({ artifacts: [] }); expect((await f.artifacts.read(target)).artifacts).toEqual([]);
  });
  it('rejects cross-session or cross-run source metadata without returning private entries', async () => {
    const f = fixture(); f.list.mockResolvedValue({ artifacts: [{ ...f.nativeArtifact(), sessionKey: 'agent:other:secret', title: 'private-other-title' }] });
    const result = await f.artifacts.read(target); expect(result.artifactState).toBe('unavailable'); expect(result.artifacts).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private-other-title');
  });
});
