import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revision = 'a'.repeat(32);

function responseFor(path: string): Response {
  return path.endsWith('/manifest.json')
    ? new Response(JSON.stringify({ file: 'sprite.png', width: 16, height: 32 }))
    : new Response(new Blob(['png']));
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
