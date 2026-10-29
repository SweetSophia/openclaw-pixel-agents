import { describe, expect, it } from 'vitest';
import { parseApprovalReadRequest, parseApprovalResolveRequest, parseApprovalInspectRequest, parseApprovalPage, parseApprovalResult, parseControlApproval, isApprovalId } from './controlApprovals';
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:main', sessionId: 'session-1' };
describe('private approval contract', () => {
  it('never interprets expiry or owner cancellation as an applied reviewer decision', () => {
    for (const status of ['expired', 'cancelled']) {
      const approval = { id: 'full-id', kind: 'exec', title: 'Run command', text: 'synthetic command', details: [], status,
        createdAtMs: 1, expiresAtMs: 20, resolvedAtMs: 20, allowedDecisions: [] };
      expect(parseApprovalResult({ target, source: { state: 'current', observedAt: 20 }, approval, applied: false })).not.toBeNull();
      expect(parseApprovalResult({ target, source: { state: 'current', observedAt: 20 }, approval, applied: true })).toBeNull();
    }
  });
  it('accepts only explicit one-time decisions and exact target fields', () => {
    expect(parseApprovalResolveRequest({ target, id: 'full-approval-id', kind: 'exec', decision: 'allow-once', observationId: 'opaque-inspection' })).not.toBeNull();
    for (const extra of [{ decision: 'allow-always' }, { reviewer: {} }, { grantExpiresInDays: 1 }, { kind: 'other' }])
      expect(parseApprovalResolveRequest({ target, id: 'full-approval-id', kind: 'exec', decision: 'deny', ...extra })).toBeNull();
    expect(parseApprovalReadRequest({ target, id: 'unrelated' })).toBeNull();
    expect(parseApprovalReadRequest({ target: { ...target, runId: 'not-an-approval-owner' } })).toBeNull();
  });
  it('requires an inspected observation and rejects bidi, control and malformed unicode IDs', () => {
    expect(parseApprovalResolveRequest({ target, id: 'id', kind: 'exec', decision: 'deny' })).toBeNull();
    for (const id of ['id\u202e', 'id\u2066', 'id\u0000', '\ud800', ' id', 'a'.repeat(513)]) expect(isApprovalId(id)).toBe(false);
    expect(isApprovalId('approval-😀')).toBe(true);
  });
  it('rejects oversized, malformed and non-private approval pages', () => {
    const page = { target, source: { state: 'current', observedAt: 1 }, items: [], truncated: false };
    expect(parseApprovalPage(page)).toEqual(page);
    expect(parseApprovalPage({ ...page, items: Array(26).fill({}) })).toBeNull();
    expect(parseApprovalPage({ ...page, rawRequest: { env: 'secret' } })).toBeNull();
  });
  it('validates complete bounded presentations, timestamps, one-time choices and observation responses', () => {
    const approval = { id: 'full-id', kind: 'exec', title: 'Run command', text: 'synthetic command', details: ['Warning: synthetic'], status: 'pending', createdAtMs: 1, expiresAtMs: 20, allowedDecisions: ['allow-once', 'deny'] };
    const result = { target, source: { state: 'current', observedAt: 1 }, approval, applied: false, observationId: 'opaque-inspection' };
    expect(parseApprovalResult(result)).toEqual(result);
    for (const change of [{ text: '' }, { text: 'x'.repeat(16001) }, { details: Array(13).fill('x') }, { expiresAtMs: 0 }, { resolvedAtMs: NaN }, { createdAtMs: -1 }, { status: 'allowed' }, { allowedDecisions: ['allow-always', 'deny'] }, { allowedDecisions: ['deny', 'deny'] }, { secret: 'must-not-escape' }]) expect(parseControlApproval({ ...approval, ...change })).toBeNull();
    expect(parseApprovalResult({ ...result, source: { state: 'stale', observedAt: 1 } })).toBeNull();
    expect(parseApprovalResult({ ...result, applied: true })).toBeNull();
    expect(parseApprovalInspectRequest({ target, id: 'id', reviewer: {} })).toBeNull();
    expect(parseApprovalReadRequest({ target, runId: 'historical' })).toBeNull();
    expect(parseApprovalResolveRequest({ target: { ...target, runId: 'historical' }, id: 'id', kind: 'exec', decision: 'deny', observationId: 'inspection' })).toBeNull();
  });
});
