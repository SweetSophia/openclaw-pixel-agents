import { describe, expect, it } from 'vitest';
import { controlPreviewKind, parseControlExternalFile, parseControlFileRequest, parseControlResultsSnapshot } from './controlResults';

const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 'session-1', lifecycleRevision: 'life-1', branchId: 'branch-1' };
const artifact = { id: 'artifact-1', type: 'text', title: 'report.txt', mimeType: 'text/plain', runId: 'run-1', download: 'bytes' };
const response = { id: 'answer-1', role: 'assistant', text: 'Finished\nThe report is attached.', truncated: false, runId: 'run-1' };
const snapshot = () => ({ target, scope: { kind: 'run', runId: 'run-1' }, source: { state: 'current', observedAt: 123 }, sourceRevision: 'source-1',
  runState: 'completed', responseKind: 'result', response, artifactState: 'ready', artifacts: [artifact], artifactsTruncated: false });
const request = () => ({ target, scope: { kind: 'run', runId: 'run-1' }, artifactId: 'artifact-1', intent: 'preview' });

describe('private Results contracts', () => {
  it.each(['application/typescript', 'application/x-javascript', 'application/ld+json'])('offers text preview consistently for %s', mime => {
    expect(controlPreviewKind(mime)).toBe('text');
  });
  it('preserves validated result and explicit conversation scope without inventing a missing file size', () => {
    expect(parseControlResultsSnapshot(snapshot())).toEqual(snapshot());
    expect(parseControlResultsSnapshot(snapshot())?.artifacts[0]).not.toHaveProperty('sizeBytes');
    const conversation = { ...snapshot(), scope: { kind: 'conversation' }, runState: 'unknown', responseKind: 'latest' };
    expect(parseControlResultsSnapshot(conversation)).toEqual(conversation);
    expect(parseControlResultsSnapshot({ ...conversation, responseKind: 'none', response: undefined })?.responseKind).toBe('none');
  });

  it('never turns running, failed or uncorrelated text into a verified completed result', () => {
    for (const runState of ['running', 'failed', 'aborted', 'unknown', 'not-running']) {
      expect(parseControlResultsSnapshot({ ...snapshot(), runState })).toBeNull();
      expect(parseControlResultsSnapshot({ ...snapshot(), runState, responseKind: 'latest' })?.responseKind).toBe('latest');
    }
    for (const responseKind of ['result', 'latest']) expect(parseControlResultsSnapshot({ ...snapshot(), responseKind, response: undefined })).toBeNull();
    expect(parseControlResultsSnapshot({ ...snapshot(), responseKind: 'none' })).toBeNull();
    expect(parseControlResultsSnapshot({ ...snapshot(), response: { ...response, role: 'user' } })).toBeNull();
  });

  it('rejects oversized collections, negative/nonfinite sizes and mismatched run summaries', () => {
    expect(parseControlResultsSnapshot({ ...snapshot(), artifacts: Array(101).fill(artifact) })).toBeNull();
    for (const sizeBytes of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseControlResultsSnapshot({ ...snapshot(), artifacts: [{ ...artifact, sizeBytes }] })).toBeNull();
    }
    expect(parseControlResultsSnapshot({ ...snapshot(), artifacts: [{ ...artifact, sizeBytes: 0 }] })?.artifacts[0].sizeBytes).toBe(0);
    expect(parseControlResultsSnapshot({ ...snapshot(), artifacts: [{ ...artifact, runId: 'different-run' }] })).toBeNull();
    expect(parseControlResultsSnapshot({ ...snapshot(), scope: { kind: 'run' } })).toBeNull();
    expect(parseControlResultsSnapshot({ ...snapshot(), scope: { kind: 'conversation', runId: 'run-1' } })).toBeNull();
  });

  it('enforces metadata bytes independently of field character and summary-count limits', () => {
    const many = Array.from({ length: 100 }, (_, index) => ({ ...artifact, id: `${index}-${'a'.repeat(508)}`, title: '€'.repeat(512) }));
    expect(parseControlResultsSnapshot({ ...snapshot(), artifacts: many })?.artifacts).toHaveLength(100);
    const tooManyBytes = many.map(item => ({ ...item, id: '€'.repeat(512) }));
    expect(parseControlResultsSnapshot({ ...snapshot(), artifacts: tooManyBytes })).toBeNull();
  });

  it('rejects unbounded or control-bearing opaque fields and malformed nested identities', () => {
    for (const [key, value] of [['id', 'x'.repeat(513)], ['title', 'x'.repeat(513)], ['mimeType', 'x'.repeat(129)],
      ['type', 'x'.repeat(65)], ['id', 'bad\nselector'], ['title', 'bad\rtitle'], ['type', ''], ['messageSeq', -1]]) {
      expect(parseControlResultsSnapshot({ ...snapshot(), artifacts: [{ ...artifact, [key]: value }] })).toBeNull();
    }
    expect(parseControlResultsSnapshot({ ...snapshot(), target: { ...target, sessionId: '../escape' } })).toBeNull();
    expect(parseControlResultsSnapshot({ ...snapshot(), source: { state: 'current', observedAt: Infinity } })).toBeNull();
    expect(parseControlResultsSnapshot({ ...snapshot(), response: { ...response, text: 'x'.repeat(16001) } })).toBeNull();
  });

  it('rejects private transport fields, reserved keys and extra fields at every boundary', () => {
    for (const changed of [
      { ...snapshot(), token: 'synthetic-not-public' },
      { ...snapshot(), target: { ...target, path: '/fake-host-file' } },
      { ...snapshot(), artifacts: [{ ...artifact, url: 'https://example.com/private-ticket' }] },
      { ...snapshot(), artifacts: [{ ...artifact, constructor: {} }] },
      { ...snapshot(), response: { ...response, raw: 'private' } },
      JSON.parse(JSON.stringify(snapshot()).replace('"target":', '"__proto__":{},"target":')),
    ]) expect(parseControlResultsSnapshot(changed)).toBeNull();
  });

  it('accepts only a nested, exact selected-file request', () => {
    expect(parseControlFileRequest(request())).toEqual(request());
    for (const changed of [
      { ...request(), path: '/fake-host-file' }, { ...request(), url: 'https://example.com/file' },
      { ...request(), target: { ...target, method: 'arbitrary.rpc' } }, { ...request(), artifactId: 'x'.repeat(513) },
      { ...request(), scope: { kind: 'run', runId: 'bad\nrun' } }, { ...request(), intent: 'open-workspace' },
      { ...target, artifactId: 'artifact-1', intent: 'preview' },
    ]) expect(parseControlFileRequest(changed)).toBeNull();
  });

  it('normalizes only explicit HTTP links and verifies the displayed destination host', () => {
    const link = { kind: 'external', url: 'https://example.com:8443/report?q=1', host: 'example.com:8443', title: 'Shared report' };
    expect(parseControlExternalFile(link)).toEqual(link);
    for (const url of ['javascript:alert(1)', 'file:///fake-host-file', 'https://user:pass@example.com/file', `https://example.com/${'x'.repeat(4096)}`]) {
      expect(parseControlExternalFile({ ...link, url })).toBeNull();
    }
    expect(parseControlExternalFile({ ...link, host: 'misleading.example' })).toBeNull();
    expect(parseControlExternalFile({ ...link, title: 'bad\nname' })).toBeNull();
    expect(parseControlExternalFile({ ...link, ticket: 'synthetic-private-ticket' })).toBeNull();
  });
});
