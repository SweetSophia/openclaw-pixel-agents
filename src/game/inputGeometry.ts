export interface ClientPoint {
  clientX: number;
  clientY: number;
}

export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasMetrics {
  rect: ScreenRect;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly tileSize: number;
}

export interface GridPoint {
  gridX: number;
  gridY: number;
}

/** Map client coordinates into the canvas grid, accounting for object-fit bars. */
// `Readonly<CanvasMetrics>` enforces top-level immutability at compile time;
// combined with the `readonly` element fields on ScreenRect, the metrics and
// their nested rect are deep-immutable at the type level — no consumer can
// reassign metrics.rect, metrics.canvasWidth, or any nested field (issue #132).
export function screenToGrid(
  clientX: number,
  clientY: number,
  metrics: Readonly<CanvasMetrics>,
): GridPoint | null {
  const { rect, canvasWidth, canvasHeight, tileSize } = metrics;
  const cssRatio = rect.width / rect.height;
  const canvasRatio = canvasWidth / canvasHeight;

  let renderedWidth: number;
  let renderedHeight: number;
  let offsetX: number;
  let offsetY: number;

  if (cssRatio > canvasRatio) {
    renderedWidth = (canvasWidth / canvasHeight) * rect.height;
    renderedHeight = rect.height;
    offsetX = rect.left + (rect.width - renderedWidth) / 2;
    offsetY = rect.top;
  } else {
    renderedWidth = rect.width;
    renderedHeight = (canvasHeight / canvasWidth) * rect.width;
    offsetX = rect.left;
    offsetY = rect.top + (rect.height - renderedHeight) / 2;
  }

  const scale = canvasWidth / renderedWidth;

  if (
    clientX < offsetX
    || clientX > offsetX + renderedWidth
    || clientY < offsetY
    || clientY > offsetY + renderedHeight
  ) {
    return null;
  }

  return {
    gridX: Math.floor((clientX - offsetX) * scale / tileSize),
    gridY: Math.floor((clientY - offsetY) * scale / tileSize),
  };
}

/** Euclidean distance between two client-coordinate points. */
export function touchDistance(a: Readonly<ClientPoint>, b: Readonly<ClientPoint>): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}
