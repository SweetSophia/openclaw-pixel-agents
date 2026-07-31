/**
 * Day/Night cycle schedule and color interpolation.
 *
 * Extracted from `src/game/GameEngine.ts` so the interpolation logic can be
 * unit-tested without spinning a canvas. Pure function over a module-scope
 * constant; no side effects, no DOM, no canvas.
 */

export interface DayPhase {
  /** RGBA overlay color */
  overlay: string;
  /** Ambient light intensity 0-1 */
  light: number;
  /** Label */
  label: string;
}

interface ParsedDayPhase {
  r: number; g: number; b: number; a: number;
  light: number;
  label: string;
}

// `readonly` enforces array-shape immutability at compile time: the table
// cannot be reassigned or structurally mutated (push/splice/index-assign).
// Element fields (DayPhase.overlay, .light, .label) remain mutable under
// shallow readonly — deep-readonly typing (readonly fields / DeepReadonly) is tracked in #132.
export const DAY_PHASES: readonly DayPhase[] = [
  { overlay: 'rgba(255, 200, 100, 0.06)', light: 0.95, label: 'Morning' },
  { overlay: 'rgba(255, 255, 240, 0.02)', light: 1.0, label: 'Midday' },
  { overlay: 'rgba(255, 160, 60, 0.08)', light: 0.9, label: 'Afternoon' },
  { overlay: 'rgba(255, 100, 30, 0.12)', light: 0.75, label: 'Sunset' },
  { overlay: 'rgba(60, 40, 120, 0.15)', light: 0.55, label: 'Dusk' },
  { overlay: 'rgba(10, 10, 50, 0.25)', light: 0.35, label: 'Night' },
  { overlay: 'rgba(15, 10, 40, 0.3)', light: 0.25, label: 'Late Night' },
];

const PARSED_PHASES: readonly ParsedDayPhase[] = DAY_PHASES.map(p => {
  const [r, g, b, a] = parseRgbaStatic(p.overlay);
  return { r, g, b, a, light: p.light, label: p.label };
});

function parseRgbaStatic(s: string): [number, number, number, number] {
  const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (!m) return [0, 0, 0, 0];
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), m[4] !== undefined ? parseFloat(m[4]) : 1];
}

export interface InterpolatedDayPhase {
  r: number;
  g: number;
  b: number;
  alpha: number;
  light: number;
  label: string;
  overlay: string;
}

/**
 * Interpolate the current day phase for the given progress (0-1).
 * Exposed for tests; callers should pass progress mod 1 if cycling.
 */
export function getDayPhase(progress: number): InterpolatedDayPhase {
  const idx = progress * PARSED_PHASES.length;
  const i = Math.floor(idx) % PARSED_PHASES.length;
  const j = (i + 1) % PARSED_PHASES.length;
  const t = idx - Math.floor(idx);

  const a = PARSED_PHASES[i];
  const b = PARSED_PHASES[j];

  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const blue = Math.round(a.b + (b.b - a.b) * t);
  const alpha = +(a.a + (b.a - a.a) * t).toFixed(3);

  return {
    r,
    g,
    b: blue,
    alpha,
    overlay: `rgba(${r}, ${g}, ${blue}, ${alpha})`,
    light: a.light + (b.light - a.light) * t,
    label: t < 0.5 ? a.label : b.label,
  };
}
