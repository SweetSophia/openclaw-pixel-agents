import { describe, expect, it } from 'vitest';
import { parseControlUsageSnapshot } from './controlUsage';

const snapshot = () => ({ target: { agentId: 'cylena', sessionKey: 'agent:cylena:usage', sessionId: 'instance-1' },
  source: { state: 'current', observedAt: 2000 }, state: 'ready', tokens: { input: 0, output: 12 }, cost: {}, contextLimit: 128000 });
describe('private usage contract', () => {
  it('preserves explicit zero without filling in missing counters, costs or occupied context', () => {
    const value = parseControlUsageSnapshot(snapshot());
    expect(value?.tokens).toEqual({ input: 0, output: 12 }); expect(value?.cost).toEqual({});
    expect(value).not.toHaveProperty('contextUsed'); expect(value).not.toHaveProperty('computedAt');
  });
  it.each([-1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid token count %s', count => {
    expect(parseControlUsageSnapshot({ ...snapshot(), tokens: { input: count } })).toBeNull();
  });
  it('rejects unexpected/private fields, reserved keys and invalid timestamps', () => {
    for (const patch of [{ transcriptPath: '/private' }, { computedAt: -1 }, { computedAt: Number.MAX_SAFE_INTEGER }, { state: ['ready'] }, { state: 'complete' }, { cost: { usd: Infinity } }, { source: { state: 'current', observedAt: -1 } }]) {
      expect(parseControlUsageSnapshot({ ...snapshot(), ...patch })).toBeNull();
    }
    expect(parseControlUsageSnapshot({ ...snapshot(), tokens: JSON.parse('{"__proto__":{},"input":0}') })).toBeNull();
  });
});
