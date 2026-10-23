/** MetroCity source sheets use square 32px animation frames. */
export const METROCITY_FRAME_SIZE = 32;

/** Preserve accepted legacy recipes when their hairstyle is absent from the loaded sheet. */
export function resolveHairRow(hairIndex: number, sheetHeight: number): number {
  const lastRow = Math.max(0, Math.floor(sheetHeight / METROCITY_FRAME_SIZE) - 1);
  return Math.min(hairIndex, lastRow);
}
