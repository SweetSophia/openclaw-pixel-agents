import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('leaves development asset URLs unchanged', async () => {
  const { assetUrl } = await import('./assetUrl');
  expect(assetUrl('/assets/floors/floor_0.png')).toBe('/assets/floors/floor_0.png');
});

it('uses one revision for a build and a new URL for the next build', async () => {
  const { assetUrl } = await import('./assetUrl');
  vi.stubGlobal('__ASSET_BUILD_ID__', 'a'.repeat(32));
  expect(assetUrl('/assets/a.png')).toBe(`/assets/a.png?v=${'a'.repeat(32)}`);
  expect(assetUrl('/assets/a.png?variant=1')).toBe(`/assets/a.png?variant=1&v=${'a'.repeat(32)}`);
  vi.stubGlobal('__ASSET_BUILD_ID__', 'b'.repeat(32));
  expect(assetUrl('/assets/a.png')).toBe(`/assets/a.png?v=${'b'.repeat(32)}`);
});

it('recipe previews use the same versioned URL and retain image deduplication', async () => {
  vi.stubGlobal('__ASSET_BUILD_ID__', 'a'.repeat(32));
  vi.stubGlobal('Image', class {
    onload?: () => void;
    src = '';
    constructor() { queueMicrotask(() => this.onload?.()); }
  });
  const { loadImage } = await import('../components/recipePreview');
  const first = loadImage('/assets/source/MetroCity/Hair/Hairs.png');
  expect(loadImage('/assets/source/MetroCity/Hair/Hairs.png')).toBe(first);
  expect((await first).src).toBe(`/assets/source/MetroCity/Hair/Hairs.png?v=${'a'.repeat(32)}`);
});
