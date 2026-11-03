// @vitest-environment node
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error Standalone packaged JavaScript CLI.
import { writeConfigurationBundle } from '../bin/configure-files.mjs';

// Replace only the OS write boundary to reproduce a disk-full failure after creation.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'pixel-config-files-')); roots.push(root);
  return { root, directory: join(root, 'new bundle'), files: { 'office.env': 'PORT=3001\n', 'collector.env': 'PIXEL_INGEST_TOKEN=synthetic\n' } };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('creates a private bundle with exact file contents and refuses a second writer', () => {
  const f = fixture();
  expect(writeConfigurationBundle(f)).toEqual([join(f.directory, 'office.env'), join(f.directory, 'collector.env')]);
  expect(fs.readFileSync(join(f.directory, 'office.env'), 'utf8')).toBe('PORT=3001\n');
  if (process.platform !== 'win32') {
    expect(fs.statSync(f.directory).mode & 0o777).toBe(0o700);
    for (const name of Object.keys(f.files)) expect(fs.statSync(join(f.directory, name)).mode & 0o777).toBe(0o600);
  }
  expect(() => writeConfigurationBundle({ ...f, files: { 'office.env': 'CHANGED=true\n' } })).toThrow(/exist/i);
  expect(fs.readFileSync(join(f.directory, 'office.env'), 'utf8')).toBe('PORT=3001\n');
});
it.each(['file', 'empty-directory', 'nonempty-directory', 'dangling-symlink'])('never replaces an existing %s destination', kind => {
  const f = fixture();
  if (kind === 'file') fs.writeFileSync(f.directory, 'keep');
  else if (kind === 'dangling-symlink') fs.symlinkSync(join(f.root, 'missing'), f.directory, 'dir');
  else { fs.mkdirSync(f.directory); if (kind === 'nonempty-directory') fs.writeFileSync(join(f.directory, 'keep'), 'keep'); }
  expect(() => writeConfigurationBundle(f)).toThrow(/exist/i);
  expect(fs.lstatSync(f.directory)).toBeTruthy();
  if (kind === 'file') expect(fs.readFileSync(f.directory, 'utf8')).toBe('keep');
  if (kind === 'nonempty-directory') expect(fs.readFileSync(join(f.directory, 'keep'), 'utf8')).toBe('keep');
  if (kind === 'dangling-symlink') expect(fs.readlinkSync(f.directory)).toBe(join(f.root, 'missing'));
});
it('does not create missing parents or allow unexpected/traversing file names', () => {
  const f = fixture();
  expect(() => writeConfigurationBundle({ ...f, directory: join(f.root, 'missing', 'bundle') })).toThrow();
  expect(fs.readdirSync(f.root)).toEqual([]);
  for (const name of ['../escaped.env', 'nested/office.env', 'arbitrary.env']) {
    expect(() => writeConfigurationBundle({ ...f, files: { [name]: 'secret' } })).toThrow();
    expect(fs.readdirSync(f.root)).toEqual([]);
  }
});
it('cleans even a partially written file on an ordinary I/O failure without exposing its contents', async () => {
  const f = fixture(); const originalWrite = (await vi.importActual<typeof import('node:fs')>('node:fs')).writeFileSync;
  let calls = 0;
  vi.mocked(fs.writeFileSync).mockImplementation((...args) => {
    originalWrite(...args);
    if (++calls === 2) throw Object.assign(Error('synthetic-secret-content'), { code: 'ENOSPC' });
  });
  let failure;
  try { writeConfigurationBundle(f); } catch (error) { failure = error; }
  expect(String(failure)).toMatch(/ENOSPC/);
  expect(String(failure)).not.toMatch(/synthetic-secret-content/);
  expect(fs.readdirSync(f.root)).toEqual([]);
});
