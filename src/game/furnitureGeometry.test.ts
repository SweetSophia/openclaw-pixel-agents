import { describe, expect, it } from 'vitest';
import { furnitureRectangle, rectanglesOverlap, assessFurniturePreview } from './furnitureGeometry';
import { buildObstacleMap } from './Pathfinder';

describe('anchor-tile pivot geometry', () => {
  for (const [w, h] of [[3, 2], [2, 3], [2, 2], [1, 1], [2, 1]]) {
    const expected = [[5, 5, w, h], [6 - h, 5, h, w], [6 - w, 6 - h, w, h], [5, 6 - w, h, w]];
    for (const [index, rotation] of [0, 90, 180, 270].entries()) {
      it(`${w}x${h} at ${rotation} preserves exact origin and obstacle cells`, () => {
        const r = furnitureRectangle(5, 5, w, h, rotation);
        expect([r.x, r.y, r.width, r.height]).toEqual(expected[index]);
        const grid = buildObstacleMap(12, 12, [{ x: 5, y: 5, w, h, rotation }]);
        for (let y = 1; y < 11; y++) for (let x = 1; x < 11; x++) {
          expect(grid[y][x]).toBe(x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
        }
      });
    }
  }
  it('normalizes quarter turns and preserves rejection', () => {
    expect(furnitureRectangle(5, 5, 3, 2, -90)).toEqual(furnitureRectangle(5, 5, 3, 2, 270));
    expect(furnitureRectangle(5, 5, 3, 2, 450)).toEqual(furnitureRectangle(5, 5, 3, 2, 90));
    for (const rotation of [45, NaN, Infinity]) expect(() => furnitureRectangle(0, 0, 2, 1, rotation)).toThrow(RangeError);
  });
  it('uses positive area, excludes the dragged item and describes bounds without legality', () => {
    const r = furnitureRectangle(2, 2, 3, 2);
    expect(rectanglesOverlap(r, furnitureRectangle(5, 2, 2, 1))).toBe(false);
    expect(rectanglesOverlap(r, furnitureRectangle(4, 3, 2, 1))).toBe(true);
    expect(assessFurniturePreview(r, [{ id: 'self', ...r }], 24, 16, 'self')).toEqual({ overlap: false, border: false, outside: false });
    expect(assessFurniturePreview(furnitureRectangle(23, 0, 2, 1), [], 24, 16)).toEqual({ overlap: false, border: true, outside: true });
    expect(assessFurniturePreview(r, [{ id: 'decor', ...r }, { id: 'table', ...r }], 24, 16).overlap).toBe(true);
  });
});
