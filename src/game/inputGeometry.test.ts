import { describe, expect, expectTypeOf, it } from 'vitest';

import { screenToGrid, touchDistance, type CanvasMetrics, type ClientPoint } from './inputGeometry';

const BASE_METRICS: CanvasMetrics = {
  rect: { left: 10, top: 20, width: 240, height: 160 },
  canvasWidth: 240,
  canvasHeight: 160,
  tileSize: 10,
};

describe('screenToGrid', () => {
  it('maps client coordinates when the CSS box matches the canvas aspect ratio', () => {
    expect(screenToGrid(35, 55, BASE_METRICS)).toEqual({ gridX: 2, gridY: 3 });
  });

  it('accounts for CSS scaling', () => {
    const metrics: CanvasMetrics = {
      ...BASE_METRICS,
      rect: { left: 10, top: 20, width: 480, height: 320 },
    };

    expect(screenToGrid(110, 80, metrics)).toEqual({ gridX: 5, gridY: 3 });
  });

  it('rejects points in pillarbox bars', () => {
    const metrics: CanvasMetrics = {
      ...BASE_METRICS,
      rect: { left: 10, top: 20, width: 300, height: 160 },
    };

    expect(screenToGrid(39, 40, metrics)).toBeNull();
    expect(screenToGrid(40, 40, metrics)).toEqual({ gridX: 0, gridY: 2 });
  });

  it('rejects points in letterbox bars', () => {
    const metrics: CanvasMetrics = {
      ...BASE_METRICS,
      rect: { left: 10, top: 20, width: 240, height: 200 },
    };

    expect(screenToGrid(30, 39, metrics)).toBeNull();
    expect(screenToGrid(30, 40, metrics)).toEqual({ gridX: 2, gridY: 0 });
  });

  it('preserves the inclusive right and bottom rendered-edge behavior', () => {
    expect(screenToGrid(250, 180, BASE_METRICS)).toEqual({ gridX: 24, gridY: 16 });
  });
});

describe('touchDistance', () => {
  it('returns Euclidean distance between client points', () => {
    expect(touchDistance({ clientX: 1, clientY: 2 }, { clientX: 4, clientY: 6 })).toBe(5);
  });
});

describe('inputGeometry pure-module contract (issue #82 + #132)', () => {
  it('screenToGrid accepts a deep-Readonly<CanvasMetrics> (compile-time contract, issue #132)', () => {
    // The assertion compares against an inline literal with `readonly` at every
    // field level — including the nested ScreenRect — so reverting ANY
    // `readonly` modifier on CanvasMetrics, ScreenRect, or the array itself
    // fails `tsc --noEmit` (test files are typechecked via tsconfig.test.json
    // — see #129). The inline literal pins the deep contract.
    expectTypeOf(screenToGrid).parameter(2).toEqualTypeOf<Readonly<{
      rect: {
        readonly left: number;
        readonly top: number;
        readonly width: number;
        readonly height: number;
      };
      readonly canvasWidth: number;
      readonly canvasHeight: number;
      readonly tileSize: number;
    }>>();
  });

  it('touchDistance accepts Readonly<ClientPoint> for both params (compile-time no-mutation contract)', () => {
    // ClientPoint is flat / primitive-only, so Readonly<ClientPoint> is
    // effectively deep — inline literal pins the readonly modifier on each
    // primitive field so reverting them fails tsc.
    expectTypeOf(touchDistance).parameter(0).toEqualTypeOf<Readonly<{
      readonly clientX: number;
      readonly clientY: number;
    }>>();
    expectTypeOf(touchDistance).parameter(1).toEqualTypeOf<Readonly<{
      readonly clientX: number;
      readonly clientY: number;
    }>>();
  });

  it('screenToGrid returns a fresh GridPoint per call (no shared aliasing, issue #132 parity)', () => {
    // Mirrors the no-aliasing guards in Schedule.test.ts and SubAgentFSM.test.ts.
    // screenToGrid always constructs a fresh { gridX, gridY } literal (inputGeometry.ts),
    // so distinct calls must return distinct references — and mutating one must
    // not affect a subsequent call. Pin non-null so a future regression that
    // returns null for these coords is caught.
    const a = screenToGrid(35, 55, BASE_METRICS);
    const b = screenToGrid(35, 55, BASE_METRICS);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    (a as { gridX: number }).gridX = -999;
    const c = screenToGrid(35, 55, BASE_METRICS);
    expect(c).not.toBeNull();
    expect((c as { gridX: number }).gridX).not.toBe(-999);
  });
});
