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
  furniture: Array<{ x: number; y: number; w: number; h: number; rotation?: number }>,
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
    const rawRotation = item.rotation ?? 0;
    if (rawRotation % 90 !== 0) {
      throw new RangeError('Furniture rotation must be a quarter turn');
    }
    const rotation = ((rawRotation % 360) + 360) % 360;
    const swapsAxes = rotation === 90 || rotation === 270;
    const footprintW = swapsAxes ? item.h : item.w;
    const footprintH = swapsAxes ? item.w : item.h;
    let originX = item.x;
    let originY = item.y;

    // Furniture is rendered around the centre of its anchor tile, so the
    // obstacle origin must move around that same pivot on quarter turns.
    if (rotation === 90) {
      originX += 1 - item.h;
    } else if (rotation === 180) {
      originX += 1 - item.w;
      originY += 1 - item.h;
    } else if (rotation === 270) {
      originY += 1 - item.w;
    }

    for (let dy = 0; dy < footprintH; dy++) {
      for (let dx = 0; dx < footprintW; dx++) {
        const gx = originX + dx;
        const gy = originY + dy;
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
  if (starts.length === 0) return [];

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

  if (!found) return [];

  // Reconstruct path
  const path: Point[] = [];
  let key: string | null = found;
  while (key && key !== '') {
    const [px, py] = key.split(',').map(Number);
    path.unshift({ x: px, y: py });
    key = parent.get(key) ?? null;
  }

  // Remove the actual start position, but retain a nearest-free tile used to
  // escape when the rounded character origin itself is blocked.
  if (path[0]?.x === sx && path[0]?.y === sy) path.shift();

  return path;
}

/** Find all free tiles on the nearest Chebyshev-distance ring. */
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

  for (let radius = 1; radius <= Math.max(w, h); radius++) {
    const results: Point[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;

        const nx = x + dx;
        const ny = y + dy;
        if (ny >= 0 && ny < h && nx >= 0 && nx < w && !grid[ny][nx]) {
          results.push({ x: nx, y: ny });
        }
      }
    }
    if (results.length > 0) return results;
  }
  return [];
}
