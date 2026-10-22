import { describe, expect, it } from 'vitest';
import { fitScale, boundView, zoomView } from './viewportGeometry';

const world = { width: 768, height: 512 };

describe('office viewport geometry', () => {
  it('fits the complete office into either narrow or short available space', () => {
    expect(fitScale({ width: 320, height: 600 }, world)).toBeCloseTo(320 / 768);
    expect(fitScale({ width: 1000, height: 256 }, world)).toBe(0.5);
  });

  it('keeps collapsed initial measurements finite', () => {
    expect(fitScale({ width: 0, height: 0 }, world)).toBe(0);
    expect(boundView({ zoom: 2, x: 100, y: -100 }, { width: 0, height: 0 }, world)).toEqual({ zoom: 2, x: 0, y: 0 });
  });

  it('centers fitted content and prevents panning it off screen', () => {
    expect(boundView({ zoom: 1, x: 200, y: -500 }, { width: 768, height: 512 }, world)).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it('clamps both axes so every edge remains reachable at maximum zoom', () => {
    expect(boundView({ zoom: 9, x: 9999, y: -9999 }, world, world)).toEqual({ zoom: 4, x: 1152, y: -768 });
  });

  it('keeps an off-center point fixed while zooming', () => {
    const point = { x: 100, y: -50 };
    const view = zoomView({ zoom: 2, x: 20, y: 10 }, 1.5, point, world, world);
    expect(view).toEqual({ zoom: 3, x: -20, y: 40 });
    expect((point.x - view.x) / view.zoom).toBe((point.x - 20) / 2);
    expect((point.y - view.y) / view.zoom).toBe((point.y - 10) / 2);
  });

  it('returns to centered Fit at minimum zoom and clamps offsets after resize', () => {
    expect(zoomView({ zoom: 2, x: 100, y: 50 }, 0.1, { x: 50, y: 40 }, world, world)).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(boundView({ zoom: 2, x: 700, y: -500 }, { width: 320, height: 600 }, world)).toEqual({ zoom: 2, x: 160, y: 0 });
  });
});
