// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { loadControlConfig } from './control/config';

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

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pixel-onboarding-')); directories.push(directory);
  return { directory, run: (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [launcher, ...args], {
    encoding: 'utf8', timeout: 5000, cwd: directory,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: directory, USERPROFILE: directory, CORS_ORIGIN: '',
      PIXEL_CONTROL_TOKEN: 'synthetic-existing-value', OPENCLAW_GATEWAY_TOKEN: 'synthetic-bootstrap-value', ...extra },
  }) };
}

it('prints a repeatable setup guide without reading credentials, writing files or starting the server', () => {
  const f = fixture(); const result = f.run(['setup']);
  expect(result.status).toBe(0); expect(result.stderr).toBe('');
  for (const text of ['CORS_ORIGIN', 'DATA_DIR', '--generate-key', 'operator.read', '--env-file', 'http://localhost:3001']) expect(result.stdout).toContain(text);
  expect(result.stdout).not.toContain('synthetic-existing-value'); expect(result.stdout).not.toContain('synthetic-bootstrap-value');
  expect(readdirSync(f.directory)).toEqual([]);
});
it('gives source-checkout users copyable key-generation and startup commands', () => {
  const result = fixture().run(['setup']);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('node bin/openclaw-pixel-agents.mjs --generate-key');
  expect(result.stdout).toContain('node bin/openclaw-pixel-agents.mjs --env-file /absolute/path/to/pixel-agents.env');
});
it('keeps private access disabled when the optional setup example is copied before entering a generated key', () => {
  const f = fixture(); const result = f.run(['setup']); expect(result.status).toBe(0);
  const example = result.stdout.split('\n').filter(line => /^\s*(OPENCLAW_GATEWAY_URL|PIXEL_CONTROL_TOKEN|CONTROL_SEND_ENABLED)=/.test(line)).join('\n');
  const environment = parseEnv(example);
  expect(environment.PIXEL_CONTROL_TOKEN).toBe('');
  expect(loadControlConfig(environment, f.directory).enabled).toBe(false);
});
it.each(['', '  \t '])('explains a missing or blank startup origin without creating data (%j)', origin => {
  const f = fixture(); const result = f.run([], { CORS_ORIGIN: origin });
  expect(result.status).toBe(1); expect(result.stderr).toContain('openclaw-pixel-agents setup');
  expect(result.stderr).toContain('--env-file'); expect(result.stderr).toContain('CORS_ORIGIN');
  expect(result.stderr).not.toContain('synthetic-existing-value'); expect(readdirSync(f.directory)).toEqual([]);
});
it.each(['strat', 'setup extra'])('rejects an unknown command without starting or writing anything (%s)', command => {
  const f = fixture(); const result = f.run(command.split(' '));
  expect(result.status).toBe(1); expect(result.stderr).toContain('Unknown command'); expect(readdirSync(f.directory)).toEqual([]);
});
it('rejects setup combined with an env file without reading or changing it', () => {
  const f = fixture(); const file = join(f.directory, 'office.env'); const contents = 'PIXEL_CONTROL_TOKEN=synthetic-file-value\n';
  writeFileSync(file, contents);
  const result = f.run(['setup', '--env-file', file]);
  expect(result.status).toBe(1); expect(result.stderr).toContain('setup'); expect(result.stderr).not.toContain('synthetic-file-value');
  expect(readFileSync(file, 'utf8')).toBe(contents); expect(readdirSync(f.directory)).toEqual(['office.env']);
});
it('does not turn a setup request into key generation when startup options are mixed', () => {
  const result = fixture().run(['setup', '--generate-key']);
  expect(result.status).toBe(1); expect(result.stdout).not.toMatch(/[a-f0-9]{64}/);
});
it('retains a clear nonzero failure for a missing env file, including native Node preflight', () => {
  const f = fixture(); const result = f.run(['--env-file', join(f.directory, 'missing.env')]);
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('missing.env'); expect(readdirSync(f.directory)).toEqual([]);
});
