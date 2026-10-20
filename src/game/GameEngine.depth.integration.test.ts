import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEngine } from './GameEngine';
import type { PlacedFurniture } from '../../shared/types';
import type { ReadonlyLoadedFurnitureItem } from './SpriteLoader';
import deskManifest from '../../public/assets/furniture/DESK/manifest.json';
import chairManifest from '../../public/assets/furniture/CUSHIONED_CHAIR/manifest.json';
import plantManifest from '../../public/assets/furniture/LARGE_PLANT/manifest.json';
import pcManifest from '../../public/assets/furniture/PC/manifest.json';
import tableManifest from '../../public/assets/furniture/TABLE_FRONT/manifest.json';
import smallTableManifest from '../../public/assets/furniture/SMALL_TABLE/manifest.json';
import coffeeTableManifest from '../../public/assets/furniture/COFFEE_TABLE/manifest.json';

// Run the real renderer and sprite loader. Canvas drawing, image decoding,
// network assets, animation scheduling and Web Audio are browser boundaries.
vi.mock('../audio/SoundFX', () => ({ sfx: {
  click: vi.fn(), place: vi.fn(), pickup: vi.fn(), typing: vi.fn(), typingBatch: vi.fn(),
  notify: vi.fn(), error: vi.fn(), spawn: vi.fn(), despawn: vi.fn(), footstep: vi.fn(),
} }));

type Paint =
  | { kind: 'image'; source: CanvasImageSource; coordinates: number[] }
  | { kind: 'fill'; style: string; coordinates: number[] };

