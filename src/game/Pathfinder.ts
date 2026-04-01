/**
 * BFS Pathfinder for grid-based movement
 *
 * Computes shortest paths around obstacles on a tile grid.
 * Used by GameEngine to route characters around furniture.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * Build an obstacle map from furniture positions.
 * Returns a 2D boolean array where true = blocked.
 */
export function buildObstacleMap(
  gridW: number,
  gridH: number,
  furniture: Array<{ x: number; y: number; w: number; h: number }>,
  extraBlocked?: Set<string>,
): boolean[][] {
  const grid: boolean[][] = Array.from({ length: gridH }, () => Array(gridW).fill(false));

  // Block walls (border tiles)
  for (let x = 0; x < gridW; x++) {
    grid[0][x] = true;
    grid[gridH - 1][x] = true;
  }
  for (let y = 0; y < gridH; y++) {
    grid[y][0] = true;
    grid[y][gridW - 1] = true;
  }

  // Block furniture tiles
  for (const item of furniture) {
    for (let dy = 0; dy < item.h; dy++) {
      for (let dx = 0; dx < item.w; dx++) {
        const gx = item.x + dx;
        const gy = item.y + dy;
        if (gy >= 0 && gy < gridH && gx >= 0 && gx < gridW) {
          grid[gy][gx] = true;
        }
      }
    }
  }

  // Extra blocked tiles (e.g. other characters)
  if (extraBlocked) {
    for (const key of extraBlocked) {
      const [sx, sy] = key.split(',').map(Number);
      if (sy >= 0 && sy < gridH && sx >= 0 && sx < gridW) {
        grid[sy][sx] = true;
      }
    }
  }

  return grid;
}

/**
 * BFS shortest path from start to end on a grid.
 * Returns array of waypoints (including end, excluding start), or empty array if unreachable.
 */
export function bfsPathfind(
  obstacleGrid: boolean[][],
  start: Point,
  end: Point,
  gridW: number,
  gridH: number,
): Point[] {
  const sx = Math.round(start.x);
  const sy = Math.round(start.y);
  const ex = Math.round(end.x);
  const ey = Math.round(end.y);

  // Same tile — no path needed
  if (sx === ex && sy === ey) return [];

  // End is blocked — try adjacent tiles
  const targets = findNearestFree(obstacleGrid, ex, ey, gridW, gridH);
  if (targets.length === 0) return [];

  // Start is blocked — try adjacent
  const starts = findNearestFree(obstacleGrid, sx, sy, gridW, gridH);
  if (starts.length === 0) return [{ x: ex, y: ey }]; // fallback

  // BFS from all start positions
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue: Point[] = [];
  const targetSet = new Set(targets.map(t => `${t.x},${t.y}`));

  for (const s of starts) {
    const key = `${s.x},${s.y}`;
    visited.add(key);
    queue.push(s);
    parent.set(key, '');
  }

  const dirs: Point[] = [
    { x: 0, y: -1 }, // up
    { x: 0, y: 1 },  // down
    { x: -1, y: 0 }, // left
    { x: 1, y: 0 },  // right
  ];

  let found: string | null = null;
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    const curKey = `${cur.x},${cur.y}`;

    // Check if we reached any target
    if (targetSet.has(curKey)) {
      found = curKey;
      break;
    }

    for (const d of dirs) {
      const nx = cur.x + d.x;
      const ny = cur.y + d.y;
      const nKey = `${nx},${ny}`;

      if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
      if (visited.has(nKey)) continue;
      if (obstacleGrid[ny]?.[nx]) continue;

      visited.add(nKey);
      parent.set(nKey, curKey);
      queue.push({ x: nx, y: ny });
    }
  }

  if (!found) return [{ x: ex, y: ey }]; // fallback: straight line

  // Reconstruct path
  const path: Point[] = [];
  let key: string | null = found;
  while (key && key !== '') {
    const [px, py] = key.split(',').map(Number);
    path.unshift({ x: px, y: py });
    key = parent.get(key) ?? null;
  }

  // Remove the start position itself
  if (path.length > 0) path.shift();

  return path;
}

/** Find free tiles adjacent to a blocked position */
function findNearestFree(
  grid: boolean[][],
  x: number,
  y: number,
  w: number,
  h: number,
): Point[] {
  // If the position itself is free, return it
  if (y >= 0 && y < h && x >= 0 && x < w && !grid[y][x]) {
    return [{ x, y }];
  }

  // Search in expanding rings
  const dirs = [
    { x: 0, y: -1 }, { x: 0, y: 1 },
    { x: -1, y: 0 }, { x: 1, y: 0 },
    { x: -1, y: -1 }, { x: 1, y: -1 },
    { x: -1, y: 1 }, { x: 1, y: 1 },
  ];

  const results: Point[] = [];
  for (const d of dirs) {
    const nx = x + d.x;
    const ny = y + d.y;
    if (ny >= 0 && ny < h && nx >= 0 && nx < w && !grid[ny][nx]) {
      results.push({ x: nx, y: ny });
    }
  }
  return results;
}
