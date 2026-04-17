/**
 * Character Composer — Paperdoll sprite compositor for OpenClaw Pixel Agents
 *
 * Layers MetroCity source assets (body + outfit + hair) into composited
 * character sprite sheets. Each agent gets a unique look via config:
 *
 *   bodyIndex:   0-5  (skin tone / body type)
 *   hairIndex:   0-8  (hairstyle)
 *   outfitIndex: 0-5  (clothing)
 *
 * Source sprite sheet layout (all sheets share this):
 *   24 columns × N rows, 32×32px per frame
 *   4 directions (6 frames each): south(0-5), east(6-11), north(12-17), west(18-23)
 *
 * Output layout (matches existing SpriteLoader format):
 *   3 rows × 7 columns, 16×32px per frame
 *   Row 0: down (south), Row 1: up (north), Row 2: right (east)
 *   Frames 0-2: walk, 3-4: typing, 5-6: reading
 *   "left" derived by flipping "right"
 */

// ── Source constants ───────────────────────────────────────

/** Source frame size — all MetroCity sheets use 32×32 */
const SRC_FRAME = 32;

/** Columns per source direction (6 animation frames) */
const SRC_FRAMES_PER_DIR = 6;

/** Total columns per source row (4 directions × 6 frames) */
const SRC_COLS = 24;

/** Source directions: south=col 0-5, east=6-11, north=12-17, west=18-23 */
const SRC_DIR_OFFSETS = { south: 0, east: 6, north: 12, west: 18 } as const;

// ── Output constants (matching existing char sprites) ──────

const OUT_FRAME_W = 16;
const OUT_FRAME_H = 32;
const OUT_FRAMES_PER_ROW = 7;

/**
 * Map from output frame index → source frame index within a direction.
 * Output has 7 frames: walk(0-2), typing(3-4), reading(5-6)
 * Source has 6 frames per direction: 0-5 (walk cycle)
 *
 * We map: output walk → src 0,1,2, output typing → src 3,4, output reading → src 5,0
 * (reading reuses src frame 0 for the second slot since source only has 6 walk frames)
 */
const OUT_TO_SRC_FRAME = [0, 1, 2, 3, 4, 5, 0];

// ── Types ──────────────────────────────────────────────────

export interface CharacterRecipe {
  bodyIndex: number;    // 0-5: row in CharacterModel sheet
  hairIndex: number;    // 0-8: row in Hairs sheet
  outfitIndex: number;  // 0-5: row in Outfit sheet
}

export interface ComposedCharacter {
  down: HTMLCanvasElement[];   // 7 frames
  up: HTMLCanvasElement[];     // 7 frames
  right: HTMLCanvasElement[];  // 7 frames
  portrait: HTMLCanvasElement; // single 2× scaled frame (facing down, idle)
}

// ── Loaded source sheets ───────────────────────────────────

let bodySheet: ImageBitmap | null = null;
let hairSheet: ImageBitmap | null = null;
let outfitSheets: ImageBitmap[] = [];
let shadowSheet: ImageBitmap | null = null;

// ── Helpers ────────────────────────────────────────────────

async function loadPng(path: string): Promise<ImageBitmap> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/**
 * Extract a single 32×32 frame from a source sprite sheet.
 */
function extractSrcFrame(
  sheet: ImageBitmap,
  row: number,
  col: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SRC_FRAME;
  canvas.height = SRC_FRAME;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    sheet,
    col * SRC_FRAME, row * SRC_FRAME,
    SRC_FRAME, SRC_FRAME,
    0, 0,
    SRC_FRAME, SRC_FRAME,
  );
  return canvas;
}

/**
 * Composite three layers (body, outfit, hair) into a single frame.
 * Source layers are 32×32; we crop to 16×32 (centered horizontally)
 * to match the output format used by the rest of the engine.
 */
function compositeFrame(
  bodyFrame: HTMLCanvasElement,
  outfitFrame: HTMLCanvasElement,
  hairFrame: HTMLCanvasElement,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = OUT_FRAME_W;
  canvas.height = OUT_FRAME_H;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  // Source is 32×32, output is 16×32. Crop center 16px horizontally.
  const srcX = 8; // (32 - 16) / 2

  // Layer order: body → outfit → hair
  ctx.drawImage(bodyFrame, srcX, 0, OUT_FRAME_W, OUT_FRAME_H, 0, 0, OUT_FRAME_W, OUT_FRAME_H);
  ctx.drawImage(outfitFrame, srcX, 0, OUT_FRAME_W, OUT_FRAME_H, 0, 0, OUT_FRAME_W, OUT_FRAME_H);
  ctx.drawImage(hairFrame, srcX, 0, OUT_FRAME_W, OUT_FRAME_H, 0, 0, OUT_FRAME_W, OUT_FRAME_H);

  return canvas;
}

// ── Public API ─────────────────────────────────────────────

/**
 * Load all source sprite sheets from MetroCity assets.
 * Must be called before composeCharacter().
 */