function recordingContext(paints: Paint[]): CanvasRenderingContext2D {
  const context = {
    fillStyle: '',
    drawImage(source: CanvasImageSource, ...coordinates: number[]) {
      paints.push({ kind: 'image', source, coordinates });
    },
    fillRect(...coordinates: number[]) {
      paints.push({ kind: 'fill', style: String(context.fillStyle), coordinates });
    },
    measureText: (text: string) => ({ width: text.length * 6 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(context, {
    get: (target, property) => Reflect.get(target, property) ?? (() => {}),
  }) as unknown as CanvasRenderingContext2D;
}

function lastPaint(paints: Paint[], matches: (paint: Paint) => boolean): number {
  const index = paints.reduce((last, paint, position) => matches(paint) ? position : last, -1);
  expect(index, 'expected the real renderer to paint this scene sprite').toBeGreaterThanOrEqual(0);
  return index;
}

const desk: PlacedFurniture = { id: 'desk', type: 'DESK', x: 9, y: 4, rotation: 0 };
const grid = { tileSize: 32, gridWidth: 24, gridHeight: 16 };

describe('GameEngine scene depth with real loaded sprites', () => {
  let currentEngine: GameEngine | null = null;

  beforeEach(() => {
    vi.resetModules();
    currentEngine = null;
    vi.stubGlobal('__ASSET_BUILD_ID__', 'a'.repeat(32));
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 768, height: 288, close: vi.fn() })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recordingContext([]));
  });

  afterEach(() => {
    currentEngine?.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function loadScene(loadDesk = true, loadPcImage = true) {
    const manifests: Record<string, unknown> = {
      CUSHIONED_CHAIR: chairManifest,
      LARGE_PLANT: plantManifest,
      PC: pcManifest,
      TABLE_FRONT: tableManifest,
      SMALL_TABLE: smallTableManifest,
      COFFEE_TABLE: coffeeTableManifest,
      ...(loadDesk ? { DESK: deskManifest } : {}),
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const type = /\/furniture\/([^/]+)\/manifest\.json/.exec(url)?.[1];
      if (type) return manifests[type] ? Response.json(manifests[type]) : new Response('', { status: 404 });
      if (!loadPcImage && /\/furniture\/PC\/[^/]+\.png/.test(url)) return new Response('', { status: 404 });
      return new Response('png');
    }));
    const paints: Paint[] = [];
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(recordingContext(paints));
    const { GameEngine: RealGameEngine } = await import('./GameEngine');
    const engine = new RealGameEngine(canvas, grid);
    currentEngine = engine;
    await engine.init();
    const internal = engine as unknown as {
      render(): void;
      furniture: ReadonlyMap<string, ReadonlyLoadedFurnitureItem>;
    };
    const { getAgentCharacter } = await import('./SpriteLoader');
    const character = getAgentCharacter('main');
    expect(character).not.toBeNull();
    const characterFrames = new Set(character!.down.map(frame => frame.canvas));
    return {
      engine,
      sprite: (type: string) => internal.furniture.get(type)!.canvas,
      render: () => {
        paints.length = 0;
        // Rendering alone must describe depth without advancing navigation or
        // relocating intentionally overlapping editor placements in this scene.
        internal.render();
        return paints;
      },
      characterPaint: (paint: Paint) => paint.kind === 'image' && characterFrames.has(paint.source as HTMLCanvasElement),
    };
  }

  it.each([
    { y: 4, behind: true },
    { y: 5.9, behind: true },
    { y: 6, behind: false },
    { y: 6.1, behind: false },
  ])('paints the character at row $y on the correct side of the desk', async ({ y, behind }) => {
    const scene = await loadScene();
    scene.engine.setLayout([desk], {});
    scene.engine.addCharacter({ id: 'main', name: 'Shodan', x: 10, y, state: 'typing' });
    const paints = scene.render();
    const characterIndex = lastPaint(paints, scene.characterPaint);
    const deskIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite('DESK'));

    expect(characterIndex < deskIndex).toBe(behind);
  });

  it.each(['CUSHIONED_CHAIR', 'LARGE_PLANT'])(
    'occludes rear-row %s independently of the saved furniture array order', async type => {
      const scene = await loadScene();
      const item: PlacedFurniture = { id: 'rear-object', type, x: 10, y: 4, rotation: 0 };
      for (const furniture of [[desk, item], [item, desk]]) {
        scene.engine.setLayout(furniture, {});
        const paints = scene.render();
        const objectIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite(type));
        const deskIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite('DESK'));

        expect(objectIndex).toBeLessThan(deskIndex);
      }
    },
  );

  it.each(['CUSHIONED_CHAIR', 'LARGE_PLANT'])(
    'keeps %s on the floor below the desk in front independently of array order', async type => {
      const scene = await loadScene();
      const item: PlacedFurniture = { id: 'front-object', type, x: 10, y: 6, rotation: 0 };
      for (const furniture of [[item, desk], [desk, item]]) {
        scene.engine.setLayout(furniture, {});
        const paints = scene.render();
        const objectIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite(type));
        const deskIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite('DESK'));

        expect(objectIndex).toBeGreaterThan(deskIndex);
      }
    },
  );

  it.each([
    { rotation: 90, bottom: 7 },
    { rotation: 180, bottom: 5 },
    { rotation: 270, bottom: 5 },
  ])('uses the actual lower edge of a desk rotated $rotation degrees', async ({ rotation, bottom }) => {
    const scene = await loadScene();
    scene.engine.setLayout([{ ...desk, rotation }], {});
    for (const { y, behind } of [{ y: bottom - 0.1, behind: true }, { y: bottom, behind: false }]) {
      scene.engine.addCharacter({ id: 'main', name: 'Shodan', x: 9, y, state: 'typing' });
      const paints = scene.render();
      const characterIndex = lastPaint(paints, scene.characterPaint);
      const deskIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite('DESK'));

      expect(characterIndex < deskIndex).toBe(behind);
    }
  });

  it.each([
    { pcFirst: true, y: 3 }, { pcFirst: false, y: 3 },
    { pcFirst: true, y: 4 }, { pcFirst: false, y: 4 },
  ])('keeps a PC at row $y above its supporting desk and below a front-floor character (PC first: $pcFirst)', async ({ pcFirst, y }) => {
    const scene = await loadScene();
    const pc: PlacedFurniture = { id: 'desktop-pc', type: 'PC', x: 10, y, rotation: 0 };
    scene.engine.setLayout(pcFirst ? [pc, desk] : [desk, pc], {});
    scene.engine.addCharacter({ id: 'main', name: 'Shodan', x: 10, y: 6, state: 'typing' });
    const paints = scene.render();
    const deskIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite('DESK'));
    const pcIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite('PC'));
    const characterIndex = lastPaint(paints, scene.characterPaint);

    expect(deskIndex).toBeLessThan(pcIndex);
    expect(pcIndex).toBeLessThan(characterIndex);
  });

  it.each([
    { type: 'TABLE_FRONT', height: 4 },
    { type: 'SMALL_TABLE', height: 2 },
    { type: 'COFFEE_TABLE', height: 2 },
  ])('uses the real $type surface depth for rear and front objects', async ({ type, height }) => {
    const scene = await loadScene();
    const table = { ...desk, type };
    for (const { y, behind } of [{ y: 4, behind: true }, { y: 4 + height, behind: false }]) {
      const plant = { id: 'plant', type: 'LARGE_PLANT', x: 10, y, rotation: 0 };
      for (const furniture of [[table, plant], [plant, table]]) {
        scene.engine.setLayout(furniture, {});
        const paints = scene.render();
        const plantIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite('LARGE_PLANT'));
        const tableIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite(type));

        expect(plantIndex < tableIndex).toBe(behind);
      }
    }
  });

  it('uses the conservative fallback desk depth when the desk sprite is unavailable', async () => {
    const scene = await loadScene(false);
    scene.engine.setLayout([desk], {});
    for (const { y, behind } of [{ y: 4, behind: true }, { y: 5, behind: false }]) {
      scene.engine.addCharacter({ id: 'main', name: 'Shodan', x: 9, y, state: 'typing' });
      const paints = scene.render();
      const characterIndex = lastPaint(paints, scene.characterPaint);
      const deskIndex = lastPaint(paints, paint => paint.kind === 'fill' && paint.style === '#533483'
        && paint.coordinates.join(',') === [9 * 32, 4 * 32, 2 * 32, 32].join(','));

      expect(characterIndex < deskIndex).toBe(behind);
    }
  });

  it('keeps a supported PC fallback above the desk when its image fails after a valid manifest', async () => {
    const scene = await loadScene(true, false);
    const pc: PlacedFurniture = { id: 'desktop-pc', type: 'PC', x: 10, y: 4, rotation: 0 };
    scene.engine.setLayout([desk, pc], {});
    const paints = scene.render();
    const deskIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite('DESK'));
    const pcIndex = lastPaint(paints, paint => paint.kind === 'fill' && paint.style === '#0f3460'
      && paint.coordinates.join(',') === [10 * 32, 4 * 32, 2 * 32, 32].join(','));

    expect(deskIndex).toBeLessThan(pcIndex);
  });

  it('keeps equal-depth furniture stable and leaves layout order and values unchanged', async () => {
    const scene = await loadScene();
    const furniture: PlacedFurniture[] = [
      { id: 'plant', type: 'LARGE_PLANT', x: 5, y: 7, rotation: 0 },
      { id: 'chair', type: 'CUSHIONED_CHAIR', x: 5, y: 7, rotation: 0 },
      desk,
    ];
    const original = structuredClone(furniture);
    furniture.forEach(Object.freeze);
    Object.freeze(furniture);
    scene.engine.setLayout(furniture, {});
    for (let frame = 0; frame < 3; frame++) {
      const paints = scene.render();
      const plantIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite('LARGE_PLANT'));
      const chairIndex = lastPaint(paints, paint => paint.kind === 'image' && paint.source === scene.sprite('CUSHIONED_CHAIR'));
      expect(plantIndex).toBeLessThan(chairIndex);
      expect(scene.engine.getPlacedFurniture()).toEqual(original);
      expect(furniture).toEqual(original);
    }
  });
});
