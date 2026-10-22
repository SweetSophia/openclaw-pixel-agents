export interface Size { width: number; height: number }
export interface View { zoom: number; x: number; y: number }
export const MAX_VIEW_ZOOM = 4;

export function fitScale(available: Size, world: Size): number {
  if (available.width <= 0 || available.height <= 0) return 0;
  return Math.min(available.width / world.width, available.height / world.height);
}

/** Pan is measured in CSS pixels from the fitted center. */
export function boundView(view: View, available: Size, world: Size): View {
  const zoom = Math.max(1, Math.min(MAX_VIEW_ZOOM, view.zoom));
  const scale = fitScale(available, world) * zoom;
  const maxX = Math.max(0, (world.width * scale - available.width) / 2);
  const maxY = Math.max(0, (world.height * scale - available.height) / 2);
  return { zoom, x: maxX ? Math.max(-maxX, Math.min(maxX, view.x)) : 0,
    y: maxY ? Math.max(-maxY, Math.min(maxY, view.y)) : 0 };
}

/** Keep a point relative to the viewport center fixed during zoom. */
export function zoomView(view: View, factor: number, point: { x: number; y: number }, available: Size, world: Size,
  translation = { x: 0, y: 0 }): View {
  const zoom = Math.max(1, Math.min(MAX_VIEW_ZOOM, view.zoom * factor));
  const ratio = zoom / view.zoom;
  return boundView({ zoom, x: point.x - (point.x - view.x - translation.x) * ratio,
    y: point.y - (point.y - view.y - translation.y) * ratio }, available, world);
}
