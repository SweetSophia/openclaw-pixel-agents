/** Canonical asset IDs shared by the catalog, layout validator, and sprite loader. */
export const FURNITURE_TYPES = [
  'BIN', 'BOOKSHELF', 'CACTUS', 'CLOCK', 'COFFEE', 'COFFEE_TABLE',
  'CUSHIONED_BENCH', 'CUSHIONED_CHAIR', 'DESK', 'DOUBLE_BOOKSHELF',
  'HANGING_PLANT', 'LARGE_PAINTING', 'LARGE_PLANT', 'PC', 'PLANT',
  'PLANT_2', 'POT', 'SMALL_PAINTING', 'SMALL_PAINTING_2', 'SMALL_TABLE',
  'SOFA', 'TABLE_FRONT', 'WHITEBOARD', 'WOODEN_BENCH', 'WOODEN_CHAIR',
] as const;

const knownTypes = new Set<string>(FURNITURE_TYPES);

/** Resolve legacy names after validation; retain unknown IDs for the fallback. */
export function canonicalFurnitureType(type: string): string {
  const upper = type.toUpperCase();
  if (upper === 'CHAIR') return 'CUSHIONED_CHAIR';
  if (upper === 'MONITOR') return 'PC';
  return knownTypes.has(upper) ? upper : type;
}
