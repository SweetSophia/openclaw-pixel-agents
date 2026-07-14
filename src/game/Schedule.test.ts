import { describe, it, expect } from 'vitest';
import { getDayPhase } from './Schedule';

describe('Schedule.getDayPhase', () => {
  it('returns exact Morning values at progress=0', () => {
    const phase = getDayPhase(0);
    expect(phase.r).toBe(255);
    expect(phase.g).toBe(200);
    expect(phase.b).toBe(100);
    expect(phase.alpha).toBeCloseTo(0.06, 5);
    expect(phase.light).toBeCloseTo(0.95, 5);
    expect(phase.label).toBe('Morning');
  });

  it('interpolates Sunset→Dusk at progress=0.5 with label=Dusk (t<0.5 rule)', () => {
    // idx = 0.5 * 7 = 3.5 → i=3 (Sunset), j=4 (Dusk), t=0.5
    // The label rule is t < 0.5 ? a.label : b.label → t=0.5 selects b (Dusk)
    const phase = getDayPhase(0.5);
    expect(phase.r).toBe(158); // round(255 + (60-255)*0.5) = round(157.5)
    expect(phase.g).toBe(70);  // round(100 + (40-100)*0.5)
    expect(phase.b).toBe(75);  // round(30 + (120-30)*0.5)
    expect(phase.alpha).toBeCloseTo(0.135, 3);
    expect(phase.light).toBeCloseTo(0.65, 5);
    expect(phase.label).toBe('Dusk');
  });

  it('pins the t<0.5 label quirk: at t=0.999 the interpolated color is Late Night but label flips to Morning', () => {
    // idx = 0.999 * 7 = 6.993 → i=6 (Late Night), j=0 (Morning), t=0.993
    // Visual state is near Late Night, but label rule selects b=Morning
    const phase = getDayPhase(0.999);
    expect(phase.r).toBeGreaterThan(240); // nearly back to Morning's 255
    expect(phase.label).toBe('Morning'); // pinned: the t<0.5 quirk
  });

  it('wraps: getDayPhase(1) equals getDayPhase(0) (modulo 1 invariant)', () => {
    // The engine reduces dayPhase by mod 1 before calling, but the function
    // must handle the boundary at progress=1 cleanly.
    const phase = getDayPhase(1);
    expect(phase.r).toBe(255);
    expect(phase.g).toBe(200);
    expect(phase.b).toBe(100);
    expect(phase.alpha).toBeCloseTo(0.06, 5);
    expect(phase.label).toBe('Morning');
  });

  it('at integer index boundaries, label is the a-phase label (no interpolation)', () => {
    // progress = 1/7 → idx = 1.0 exactly → t = 0 → label = a.label = 'Midday'
    const phase = getDayPhase(1 / 7);
    expect(phase.r).toBe(255);
    expect(phase.g).toBe(255);
    expect(phase.b).toBe(240);
    expect(phase.alpha).toBeCloseTo(0.02, 5);
    expect(phase.label).toBe('Midday');
  });

  it('alpha is formatted to 3 decimal places (toFixed(3) invariant)', () => {
    // At progress=0.5, alpha = 0.12 + (0.15-0.12)*0.5 = 0.135 → '0.135'
    const phase = getDayPhase(0.5);
    // Pin the exact string to catch any formatting regression
    expect(phase.alpha.toString()).toMatch(/^0\.135$/);
    // And the overlay string embeds the formatted alpha
    expect(phase.overlay).toContain('0.135');
  });
});
