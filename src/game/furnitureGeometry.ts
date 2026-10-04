/** Grid-cell geometry around the centre of the stored anchor tile.
 * This describes rendered/navigation footprints, never placement legality.
 */
export interface FurnitureRectangle { x: number; y: number; width: number; height: number }

export function furnitureRectangle(x: number, y: number, w: number, h: number, rawRotation = 0): FurnitureRectangle {
  if (rawRotation % 90 !== 0) throw new RangeError('Furniture rotation must be a quarter turn');
  const rotation = ((rawRotation % 360) + 360) % 360;
  const swapsAxes = rotation === 90 || rotation === 270;
  if (rotation === 90) x += 1 - h;
  else if (rotation === 180) { x += 1 - w; y += 1 - h; }
  else if (rotation === 270) y += 1 - w;
  return { x, y, width: swapsAxes ? h : w, height: swapsAxes ? w : h };
}

export function rectanglesOverlap(a: FurnitureRectangle, b: FurnitureRectangle): boolean {
  return Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x)
    && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
}

export function assessFurniturePreview(
  rectangle: FurnitureRectangle,
  furniture: Array<FurnitureRectangle & { id: string }>,
  gridWidth: number, gridHeight: number, excludeId?: string,
): { overlap: boolean; border: boolean; outside: boolean } {
  const { x, y, width, height } = rectangle;
  return {
    overlap: furniture.some(item => item.id !== excludeId && rectanglesOverlap(rectangle, item)),
    border: x < 1 || y < 1 || x + width > gridWidth - 1 || y + height > gridHeight - 1,
    outside: x < 0 || y < 0 || x + width > gridWidth || y + height > gridHeight,
  };
}
