import { describe, it, expect } from 'vitest';
import { tickSubAgent, SUBAGENT_LIFETIME, SUBAGENT_FADE_DURATION } from './SubAgentFSM';

describe('tickSubAgent', () => {
  it('returns fadeAlpha=1, dying=false, no actions for young sub-agent', () => {
    const tick = tickSubAgent({ spawnTime: 0, dying: false, fadeAlpha: 1 }, 10_000, 0.016);
    expect(tick.fadeAlpha).toBe(1);
    expect(tick.dying).toBe(false);
    expect(tick.actions).toEqual([]);
    expect(tick.shouldRemove).toBe(false);
  });

  it('transitions to dying and emits despawn-sound when age crosses LIFETIME', () => {
    const tick = tickSubAgent(
      { spawnTime: 0, dying: false, fadeAlpha: 1 },
      SUBAGENT_LIFETIME + 1,
      0.016,
    );
    expect(tick.dying).toBe(true);
    expect(tick.actions).toEqual([{ kind: 'despawn-sound' }]);
    // fadeAlpha decreases by dtSec/FADE_DURATION from the moment dying starts
    expect(tick.fadeAlpha).toBeCloseTo(1 - 0.016 / (SUBAGENT_FADE_DURATION / 1000), 5);
    expect(tick.shouldRemove).toBe(false);
  });

  it('does NOT re-emit despawn-sound on subsequent dying ticks', () => {
    const tick = tickSubAgent(
      { spawnTime: 0, dying: true, fadeAlpha: 0.5 },
      16_000,
      0.016,
    );
    expect(tick.dying).toBe(true);
    expect(tick.actions).toEqual([]);
    expect(tick.fadeAlpha).toBeCloseTo(0.5 - 0.016 / (SUBAGENT_FADE_DURATION / 1000), 3);
  });

  it('fades at correct rate: full fade in SUBAGENT_FADE_DURATION seconds', () => {
    const tick = tickSubAgent(
      { spawnTime: 0, dying: true, fadeAlpha: 1 },
      SUBAGENT_LIFETIME + 1,
      SUBAGENT_FADE_DURATION / 1000,
    );
    expect(tick.fadeAlpha).toBeCloseTo(0, 5);
    expect(tick.shouldRemove).toBe(true);
  });

  it('clamps fadeAlpha at 0 when dt exceeds remaining fade time', () => {
    const tick = tickSubAgent(
      { spawnTime: 0, dying: true, fadeAlpha: 0.001 },
      20_000,
      1.0,
    );
    expect(tick.fadeAlpha).toBe(0);
    expect(tick.shouldRemove).toBe(true);
  });

  it('marks shouldRemove when fadeAlpha reaches 0', () => {
    const tick = tickSubAgent(
      { spawnTime: 0, dying: true, fadeAlpha: 0 },
      20_000,
      0.016,
    );
    expect(tick.shouldRemove).toBe(true);
    expect(tick.fadeAlpha).toBe(0);
  });

  it('preserves existing dying state (killSubAgent) without re-emitting sound', () => {
    const tick = tickSubAgent(
      { spawnTime: 0, dying: true, fadeAlpha: 1 },
      5_000,
      0.016,
    );
    expect(tick.dying).toBe(true);
    expect(tick.actions).toEqual([]);
    expect(tick.fadeAlpha).toBeCloseTo(1 - 0.016 / (SUBAGENT_FADE_DURATION / 1000), 3);
  });

  it('emits no despawn-sound at exactly LIFETIME boundary (strict > check)', () => {
    const tick = tickSubAgent(
      { spawnTime: 0, dying: false, fadeAlpha: 1 },
      SUBAGENT_LIFETIME,
      0.016,
    );
    expect(tick.dying).toBe(false);
    expect(tick.actions).toEqual([]);
  });

  it('preserves existing fadeAlpha for non-dying sub-agent (no implicit reset)', () => {
    // The original GameEngine code only set fadeAlpha in the dying branch;
    // non-dying sub-agents retained their prior value. This regression test
    // pins that behavior so future changes don't silently override it.
    const tick = tickSubAgent(
      { spawnTime: 0, dying: false, fadeAlpha: 0.7 },
      1_000, // well under LIFETIME
      0.016,
    );
    expect(tick.dying).toBe(false);
    expect(tick.fadeAlpha).toBe(0.7);
  });
});

describe('SUBAGENT_LIFETIME and SUBAGENT_FADE_DURATION constants', () => {
  it('SUBAGENT_LIFETIME is 15000ms', () => {
    expect(SUBAGENT_LIFETIME).toBe(15_000);
  });
  it('SUBAGENT_FADE_DURATION is 2000ms', () => {
    expect(SUBAGENT_FADE_DURATION).toBe(2_000);
  });
});
