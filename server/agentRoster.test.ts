// @vitest-environment node
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentRegistry, loadAgentRoster } from './agentRoster';
import type { PersistedPrefs } from './validation';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync), closeSync: vi.fn(actual.closeSync) };
});
const roots: string[] = [];
const value = { version: 1, agents: [{ id: 'researcher', name: '研究 Assistant' }] };
function fixture(contents: string | Buffer = JSON.stringify(value)) {
  const root = fs.mkdtempSync(join(tmpdir(), 'pixel-roster-')); roots.push(root);
  const path = join(root, 'agents.json'); fs.writeFileSync(path, contents);
  return { root, path };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('replaces defaults with configured IDs and safe new-agent defaults', () => {
  const registry = createAgentRegistry({ version: 1, agents: [{ id: 'researcher', name: 'Research Assistant' }] }, new Map());
  expect([...registry.keys()]).toEqual(['researcher']);
  expect(registry.get('researcher')).toEqual({ id: 'researcher', name: 'Research Assistant', pixelEnabled: true, tags: [], recipe: { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 } });
});
it('keeps built-in defaults while names and saved preferences have independent authority', () => {
  const prefs: PersistedPrefs = { pixelEnabled: false, characterSpriteId: 'char_4', tags: ['coding'], recipe: { bodyIndex: 4, hairIndex: 2, outfitIndex: 3 } };
  const roster = { version: 1 as const, agents: [{ id: 'main', name: 'Coordinator' }, { id: 'miku', name: 'Artist' }] };
  const registry = createAgentRegistry(roster, new Map([['main', prefs]]));
  expect(registry.get('main')).toEqual({ id: 'main', name: 'Coordinator', ...prefs });
  expect(registry.get('miku')).toMatchObject({ name: 'Artist', tags: ['creative', 'media'], recipe: { bodyIndex: 1, hairIndex: 6, outfitIndex: 0 } });
  registry.get('main')!.tags.push('analysis'); registry.get('main')!.recipe.bodyIndex = 0;
  expect(prefs.tags).toEqual(['coding']); expect(prefs.recipe?.bodyIndex).toBe(4);
  expect(roster.agents[0].name).toBe('Coordinator');
});
it.each(['toString', 'valueOf'])('never inherits built-in metadata for %s', id => {
  const registry = createAgentRegistry({ version: 1, agents: [{ id, name: 'Agent' }] }, new Map());
  expect(registry.get(id)).toMatchObject({ tags: [], recipe: { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 } });
});

it('uses fresh defaults only when the path is absent or empty', () => {
  expect(loadAgentRoster(undefined).agents.map(agent => agent.id)).toEqual(['main', 'miku', 'chi', 'sysauxilia', 'descartes', 'cyberlogis', 'cylena', 'cybera']);
  expect(loadAgentRoster('').agents[0]).toEqual({ id: 'main', name: 'Shodan' });
});
it.each([' ', '\t', 'agents.json', '~/agents.json'])('refuses a non-absolute explicit path %j', path => {
  expect(() => loadAgentRoster(path)).toThrow(/AGENT_ROSTER_PATH.*absolute/);
});
it('loads without rewriting bytes and accepts a valid UTF-8 BOM', () => {
  const f = fixture('\ufeff' + JSON.stringify(value));
  const before = fs.readFileSync(f.path);
  expect(loadAgentRoster(f.path)).toEqual(value);
  expect(fs.readFileSync(f.path)).toEqual(before);
});
it('enforces the byte limit, including UTF-8 names rather than character counts', () => {
  const json = JSON.stringify(value);
  const f = fixture(json + ' '.repeat(65536 - Buffer.byteLength(json)));
  expect(loadAgentRoster(f.path)).toEqual(value);
  fs.appendFileSync(f.path, ' ');
  expect(() => loadAgentRoster(f.path)).toThrow(/65536|64 KiB/);
});
it.each([Buffer.from([0xc3, 0x28]), Buffer.from('{"secret":"synthetic\u001bsecret",bad}'), Buffer.from('{"version":1,"agents":[]}')])('rejects invalid explicit bytes without exposing parser excerpts', contents => {
  const f = fixture(contents);
  let failure: unknown;
  try { loadAgentRoster(f.path); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toMatch(/synthetic|secret|\u001b/);
});
it('keeps safe schema field/index diagnostics', () => {
  const f = fixture('{"version":1,"agents":[{"id":"worker","name":" untrimmed "}]}');
  expect(() => loadAgentRoster(f.path)).toThrow(/AGENT_ROSTER_PATH.*agents\[0\].name.*whitespace/);
});
it.each([
  [Buffer.from([0xc3, 0x28]), /must contain valid UTF-8 text/],
  [Buffer.from('{"synthetic-private-marker": invalid}'), /must contain valid JSON/],
])('distinguishes encoding failures from JSON syntax without echoing bytes', (contents, diagnostic) => {
  const f = fixture(contents);
  expect(() => loadAgentRoster(f.path)).toThrow(diagnostic);
  try { loadAgentRoster(f.path); } catch (error) { expect(String(error)).not.toContain('synthetic-private-marker'); }
});
it('keeps the primary file diagnostic if descriptor cleanup also fails', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const f = fixture();
  vi.mocked(fs.closeSync).mockImplementationOnce(fd => { actual.closeSync(fd); throw Error('synthetic-close-secret'); });
  expect(() => loadAgentRoster(f.root)).toThrow(/regular file/);
});
it('still fails closed if closing an otherwise readable file fails', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const f = fixture();
  vi.mocked(fs.closeSync).mockImplementationOnce(fd => { actual.closeSync(fd); throw Error('synthetic-close-secret'); });
  expect(() => loadAgentRoster(f.path)).toThrow('Unable to close the AGENT_ROSTER_PATH file.');
});
it('rejects missing files and directories without falling back', () => {
  const f = fixture();
  expect(() => loadAgentRoster(join(f.root, 'missing.json'))).toThrow(/AGENT_ROSTER_PATH/);
  expect(() => loadAgentRoster(f.root)).toThrow(/regular file/i);
});
it('sanitizes open/read failures and closes descriptors after read failure', () => {
  const f = fixture();
  vi.mocked(fs.openSync).mockImplementationOnce(() => { throw Object.assign(Error('synthetic-secret'), { code: 'EACCES' }); });
  expect(() => loadAgentRoster(f.path)).toThrow(/AGENT_ROSTER_PATH/);
  let descriptor = -1;
  vi.mocked(fs.readSync).mockImplementationOnce(fd => { descriptor = Number(fd); throw Error('synthetic-secret'); });
  let failure: unknown;
  try { loadAgentRoster(f.path); } catch (error) { failure = error; }
  expect(String(failure)).not.toContain('synthetic-secret');
  expect(() => fs.fstatSync(descriptor)).toThrow(/EBADF/);
});
it('permits symlinks only to regular files when the OS supports the fixture', ({ skip }) => {
  const f = fixture(); const link = join(f.root, 'linked.json');
  try { fs.symlinkSync(f.path, link); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { skip(); return; } throw error; }
  expect(loadAgentRoster(link)).toEqual(value);
});
it('rejects a FIFO promptly without blocking startup', ({ skip }) => {
  if (process.platform === 'win32') { skip(); return; }
  const f = fixture(); const fifo = join(f.root, 'fifo');
  const made = spawnSync('mkfifo', [fifo], { timeout: 2000 });
  if (made.error && (made.error as NodeJS.ErrnoException).code === 'ENOENT') { skip(); return; }
  expect(made.status).toBe(0);
  const module = fileURLToPath(new URL('./agentRoster.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e',
    `const {loadAgentRoster}=require(${JSON.stringify(module)});try{loadAgentRoster(${JSON.stringify(fifo)});process.exitCode=2;}catch(error){console.error(error.message);process.exitCode=1;}`],
  { encoding: 'utf8', timeout: 5000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/regular file/i);
});
