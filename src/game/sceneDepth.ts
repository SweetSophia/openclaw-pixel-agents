import type { PlacedFurniture } from '../../shared/types';
import { rectanglesOverlap, type FurnitureRectangle } from './furnitureGeometry';

export interface SceneFurniture {
  item: PlacedFurniture;
  rectangle: FurnitureRectangle;
  isSurface: boolean;
  canPlaceOnSurfaces: boolean;
}

type SceneEntry<T> = (
  | { kind: 'furniture'; item: PlacedFurniture }
  | { kind: 'character'; character: T }
) & { depth: number; layer: number };

/** Placement rows control overlap; tables occlude objects until their lower edge. */
export function sceneDrawOrder<T extends { y: number }>(
  furniture: readonly SceneFurniture[],
  characters: Iterable<T>,
): SceneEntry<T>[] {
  const surfaces = furniture.filter(entry => entry.isSurface);
  const entries: SceneEntry<T>[] = furniture.map(entry => {
    let depth = entry.isSurface ? entry.rectangle.y + entry.rectangle.height : entry.item.y;
    if (entry.canPlaceOnSurfaces) {
      // A computer can start above a desk while its keyboard overlaps the top.
      // Keep it with its support, below characters and floor objects in front.
      for (const support of surfaces) {
        if (rectanglesOverlap(entry.rectangle, support.rectangle)) {
          depth = Math.max(depth, support.rectangle.y + support.rectangle.height);
        }
      }
    }
    return { kind: 'furniture', item: entry.item, depth,
      layer: entry.isSurface ? 0 : entry.canPlaceOnSurfaces ? 1 : 2 };
  });
  for (const character of characters) entries.push({ kind: 'character', character, depth: character.y, layer: 3 });
  // Equal-depth tables go behind their supported props and the first floor row.
  // Stable sorting preserves placement order between otherwise equal objects.
  return entries.sort((a, b) => a.depth - b.depth || a.layer - b.layer);
}
