import { describe, expect, it } from 'vitest';
import { projectSession, projectTask } from './projection';

const target = { agentId: 'cylena', sessionKey: 'agent:cylena:test', sessionId: 'session-1' };
const message = (role: string, content: unknown[], runId = 'run-1', extra = {}) => ({
  role, content, timestamp: 110, __openclaw: { id: `${role}-${runId}-${JSON.stringify(content).length}`, runId }, ...extra,
});
const base = (session = {}, history = {}) => ({
  target, session: { key: target.sessionKey, agentId: target.agentId, sessionId: target.sessionId, ...session },
  history: { sessionKey: target.sessionKey, sessionId: target.sessionId, messages: [], ...history },
  children: [], childrenComplete: false, loadedRecords: 50, observedAt: 200,
});
const user = (text = 'Review this form', runId = 'run-1') => message('user', [{ type: 'text', text }], runId);
const answer = (runId = 'run-1', stopReason = 'stop') => message('assistant', [{ type: 'text', text: 'Finished the review.' }], runId, { stopReason });

describe('source-backed task projection', () => {
  it('reports aggregate running without inventing a current run identity', () => {
    const result = projectTask(base({ hasActiveRun: true }, { messages: [user('Previous request', 'older-run')] }));
    expect(result.runState).toBe('running');
    expect(result.runId).toBeUndefined();
    expect(result.activeRunIds).toBeUndefined();
    expect(result.requestAssociation).toBe('latest-recorded');
    expect(result.request?.text).toBe('Previous request');
  });

  it('preserves false, null, and the complete empty exact run set', () => {
    expect(projectTask(base({ hasActiveRun: false, activeRunIds: [] })).activeRunIds).toEqual([]);
    expect(projectTask(base({ hasActiveRun: false })).runState).toBe('unknown');
    expect(projectTask(base()).hasActiveRun).toBeNull();
    expect(projectTask(base({ hasActiveRun: true, activeRunIds: ['unowned-run'] })).runId).toBeUndefined();
  });

  it('selects the explicit in-flight run and correlates only its request and response', () => {
    const result = projectTask(base({ hasActiveRun: true }, {
      inFlightRun: { runId: 'run-1', startedAt: 100 },
      messages: [user('Old request', 'older'), user(), answer('older'), answer('run-1', 'toolUse')],
    }));
    expect(result).toMatchObject({ runId: 'run-1', runState: 'running', startedAt: 100, requestAssociation: 'run' });
    expect(result.request?.text).toBe('Review this form');
    expect(result.latestResponse?.runId).toBe('run-1');
    expect(result.result).toBeUndefined();
  });

  it('does not use a tool failure as the overall outcome of a completed run', () => {
    const result = projectTask(base({ hasActiveRun: false, lastRunId: 'run-1', status: 'completed', startedAt: 100, endedAt: 150 }, {
      messages: [user(), message('assistant', [{ type: 'toolCall', id: 'call-1', name: 'exec', arguments: { command: 'fixture-secret' } }]),
        message('toolResult', [{ type: 'text', text: 'fixture-secret' }], 'run-1', { toolCallId: 'call-1', isError: true }), answer()],
    }));
    expect(result.runState).toBe('completed');
    expect(result.activity[0]).toMatchObject({ toolCallId: 'call-1', toolName: 'exec', outcome: 'error' });
    expect(result.result?.text).toBe('Finished the review.');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });

  it('keeps inactive identified work distinct from a proven terminal outcome', () => {
    expect(projectTask(base({ hasActiveRun: false, lastRunId: 'run-1' })).runState).toBe('not-running');
    expect(projectTask(base({ hasActiveRun: false, lastRunId: 'run-1', abortedLastRun: true })).runState).toBe('aborted');
    const result = projectTask(base({ hasActiveRun: false, lastRunId: 'run-1', status: 'completed' }, { messages: [answer('run-1', 'toolUse')] }));
    expect(result.result).toBeUndefined();
  });

  it('never associates a result through an ambiguous concatenated run/call identity', () => {
    const result = projectTask(base({ hasActiveRun: true }, {
      inFlightRun: { runId: 'run:one' }, messages: [
        message('assistant', [{ type: 'toolCall', id: 'call:two', name: 'exec' }], 'run:one'),
        message('toolResult', [{ type: 'text', text: 'Unrelated result' }], 'run', { toolCallId: 'one:call:two', isError: false }),
      ],
    }));
    expect(result.activity[0].outcome).toBe('pending');
  });

  it('discards private reasoning, system messages, raw arguments and source diagnostics', () => {
    const result = projectTask(base({ hasActiveRun: true, path: '/private/fixture', diagnostics: 'fixture-secret' }, {
      inFlightRun: { runId: 'run-1' },
      messages: [message('system', [{ type: 'text', text: 'fixture-secret' }]), message('assistant', [
        { type: 'thinking', thinking: 'fixture-secret' }, { type: 'text', text: 'Checking the form.' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'fixture-secret' } },
      ])],
    }));
    expect(result.latestResponse?.text).toBe('Checking the form.');
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|private\/fixture|diagnostics|thinking/);
  });

  it('reports a request outside a tool-only window as not loaded', () => {
    const messages = Array.from({ length: 50 }, (_, i) => message('assistant', [{ type: 'toolCall', id: `call-${i}`, name: 'read' }]));
    const result = projectTask({ ...base({ hasActiveRun: true }, { inFlightRun: { runId: 'run-1' }, messages }), nextCursor: 'cursor-1' });
    expect(result.requestState).toBe('not-loaded');
    expect(result.request).toBeUndefined();
    expect(result.nextCursor).toBe('cursor-1');
    expect(result.activity).toHaveLength(50);
    expect(result.activity[0].outcome).toBe('pending');
    expect(projectTask({ ...base({}, { messages }), loadedRecords: 2000 }).requestState).toBe('limit-reached');
  });
  it('labels earlier-run context separately from an unloaded current request', () => {
    const result = projectTask(base({ hasActiveRun: true }, { inFlightRun: { runId: 'run-1' }, messages: [user('Older context', 'run-0')], hasMore: true }));
    expect(result.requestAssociation).toBe('latest-recorded'); expect(result.requestState).toBe('not-loaded');
  });

  it('clips display text explicitly and stays below the total UTF-8 byte budget', () => {
    const result = projectTask(base({ hasActiveRun: true }, {
      inFlightRun: { runId: 'run-1' }, messages: [user('😀'.repeat(16001))],
    }));
    expect(result.request?.truncated).toBe(true);
    expect(result.request!.text.length).toBeLessThanOrEqual(16000);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(256 * 1024);
  });

  it('rejects mismatched source generations and poisoned records', () => {
    expect(() => projectTask(base({}, { sessionId: 'replacement-session' }))).toThrow();
    expect(() => projectTask({ ...base(), session: JSON.parse('{"__proto__":{},"sessionId":"session-1"}') })).toThrow();
  });

  it('projects bounded session choices, never guessing ownership or timestamps', () => {
    const row = projectSession({ key: target.sessionKey, agentId: 'cylena', sessionId: 'session-1', displayName: 'Telegram', hasActiveRun: true, modelProvider: 'fixture', model: 'model', path: '/private/fixture' }, 'cylena');
    expect(row).toMatchObject({ ...target, name: 'Telegram', isChild: false, hasActiveRun: true, model: 'fixture/model' });
    expect(row).not.toHaveProperty('path');
    expect(projectSession({ key: 'agent:other:test', agentId: 'other', sessionId: 'session-1' }, 'cylena')).toBeNull();
    expect(projectSession({ key: target.sessionKey, agentId: 'cylena', sessionId: 'session-1', updatedAt: -1 }, 'cylena')?.updatedAt).toBeUndefined();
  });
});