export async function loadSourceSheets(
  basePath = '/assets/source/MetroCity/',
): Promise<void> {
  const [body, hair, ...outfits] = await Promise.all([
    loadPng(`${basePath}CharacterModel/Character Model.png`),
    loadPng(`${basePath}Hair/Hairs.png`),
    // Load all 6 outfit sheets
    ...Array.from({ length: 6 }, (_, i) =>
      loadPng(`${basePath}Outfits/Outfit${i + 1}.png`).catch(() => null)
    ),
  ]);

  bodySheet = body;
  hairSheet = hair;
  outfitSheets = outfits.filter((o): o is ImageBitmap => o !== null);
}

/**
 * Compose a character from a recipe (body + hair + outfit indices).
 *
 * Returns a ComposedCharacter with 3 directions × 7 frames each,
 * plus a 2× portrait for sidebar display.
 */
export function composeCharacter(recipe: CharacterRecipe): ComposedCharacter {
  if (!bodySheet || !hairSheet || outfitSheets.length === 0) {
    throw new Error('Source sheets not loaded. Call loadSourceSheets() first.');
  }

  const outfit = outfitSheets[Math.min(recipe.outfitIndex, outfitSheets.length - 1)];

  // For each output direction, we need the corresponding source direction
  const dirMap: Record<string, keyof typeof SRC_DIR_OFFSETS> = {
    down: 'south',
    up: 'north',
    right: 'east',
  };

  const result: ComposedCharacter = {
    down: [],
    up: [],
    right: [],
    portrait: document.createElement('canvas'), // placeholder, set below
  };

  for (const [outDir, srcDir] of Object.entries(dirMap)) {
    const srcColOffset = SRC_DIR_OFFSETS[srcDir];

    for (let f = 0; f < OUT_FRAMES_PER_ROW; f++) {
      const srcCol = srcColOffset + OUT_TO_SRC_FRAME[f];

      const bodyFrame = extractSrcFrame(bodySheet, recipe.bodyIndex, srcCol);
      const outfitFrame = extractSrcFrame(outfit, 0, srcCol); // outfits have 1 row each
      const hairFrame = extractSrcFrame(hairSheet, recipe.hairIndex, srcCol);

      const composited = compositeFrame(bodyFrame, outfitFrame, hairFrame);
      result[outDir as 'down' | 'up' | 'right'].push(composited);
    }
  }

  // Generate portrait: down-facing idle frame at 2× scale
  const portraitSrc = result.down[0]; // idle frame
  const portrait = document.createElement('canvas');
  portrait.width = OUT_FRAME_W * 4;   // 64px
  portrait.height = OUT_FRAME_H * 4;  // 128px
  const pCtx = portrait.getContext('2d')!;
  pCtx.imageSmoothingEnabled = false;
  pCtx.drawImage(portraitSrc, 0, 0, OUT_FRAME_W, OUT_FRAME_H, 0, 0, portrait.width, portrait.height);
  result.portrait = portrait;

  return result;
}

/**
 * Get a data URL for a composed portrait (for use in <img> tags).
 */
export function portraitToDataUrl(portrait: HTMLCanvasElement): string {
  return portrait.toDataURL('image/png');
}

/**
 * Compose characters for all agents based on their recipes.
 * Returns a Map of agentId → ComposedCharacter.
 */
export function composeAll(
  recipes: Map<string, CharacterRecipe>,
): Map<string, ComposedCharacter> {
  const result = new Map<string, ComposedCharacter>();
  for (const [agentId, recipe] of recipes) {
    try {
      result.set(agentId, composeCharacter(recipe));
    } catch (err) {
      console.error(`[CharacterComposer] Failed to compose ${agentId}:`, err);
    }
  }
  return result;
}

// ── Default recipes for the agent roster ───────────────────

export const DEFAULT_RECIPES: Record<string, CharacterRecipe> = {
  main:       { bodyIndex: 3, hairIndex: 0, outfitIndex: 2 },  // Shodan: darker skin, short hair, casual
  cybera:     { bodyIndex: 1, hairIndex: 2, outfitIndex: 0 },  // Cybera: lighter skin, longer hair, shirt
  chi:        { bodyIndex: 2, hairIndex: 5, outfitIndex: 3 },  // Chi: medium skin, styled hair, belt outfit
  descartes:  { bodyIndex: 4, hairIndex: 1, outfitIndex: 1 },  // Descartes: darker skin, neat hair, formal
  cyberlogis: { bodyIndex: 0, hairIndex: 3, outfitIndex: 4 },  // Cyberlogis: lightest skin, unique hair, full outfit
  cylena:     { bodyIndex: 5, hairIndex: 7, outfitIndex: 5 },  // Cylena: darkest skin, styled hair, outfit 6
  sysauxilia: { bodyIndex: 2, hairIndex: 4, outfitIndex: 2 },  // Sysauxilia: medium skin, different hair, casual
  miku:       { bodyIndex: 1, hairIndex: 6, outfitIndex: 0 },  // Miku: lighter skin, long hair, shirt
};

/**
 * Get the recipe for an agent, falling back to defaults.
 */
export function getRecipe(
  agentId: string,
  overrides?: Partial<CharacterRecipe>,
): CharacterRecipe {
  const base = DEFAULT_RECIPES[agentId] ?? { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 };
  return { ...base, ...overrides };
}
