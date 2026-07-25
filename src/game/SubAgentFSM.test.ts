import { describe, it, expect } from 'vitest';
import { tickSubAgent, SUBAGENT_FADE_DURATION } from './SubAgentFSM';

describe('tickSubAgent', () => {
  it('returns fadeAlpha unchanged, dying=false, shouldRemove=false for a live sub-agent', () => {
    const tick = tickSubAgent({ dying: false, fadeAlpha: 1 }, 0.016);
    expect(tick.fadeAlpha).toBe(1);
    expect(tick.dying).toBe(false);
    expect(tick.shouldRemove).toBe(false);
  });

  it('never ages a live sub-agent into dying (issue #102 regression pin)', () => {
    // The pre-fix FSM transitioned to dying once nowMs - spawnTime crossed
    // SUBAGENT_LIFETIME, which made the engine a second lifecycle owner and
    // caused the remove-and-respawn loop for long-running sub-agents. The
    // tick signature no longer accepts time-of-day or spawn time at all, so
    // age-based death is unrepresentable; this pin guards against its return.
    let state = { dying: false, fadeAlpha: 1 };
    for (let i = 0; i < 10_000; i++) {
      const tick = tickSubAgent(state, 0.1);
      expect(tick.dying).toBe(false);
      expect(tick.shouldRemove).toBe(false);
      state = { dying: tick.dying, fadeAlpha: tick.fadeAlpha };
    }
    expect(state.fadeAlpha).toBe(1);
  });

  it('preserves existing fadeAlpha for a live sub-agent (no implicit reset)', () => {
    const tick = tickSubAgent({ dying: false, fadeAlpha: 0.7 }, 0.016);
    expect(tick.dying).toBe(false);
    expect(tick.fadeAlpha).toBe(0.7);
  });

  it('fades a dying sub-agent at the correct rate: full fade in SUBAGENT_FADE_DURATION', () => {
    const tick = tickSubAgent({ dying: true, fadeAlpha: 1 }, SUBAGENT_FADE_DURATION / 1000);
    expect(tick.dying).toBe(true);
    expect(tick.fadeAlpha).toBeCloseTo(0, 5);
    expect(tick.shouldRemove).toBe(true);
  });

  it('fades monotonically across dying ticks', () => {
    const first = tickSubAgent({ dying: true, fadeAlpha: 0.5 }, 0.016);
    expect(first.fadeAlpha).toBeCloseTo(0.5 - 0.016 / (SUBAGENT_FADE_DURATION / 1000), 5);
    expect(first.shouldRemove).toBe(false);
    const second = tickSubAgent({ dying: true, fadeAlpha: first.fadeAlpha }, 0.016);
    expect(second.fadeAlpha).toBeLessThan(first.fadeAlpha);
  });

  it('clamps fadeAlpha at 0 when dt exceeds remaining fade time', () => {
    const tick = tickSubAgent({ dying: true, fadeAlpha: 0.001 }, 1.0);
    expect(tick.fadeAlpha).toBe(0);
    expect(tick.shouldRemove).toBe(true);
  });

  it('marks shouldRemove when fadeAlpha reaches 0', () => {
    const tick = tickSubAgent({ dying: true, fadeAlpha: 0 }, 0.016);
    expect(tick.shouldRemove).toBe(true);
    expect(tick.fadeAlpha).toBe(0);
  });
});

describe('SUBAGENT_FADE_DURATION constant', () => {
  it('is 2000ms', () => {
    expect(SUBAGENT_FADE_DURATION).toBe(2_000);
  });
});
