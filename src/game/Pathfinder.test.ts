import { describe, expect, it } from 'vitest';

import { bfsPathfind, buildObstacleMap } from './Pathfinder';

describe('Pathfinder', () => {
  it('searches beyond a blocked target\'s first ring for the nearest free tiles', () => {
    const grid = buildObstacleMap(9, 9, [
      { x: 3, y: 3, w: 3, h: 3 },
    ]);

    const path = bfsPathfind(grid, { x: 1, y: 4 }, { x: 4, y: 4 }, 9, 9);

    expect(path[path.length - 1]).toEqual({ x: 2, y: 4 });
    expect(path.every(({ x, y }) => !grid[y][x])).toBe(true);
  });

  it('returns no route when a free target is sealed behind obstacles', () => {
    const grid = buildObstacleMap(9, 9, []);
    for (let y = 3; y <= 5; y++) {
      for (let x = 3; x <= 5; x++) {
        if (x !== 4 || y !== 4) grid[y][x] = true;
      }
    }

    expect(bfsPathfind(grid, { x: 1, y: 4 }, { x: 4, y: 4 }, 9, 9)).toEqual([]);
  });

  it.each([
    { rotation: 0, blocked: ['4,4', '5,4'] },
    { rotation: 90, blocked: ['4,4', '4,5'] },
    { rotation: 180, blocked: ['3,4', '4,4'] },
    { rotation: 270, blocked: ['4,3', '4,4'] },
  ])('rotates a 2x1 obstacle footprint and origin by $rotation degrees', ({ rotation, blocked }) => {
    const furniture = [{ x: 4, y: 4, w: 2, h: 1, rotation }];

    const grid = buildObstacleMap(9, 9, furniture);
    const blockedNearFurniture: string[] = [];
    for (let y = 2; y <= 6; y++) {
      for (let x = 2; x <= 6; x++) {
        if (grid[y][x]) blockedNearFurniture.push(`${x},${y}`);
      }
    }

    expect(blockedNearFurniture).toEqual(blocked);
  });

  it('rejects obstacle rotations outside the validated quarter turns', () => {
    expect(() => buildObstacleMap(9, 9, [
      { x: 4, y: 4, w: 2, h: 1, rotation: 45 },
    ])).toThrow(/quarter turn/i);
  });
});
