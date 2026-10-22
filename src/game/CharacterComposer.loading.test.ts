import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Bitmap = { width: number; height: number; close: ReturnType<typeof vi.fn> };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('CharacterComposer source-sheet ownership', () => {
  let bitmaps: Bitmap[];
  const draw = vi.fn((source: { width: number; height: number }) => {
    if (!source.width || !source.height) throw new Error('Cannot draw a closed bitmap');
  });

  beforeEach(() => {
    vi.resetModules();
    bitmaps = [];
    draw.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('png')));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      const bitmap: Bitmap = { width: 768, height: 288, close: vi.fn() };
      bitmap.close.mockImplementation(() => { bitmap.width = 0; bitmap.height = 0; });
      bitmaps.push(bitmap);
      return bitmap;
    }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: draw,
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function expectOpen(sheets: Bitmap[]) {
    for (const sheet of sheets) expect(sheet.close).not.toHaveBeenCalled();
  }

  function expectClosed(sheets: Bitmap[]) {
    for (const sheet of sheets) expect(sheet.close).toHaveBeenCalledOnce();
  }

  function expectComposesFrom(
    compose: typeof import('./CharacterComposer').composeCharacter,
    sheets: Bitmap[],
  ) {
    draw.mockClear();
    const character = compose({ bodyIndex: 0, hairIndex: 0, outfitIndex: 0 });
    expect(character.down).toHaveLength(7);
    expect(character.portrait.width).toBe(64);
    const sources = new Set(draw.mock.calls.map(([source]) => source).filter(source => 'close' in source));
    expect(sources.size).toBe(3);
    for (const source of sources) expect(sheets).toContain(source);
  }

  it('closes the previous set only after its replacement is ready', async () => {
    const { loadSourceSheets, composeCharacter } = await import('./CharacterComposer');
    const firstController = new AbortController();
    await loadSourceSheets(undefined, firstController.signal);
    const previous = bitmaps.slice();
    expect(previous).toHaveLength(8);

    const body = deferred<Response>();
    vi.mocked(fetch).mockImplementation(async path => String(path).includes('/CharacterModel/')
      ? body.promise : new Response('png'));
    const replacement = loadSourceSheets();
    await vi.waitFor(() => expect(bitmaps).toHaveLength(15));
    expectOpen(previous);
    expectComposesFrom(composeCharacter, previous);
    body.resolve(new Response('png'));
    await replacement;

    const current = bitmaps.slice(8);
    expect(current).toHaveLength(8);
    expectClosed(previous);
    expectOpen(current);
    expectComposesFrom(composeCharacter, current);
    firstController.abort();
    expectClosed(previous);
    expectOpen(current);
  });

  it('disposes failed replacement pieces, including those decoded after rejection', async () => {
    const { loadSourceSheets, composeCharacter } = await import('./CharacterComposer');
    await loadSourceSheets();
    const current = bitmaps.slice();
    const body = deferred<Response>();
    vi.mocked(fetch).mockImplementation(async path => {
      if (String(path).includes('/CharacterModel/')) return body.promise;
      return new Response('png', { status: String(path).includes('/Hair/') ? 500 : 200 });
    });
    await expect(loadSourceSheets()).rejects.toThrow('500');
    await vi.waitFor(() => expect(bitmaps).toHaveLength(14));
    expectClosed(bitmaps.slice(8));
    expectOpen(current);
    body.resolve(new Response('png'));
    await vi.waitFor(() => expect(bitmaps).toHaveLength(15));
    expectClosed(bitmaps.slice(8));
    expectOpen(current);
    expectComposesFrom(composeCharacter, current);
  });

  it('releases cancelled staging immediately and late completion cannot close newer sheets', async () => {
    const { loadSourceSheets, composeCharacter } = await import('./CharacterComposer');
    await loadSourceSheets();
    const previous = bitmaps.slice();
    const body = deferred<Response>();
    let holdBody = true;
    vi.mocked(fetch).mockImplementation(async path => {
      if (holdBody && String(path).includes('/CharacterModel/')) {
        holdBody = false;
        return body.promise;
      }
      return new Response('png');
    });
    const controller = new AbortController();
    const cancelled = loadSourceSheets(undefined, controller.signal)
      .then(() => null, error => error);
    await vi.waitFor(() => expect(bitmaps).toHaveLength(15));
    const staged = bitmaps.slice(8);
    controller.abort();
    expectClosed(staged);
    expectOpen(previous);
    expectComposesFrom(composeCharacter, previous);

    await loadSourceSheets();
    const current = bitmaps.slice(15);
    expect(current).toHaveLength(8);
    expectClosed(previous);
    body.resolve(new Response('png'));
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    expectClosed(staged);
    expectClosed(bitmaps.slice(23));
    expectOpen(current);
    expectComposesFrom(composeCharacter, current);
  });

  it('preserves the current set when every replacement outfit is missing', async () => {
    const { loadSourceSheets, composeCharacter } = await import('./CharacterComposer');
    await loadSourceSheets();
    const current = bitmaps.slice();
    vi.mocked(fetch).mockImplementation(async path => new Response('png', {
      status: String(path).includes('/Outfits/') ? 404 : 200,
    }));
    await expect(loadSourceSheets()).rejects.toThrow('No source outfit sheets');
    expect(bitmaps).toHaveLength(10);
    expectClosed(bitmaps.slice(8));
    expectOpen(current);
    expectComposesFrom(composeCharacter, current);
  });

  it('still accepts a usable replacement when individual optional outfits are missing', async () => {
    const { loadSourceSheets, composeCharacter } = await import('./CharacterComposer');
    await loadSourceSheets();
    const previous = bitmaps.slice();
    vi.mocked(fetch).mockImplementation(async path => new Response('png', {
      status: String(path).includes('/Outfit2.png') ? 404 : 200,
    }));
    await loadSourceSheets();
    const current = bitmaps.slice(8);
    expect(current).toHaveLength(7);
    expectClosed(previous);
    expectOpen(current);
    expectComposesFrom(composeCharacter, current);
  });
});
