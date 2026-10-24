// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const launcher = fileURLToPath(new URL('../bin/openclaw-pixel-agents.mjs', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [launcher, ...args], {
  encoding: 'utf8', timeout: 5000, env: { ...process.env, PIXEL_CONTROL_TOKEN: 'existing-private-key' },
});

it('explains installation, configuration and key generation without starting the server', () => {
  const result = run('--help');
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('--env-file');
  expect(result.stdout).toContain('--generate-key');
  expect(result.stdout).toContain('CORS_ORIGIN');
  expect(result.stdout).not.toContain('existing-private-key');
});

it('reports the packaged version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const result = run('--version');
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${pkg.version}\n`);
});

it('generates independent keys without starting the server or exposing configured credentials', () => {
  const first = run('--generate-key'); const second = run('--generate-key');
  expect(first.status).toBe(0); expect(second.status).toBe(0);
  expect(first.stderr).toBe('');
  expect(first.stdout).toMatch(/^[a-f0-9]{64}\n$/);
  expect(first.stdout).not.toBe(second.stdout);
  expect(first.stdout).not.toContain('existing-private-key');
});

it('rejects unknown options instead of starting with an unintended configuration', () => {
  const result = run('--unknown-option');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Unknown option');
  expect(result.stderr).not.toContain('existing-private-key');
});
