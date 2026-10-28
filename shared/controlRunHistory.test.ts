import { describe, expect, it } from 'vitest';
import { isControlRunId } from './controlRunHistory';

describe('control run identity', () => {
  it.each(['run\u202e321', 'run\u2066hidden\u2069'])('rejects bidirectional formatting controls in %j', value => {
    expect(isControlRunId(value)).toBe(false);
  });

  it('keeps ordinary opaque native identifiers valid', () => {
    expect(isControlRunId('run:agent-a/2026-10-28_01')).toBe(true);
  });
});
