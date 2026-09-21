/**
 * Shared recipe-preview renderer.
 *
 * Issue #165: AgentPortrait.tsx and CharacterCustomizer.tsx had two
 * near-identical copies of the recipe-to-canvas render logic. The
 * only meaningful differences were background style and source
 * scaling. This module consolidates both — callers pass an options
 * object to pick the variant.
 */

const SHEET_CACHE = new Map<string, Promise<HTMLImageElement>>();

/** Load an image from a URL and return an HTMLImageElement (cached, deduped) */
export function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = SHEET_CACHE.get(src);
  if (cached) return cached;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => {
      SHEET_CACHE.delete(src);
      reject(new Error(`Failed to load ${src}`));
    };
    img.src = src;
  });
  SHEET_CACHE.set(src, promise);
  return promise;
}

export interface DrawRecipePreviewOptions {
  /** Output canvas (already sized). */
  canvas: HTMLCanvasElement;
  recipe: { bodyIndex: number; hairIndex: number; outfitIndex: number };
  /** Base path for the MetroCity source sheets (e.g. "/assets/source/MetroCity/"). */
  basePath: string;
  /** Source-tile size in pixels (the source PNG uses 32×32 per frame). */
  srcTileSize?: number;
  /** Output-tile size in pixels (the destination PNG renders at 48×48 by default). */
  dstTileSize?: number;
  /** Background style — defaults to "transparent". */
  background?: 'transparent' | 'checkerboard';
  /**
   * `cancelled` token — set to `true` to abort the async load
   * (e.g. component unmount). Returns a cleanup function the caller
   * can call to register cancellation.
   */
  cancelled?: { value: boolean };
}

const CHECKERBOARD_SIZE = 6;
const CHECKERBOARD_LIGHT = '#1a1a2e';
const CHECKERBOARD_DARK = '#16213e';

/**
 * Draw a recipe preview to an existing canvas. The canvas dimensions
 * determine the output size; the recipe's three indices determine
 * which source frames are composited.
 */
export async function drawRecipePreview(opts: DrawRecipePreviewOptions): Promise<void> {
  const { canvas, recipe, basePath, cancelled } = opts;
  const src = opts.srcTileSize ?? 32;
  const dst = opts.dstTileSize ?? 48;
  const background = opts.background ?? 'transparent';

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;

  try {
    const [bodyImg, hairImg, outfitImg] = await Promise.all([
      loadImage(`${basePath}CharacterModel/Character Model.png`),
      loadImage(`${basePath}Hair/Hairs.png`),
      loadImage(`${basePath}Outfits/Outfit${recipe.outfitIndex + 1}.png`),
    ]);

    if (cancelled?.value) return;

    // Clear + background
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (background === 'checkerboard') {
      for (let y = 0; y < canvas.height; y += CHECKERBOARD_SIZE) {
        for (let x = 0; x < canvas.width; x += CHECKERBOARD_SIZE) {
          ctx.fillStyle = ((x / CHECKERBOARD_SIZE + y / CHECKERBOARD_SIZE) % 2 === 0)
            ? CHECKERBOARD_LIGHT
            : CHECKERBOARD_DARK;
          ctx.fillRect(x, y, CHECKERBOARD_SIZE, CHECKERBOARD_SIZE);
        }
      }
    }

    // Source crop: south direction (col 0), center 16px of 32px source
    const srcX = 0;
    const cropX = 8;
    const cropW = 16;
    const cropH = 32;

    // Position: center horizontally, fit to canvas height (preserve aspect)
    const dstW = Math.floor(cropW * dst / src);
    const dstH = Math.floor(cropH * dst / src);
    const offsetX = Math.floor((canvas.width - dstW) / 2);
    const offsetY = Math.floor((canvas.height - dstH) / 2);

    // Draw layers: body → outfit → hair
    ctx.drawImage(bodyImg, srcX + cropX, recipe.bodyIndex * src, cropW, cropH, offsetX, offsetY, dstW, dstH);
    ctx.drawImage(outfitImg, srcX + cropX, 0, cropW, cropH, offsetX, offsetY, dstW, dstH);
    ctx.drawImage(hairImg, srcX + cropX, recipe.hairIndex * src, cropW, cropH, offsetX, offsetY, dstW, dstH);
  } catch {
    if (cancelled?.value) return;
    // Fallback: draw a small marker so the canvas isn't blank.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#4ecca3';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Preview', canvas.width / 2, canvas.height / 2);
  }
}
