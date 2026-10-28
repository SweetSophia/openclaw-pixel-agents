import { describe, expect, it } from 'vitest';
import { projectRecordedRunOutcome } from './runOutcome';
const target = { agentId: 'a', sessionKey: 'agent:a:fixture', sessionId: 'session-1' };
const event = (action: string, status: string, extra = {}) => ({ eventType: 'agent_run', schemaVersion: 1, redaction: 'metadata_only', kind: 'agent_run', actor: { type: 'agent', id: 'a' }, eventId: action, sequence: 1, sourceSequence: 1,
  occurredAt: action.endsWith('started') ? 100 : 200, ...target, action, status, runId: 'run-1', ...extra });
const project = (events: unknown[], extra = {}) => projectRecordedRunOutcome({ events, ...extra }, target, 'run-1', 300);
describe('historical native terminal evidence', () => {
  it('projects exact positive metadata facts rather than assistant stop reasons', () => {
    expect(project([event('agent.run.finished', 'succeeded'), event('agent.run.started', 'started')])).toEqual({ state: 'recorded', runState: 'completed', startedAt: 100, endedAt: 200, observedAt: 300 });
    expect(project([event('agent.run.started', 'started')])).toMatchObject({ state: 'recorded', runState: 'unknown', startedAt: 100 });
    expect(project([]).runState).toBe('unknown');
  });
  it.each([{ sessionId: 'replacement' }, { sessionId: undefined }, { sessionKey: 'another' }, { agentId: 'other' }, { runId: 'other' }, { schemaVersion: 2 }, { errorCode: 'wrong' },
    { actor: { type: 'agent', id: 'other' } }, { occurredAt: 60301 }])('rejects mismatched or insufficient provenance %j', extra => {
    expect(project([event('agent.run.finished', 'succeeded', extra)])).toMatchObject({ state: 'unavailable', runState: 'unknown' });
  });
  it('accepts a bounded system-authored terminal without treating it as the target agent', () => {
    expect(project([event('agent.run.finished', 'succeeded', { actor: { type: 'system', id: 'scheduler' } })])).toMatchObject({ state: 'recorded', runState: 'completed' });
  });
  it('does not choose between duplicate executions, conflicting terminals, incomplete pages or impossible timing', () => {
    expect(project([event('agent.run.finished', 'succeeded'), event('agent.run.finished', 'failed', { eventId: 'second', errorCode: 'run_failed' })]).state).toBe('ambiguous');
    expect(project([event('agent.run.started', 'started'), event('agent.run.started', 'started', { eventId: 'second' })]).state).toBe('ambiguous');
    expect(project([event('agent.run.finished', 'succeeded')], { nextCursor: 'more' }).state).toBe('unavailable');
    expect(project([event('agent.run.started', 'started'), event('agent.run.finished', 'succeeded', { occurredAt: 50 })]).state).toBe('ambiguous');
  });
  it.each([['cancelled', 'run_cancelled', 'aborted'], ['timed_out', 'run_timed_out', 'failed'], ['failed', 'run_failed', 'failed'], ['blocked', 'run_blocked', 'failed']])('maps native %s using its correlated error code', (status, errorCode, expected) => {
    expect(project([event('agent.run.finished', status, { errorCode })]).runState).toBe(expected);
  });
});
