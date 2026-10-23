import { describe, expect, it } from 'vitest';
import { parseControlSessionPage, parseControlStatus, parseControlTaskSnapshot } from './control';

const target = { agentId: 'cylena', sessionKey: 'agent:cylena:test', sessionId: 'session-1' };
const snapshot = () => ({
  target, source: { state: 'current', observedAt: 123 }, hasActiveRun: true,
  runState: 'running', requestAssociation: 'unknown', requestState: 'not-loaded',
  activity: [], children: [], childrenComplete: false, loadedRecords: 50,
});

describe('private control response boundaries', () => {
  it('accepts supported status and copies only public capability fields', () => {
    expect(parseControlStatus({ configured: true, state: 'ready', canRead: true, canSend: false, token: 'fixture-secret' }))
      .toEqual({ configured: true, state: 'ready', canRead: true, canSend: false });
    expect(parseControlStatus({ configured: true, state: 'surprise', canRead: true, canSend: false })).toBeNull();
    expect(parseControlStatus({ configured: true, state: 'auth-error', canRead: true, canSend: true })).toBeNull();
  });

  it('preserves unknown versus false activity and exact empty run sets', () => {
    const unknown = parseControlTaskSnapshot({ ...snapshot(), hasActiveRun: null, runState: 'unknown' });
    expect(unknown?.hasActiveRun).toBeNull();
    expect(unknown).not.toHaveProperty('activeRunIds');
    expect(parseControlTaskSnapshot({ ...snapshot(), hasActiveRun: false, activeRunIds: [] })?.activeRunIds).toEqual([]);
  });

  it('rejects invalid identities, times, run states and partial exact-ID arrays', () => {
    expect(parseControlTaskSnapshot({ ...snapshot(), target: { ...target, agentId: '../main' } })).toBeNull();
    expect(parseControlTaskSnapshot({ ...snapshot(), source: { state: 'current', observedAt: Infinity } })).toBeNull();
    expect(parseControlTaskSnapshot({ ...snapshot(), loadedRecords: 2001 })).toBeNull();
    expect(parseControlTaskSnapshot({ ...snapshot(), runState: 'probably-finished' })).toBeNull();
    expect(parseControlTaskSnapshot({ ...snapshot(), activeRunIds: ['run-1', null] })).toBeNull();
    expect(parseControlTaskSnapshot({ ...snapshot(), target: { ...target, lifecycleRevision: -1 } })).toBeNull();
  });

  it('copies nested display data without leaking raw source fields', () => {
    const result = parseControlTaskSnapshot({ ...snapshot(),
      token: 'fixture-secret', diagnostics: { password: 'fixture-secret' },
      request: { id: 'm1', role: 'user', text: 'Review the form', truncated: false, raw: 'fixture-secret' },
      activity: [{ id: 't1', toolName: 'exec', outcome: 'success', arguments: 'fixture-secret' }],
    });
    expect(result?.request?.text).toBe('Review the form');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });

  it('rejects poisoned records and oversized or invalid display messages', () => {
    expect(parseControlTaskSnapshot(JSON.parse(JSON.stringify(snapshot()).replace('"target":', '"__proto__":{},"target":')))).toBeNull();
    expect(parseControlTaskSnapshot({ ...snapshot(), request: { id: 'm1', role: 'system', text: 'hidden', truncated: false } })).toBeNull();
    expect(parseControlTaskSnapshot({ ...snapshot(), request: { id: 'm1', role: 'assistant', text: 'x'.repeat(16001), truncated: false } })).toBeNull();
    expect(parseControlTaskSnapshot({ ...snapshot(), ignored: 'x'.repeat(256 * 1024) })).toBeNull();
  });

  it('bounds session pages and preserves source-backed selection facts', () => {
    const session = { ...target, name: 'Telegram', isChild: false, hasActiveRun: null, path: '/private/fixture' };
    const page = parseControlSessionPage({ sessions: [session], source: { state: 'current', observedAt: 100 } });
    expect(page?.sessions[0]).toEqual({ ...target, name: 'Telegram', isChild: false, hasActiveRun: null });
    expect(parseControlSessionPage({ sessions: Array(26).fill(session), source: { state: 'current', observedAt: 100 } })).toBeNull();
  });
});
