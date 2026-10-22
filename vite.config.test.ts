import { expect, it } from 'vitest';
import configure from './vite.config';

it('generates a different asset revision for each production build', async () => {
  const env = { command: 'build', mode: 'production' } as const;
  const first = (await configure(env)).define?.__ASSET_BUILD_ID__;
  const second = (await configure(env)).define?.__ASSET_BUILD_ID__;
  expect(JSON.parse(first)).toMatch(/^[a-f0-9]{32}$/);
  expect(JSON.parse(second)).toMatch(/^[a-f0-9]{32}$/);
  expect(second).not.toBe(first);
});

it('leaves development assets unversioned in the real Vite configuration', async () => {
  const config = await configure({ command: 'serve', mode: 'development' });
  expect(JSON.parse(config.define?.__ASSET_BUILD_ID__)).toBe('');
});
