import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revision = 'a'.repeat(32);

function responseFor(path: string): Response {
  return path.endsWith('/manifest.json')
    ? new Response(JSON.stringify({ file: 'sprite.png', width: 16, height: 32 }))
    : new Response('png');
}

describe('asset loading at browser boundaries', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('__ASSET_BUILD_ID__', revision);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => responseFor(url.split('?')[0])));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 768, height: 288, close: vi.fn() })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(), translate: vi.fn(), scale: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('versions every floor, furniture manifest, sprite, and compositor sheet request', async () => {
    const { loadAllAssets } = await import('./SpriteLoader');
    const assets = await loadAllAssets();
    expect(assets.characters).toHaveLength(8);
    expect(assets.floors).toHaveLength(9);
    expect(assets.furniture.size).toBe(25);
    const paths = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(paths).toHaveLength(67);
    expect(paths.every(path => path.endsWith(`?v=${revision}`))).toBe(true);
  });

  it.each([
    { outfitIndex: 4, expected: 'Outfit5.png' },
    { outfitIndex: 1, expected: 'Outfit1.png' },
  ])('uses $expected for outfit slot $outfitIndex after a source sheet fails', async ({ outfitIndex, expected }) => {
    vi.mocked(fetch).mockImplementation(async url => String(url).includes('/Outfits/Outfit2.png')
      ? new Response('', { status: 429 }) : new Response(String(url)));
    vi.mocked(createImageBitmap).mockImplementation(async blob => ({
      width: 768, height: 288, url: await (blob as Blob).text(), close: vi.fn(),
    } as unknown as ImageBitmap));
    const drawImage = document.createElement('canvas').getContext('2d')!.drawImage as ReturnType<typeof vi.fn>;
    const { loadSourceSheets, composeCharacter } = await import('./CharacterComposer');
    await loadSourceSheets();
    drawImage.mockClear();
    composeCharacter({ bodyIndex: 0, hairIndex: 0, outfitIndex });
    const outfitSources = drawImage.mock.calls.map(([image]) => image.url).filter((url): url is string => typeof url === 'string' && url.includes('/Outfits/'));
    expect(outfitSources.length).toBeGreaterThan(0);
    expect(outfitSources.every(url => url.includes(`/Outfits/${expected}`))).toBe(true);
  });

  it('still loads versioned legacy characters when compositor sheets are missing', async () => {
    vi.mocked(fetch).mockImplementation(async url => String(url).includes('/source/')
      ? new Response('', { status: 404 })
      : responseFor(String(url).split('?')[0]));
    const { loadAllAssets } = await import('./SpriteLoader');
    expect((await loadAllAssets()).characters).toHaveLength(6);
    const legacyPaths = vi.mocked(fetch).mock.calls
      .map(([url]) => String(url)).filter(path => path.includes('/characters/'));
    expect(legacyPaths).toHaveLength(6);
    expect(legacyPaths.every(path => path.endsWith(`?v=${revision}`))).toBe(true);
  });

  it('keeps an existing asset bundle drawable through repeated agent recompositions', async () => {
    const { loadAllAssets, recomposeAgent, getSpriteFrame } = await import('./SpriteLoader');
    const assets = await loadAllAssets();
    const main = assets.characters[0];
    const mainFrame = main.down[0].canvas;
    const cybera = assets.characters[1];
    for (const bodyIndex of [1, 2]) {
      const previousFrame = cybera.down[0].canvas;
      const replacement = recomposeAgent('cybera', { bodyIndex, hairIndex: 2, outfitIndex: 3 });

      for (const direction of ['down', 'up', 'right', 'left'] as const) {
        expect(cybera[direction]).toHaveLength(7);
        for (const frame of cybera[direction]) {
          expect(frame.canvas.width).toBe(16);
          expect(frame.canvas.height).toBe(32);
        }
        for (const [state, count] of [['walk', 3], ['typing', 2], ['reading', 2], ['idle', 1]] as const) {
          for (let tick = 0; tick < count; tick++) {
            expect(getSpriteFrame(cybera, state, direction, tick)).not.toBeNull();
          }
        }
      }
      expect(replacement).toBe(cybera);
      expect(cybera.down[0].canvas).not.toBe(previousFrame);
      expect(previousFrame.width).toBe(0);
      expect(main.down[0].canvas).toBe(mainFrame);
      expect(mainFrame.width).toBe(16);
    }
  });

  it('looks up each loaded character by agent identity', async () => {
    const { loadAllAssets, getAgentCharacter, recomposeAgent } = await import('./SpriteLoader');
    const assets = await loadAllAssets();
    expect(getAgentCharacter('main')).toBe(assets.characters[0]);
    expect(getAgentCharacter('cybera')).toBe(assets.characters[1]);
    expect(getAgentCharacter('main')).not.toBe(getAgentCharacter('cybera'));
    expect(getAgentCharacter('unknown')).toBeNull();
    const custom = recomposeAgent('custom', { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 });
    expect(custom).not.toBeNull();
    expect(getAgentCharacter('custom')).toBe(custom);
  });

  it.each(['composed', 'legacy'] as const)('clears previous agent lookups when reloading %s characters', async mode => {
    const { loadAllAssets, getAgentCharacter, recomposeAgent } = await import('./SpriteLoader');
    const first = await loadAllAssets();
    recomposeAgent('custom', { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 });
    if (mode === 'legacy') {
      vi.mocked(fetch).mockImplementation(async url => String(url).includes('/source/')
        ? new Response('', { status: 404 })
        : responseFor(String(url).split('?')[0]));
    }

    const current = await loadAllAssets();

    expect(getAgentCharacter('custom')).toBeNull();
    expect(getAgentCharacter('main')).toBe(mode === 'legacy' ? null : current.characters[0]);
    expect(current.characters).toHaveLength(mode === 'legacy' ? 6 : 8);
    expect(current.characters[0]).not.toBe(first.characters[0]);
  });

  it('does no work for an already cancelled initialization', async () => {
    const { loadAllAssets } = await import('./SpriteLoader');
    const controller = new AbortController();
    controller.abort();
    await expect(loadAllAssets(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['loadFloors', 'loadFurniture', 'loadCharacters'] as const)(
    '%s stops when cancellation arrives during bitmap decoding', async loader => {
      const module = await import('./SpriteLoader');
      const controller = new AbortController();
      vi.mocked(createImageBitmap).mockImplementationOnce(async () => {
        controller.abort();
        return { width: 768, height: 288, close: vi.fn() } as unknown as ImageBitmap;
      });
      await expect(module[loader](undefined, controller.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(createImageBitmap).toHaveBeenCalledTimes(1);
    },
  );

  it('a cancelled late compositor cannot dispose the newer initialization sprites', async () => {
    const { loadAllAssets, getComposedCharacter } = await import('./SpriteLoader');
    let releaseBody!: (response: Response) => void;
    let bodyStarted!: () => void;
    const started = new Promise<void>(resolve => { bodyStarted = resolve; });
    const heldBody = new Promise<Response>(resolve => { releaseBody = resolve; });
    const ordinaryFetch = vi.mocked(fetch).getMockImplementation()!;
    let holdFirst = true;
    vi.mocked(fetch).mockImplementation((...args) => {
      if (holdFirst && String(args[0]).includes('/CharacterModel/')) {
        holdFirst = false;
        bodyStarted();
        // A response/decode may finish even after its consumer is cancelled.
        return heldBody;
      }
      return ordinaryFetch(...args);
    });

    const controller = new AbortController();
    const cancelled = loadAllAssets(controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    controller.abort();
    const current = await loadAllAssets();
    const composed = getComposedCharacter('main');
    const frame = current.characters[0].down[0].canvas;
    releaseBody(responseFor('/body.png'));
    await rejected;

    expect(getComposedCharacter('main')).toBe(composed);
    expect(frame.width).toBe(16);
    expect(frame.height).toBe(32);
    expect(composed?.portrait.width).toBe(64);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/characters/'))).toBe(false);
  });
});
