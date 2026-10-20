import type { Point } from './Pathfinder';
import type { FurnitureRectangle } from './furnitureGeometry';

interface DeskFootprint extends FurnitureRectangle { rotation: number }

/** Resolve seats to nearby reachable floor, keeping legacy desk anchors in front of desks. */
export function resolveSeatPosition(
  anchor: Point,
  desks: readonly DeskFootprint[],
  obstacles: readonly (readonly boolean[])[],
  reserved: ReadonlySet<string>,
  reachable?: ReadonlySet<string>,
): Point {
  if (obstacles[anchor.y]?.[anchor.x] === false && (!reachable || reachable.has(`${anchor.x},${anchor.y}`))) return { ...anchor };

  const desk = desks.find(item => anchor.x >= item.x && anchor.x < item.x + item.width
    && anchor.y >= item.y && anchor.y < item.y + item.height);
  let preferred = anchor;
  if (desk) {
    const centerX = desk.x + Math.floor((desk.width - 1) / 2);
    const centerY = desk.y + Math.floor((desk.height - 1) / 2);
    switch (((desk.rotation % 360) + 360) % 360) {
      case 90: preferred = { x: desk.x - 1, y: centerY }; break;
      case 180: preferred = { x: centerX, y: desk.y - 1 }; break;
      case 270: preferred = { x: desk.x + desk.width, y: centerY }; break;
      default: preferred = { x: centerX, y: desk.y + desk.height };
    }
  }

  let closest: Point | null = null;
  let distance = Infinity;
  let closestReserved: Point | null = null;
  let reservedDistance = Infinity;
  for (let y = 0; y < obstacles.length; y++) {
    for (let x = 0; x < obstacles[y].length; x++) {
      if (obstacles[y][x] || (reachable && !reachable.has(`${x},${y}`))) continue;
      const nextDistance = (x - preferred.x) ** 2 + (y - preferred.y) ** 2;
      if (reserved.has(`${x},${y}`)) {
        if (nextDistance < reservedDistance) {
          closestReserved = { x, y };
          reservedDistance = nextDistance;
        }
      } else if (nextDistance < distance) {
        closest = { x, y };
        distance = nextDistance;
      }
    }
  }
  // If all floor positions are reserved, sharing floor is safer than using furniture.
  // A completely blocked layout has no floor destination; keep its configured point.
  return closest ?? closestReserved ?? { ...anchor };
}
