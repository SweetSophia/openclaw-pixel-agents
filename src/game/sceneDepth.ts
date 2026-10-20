import type { PlacedFurniture } from '../../shared/types';
import { rectanglesOverlap, type FurnitureRectangle } from './furnitureGeometry';

export interface SceneFurniture {
  item: PlacedFurniture;
  rectangle: FurnitureRectangle;
  isSurface: boolean;
  canPlaceOnSurfaces: boolean;
}

export type FurnitureSceneEntry = { kind: 'furniture'; item: PlacedFurniture; depth: number; layer: number };
type SceneEntry<T> = FurnitureSceneEntry | { kind: 'character'; character: T; depth: number; layer: number };

function compareDepth(a: { depth: number; layer: number }, b: { depth: number; layer: number }) {
  return a.depth - b.depth || a.layer - b.layer;
}

/** Placement rows control overlap; tables occlude objects until their lower edge. */
export function furnitureDrawOrder(
  furniture: readonly SceneFurniture[],
): FurnitureSceneEntry[] {
  const surfaces = furniture.filter(entry => entry.isSurface);
  const entries: FurnitureSceneEntry[] = furniture.map(entry => {
    let depth = entry.isSurface ? entry.rectangle.y + entry.rectangle.height : entry.item.y;
    let supported = false;
    if (entry.canPlaceOnSurfaces) {
      // A computer can start above a desk while its keyboard overlaps the top.
      // Keep it with its support, below characters and floor objects in front.
      for (const support of surfaces) {
        if (rectanglesOverlap(entry.rectangle, support.rectangle)) {
          supported = true;
          depth = Math.max(depth, support.rectangle.y + support.rectangle.height);
        }
      }
    }
    return { kind: 'furniture', item: entry.item, depth,
      layer: entry.isSurface ? 0 : supported ? 1 : 2 };
  });
  // Equal-depth tables go behind their supported props and the first floor row.
  // Stable sorting preserves placement order between otherwise equal objects.
  return entries.sort(compareDepth);
}

/** Merge moving characters with cached furniture without repeating support scans. */
export function sceneDrawOrder<T extends { y: number }>(
  furniture: readonly FurnitureSceneEntry[],
  characters: Iterable<T>,
): SceneEntry<T>[] {
  const moving: SceneEntry<T>[] = Array.from(characters, character => ({
    kind: 'character', character, depth: character.y, layer: 3,
  }));
  moving.sort(compareDepth);
  const entries: SceneEntry<T>[] = [];
  let next = 0;
  for (const character of moving) {
    while (next < furniture.length && compareDepth(furniture[next], character) <= 0) {
      entries.push(furniture[next++]);
    }
    entries.push(character);
  }
  while (next < furniture.length) entries.push(furniture[next++]);
  return entries;
}
