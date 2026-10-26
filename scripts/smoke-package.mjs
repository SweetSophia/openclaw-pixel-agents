import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Install the actual tarball with production dependencies, outside the checkout.
// All state, credentials and processes below belong to this disposable fixture.
const { values } = parseArgs({ options: { 'pack-destination': { type: 'string' } } });
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), 'pixel-npm-smoke-'));
const destination = values['pack-destination'] ? resolve(values['pack-destination']) : join(fixture, 'tarballs');
const consumer = join(fixture, 'consumer'); const home = join(fixture, 'home');
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this check through npm run test:package');
let child;
let logs = '';
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  HOME: home, USERPROFILE: home,
  npm_config_userconfig: join(fixture, 'user.npmrc'),
  npm_config_globalconfig: join(fixture, 'global.npmrc'),
};
const command = (args, cwd = root, includeStderr = false) => {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${args[0]} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout + (includeStderr ? result.stderr : '');
};
const stop = async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 7000);
  try { await ended; } finally { clearTimeout(force); }
};

try {
  await Promise.all([mkdir(destination, { recursive: true }), mkdir(consumer), mkdir(home),
    writeFile(env.npm_config_userconfig, ''), writeFile(env.npm_config_globalconfig, '')]);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const packedJson = JSON.parse(command([npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination]));
  // npm 12 keys its JSON by package name; older supported npm versions return an array.
  const entries = Array.isArray(packedJson) ? packedJson : Object.values(packedJson);
  assert.equal(entries.length, 1, 'Expected exactly one packed application');
  const [packed] = entries;
  assert.equal(packed.name, pkg.name); assert.equal(packed.version, pkg.version);
  const files = new Set(packed.files.map(file => file.path));
  for (const required of ['bin/openclaw-pixel-agents.mjs', 'bin/setup.mjs', 'scripts/install-notice.mjs', 'dist/client/index.html',
    'dist/server/server/index.js', 'dist/server/shared/characterRecipes.js',
    'scripts/generate-control-key.mjs', 'docs/task-access-setup.md', '.env.example',
    'collector/.env.collector.example', 'LICENSE', 'README.md']) assert(files.has(required), `Missing ${required}`);
  for (const path of files) {
    assert(!/(^|\/)(data|node_modules|coverage|\.git|\.superpowers|\.worktrees)(\/|$)/.test(path), `Runtime/private path packed: ${path}`);
    assert(!/\.(test|spec)\.|\.map$|(^|\/)\.env($|\.(?!example$|collector\.example$))/.test(path), `Development/private file packed: ${path}`);
    assert(/^(dist\/client\/|dist\/server\/(server|shared)\/.*\.js$|bin\/(openclaw-pixel-agents|setup)\.mjs$|scripts\/(generate-control-key|install-notice)\.mjs$|collector\/(README\.md|push-pixel-agents\.mjs|\.env\.collector\.example|systemd\/[^/]+)$|docs\/(task-access-setup|configuration|editor|releases)\.md$|package\.json$|README\.md$|LICENSE$|\.env\.example$)/.test(path), `Unexpected package file: ${path}`);
  }
  const tarball = join(destination, packed.filename);
  command([npmCli, 'install', '--prefix', consumer, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', `${pkg.name}@file:${tarball}`]);
  const installed = join(consumer, 'node_modules', pkg.name);
  const launcher = join(installed, pkg.bin['openclaw-pixel-agents']);
  assert.equal(command([launcher, '--version'], consumer).trim(), pkg.version);
  assert.equal(command([npmCli, 'exec', '--offline', '--prefix', consumer, '--', 'openclaw-pixel-agents', '--version'], consumer).trim(), pkg.version);
  assert.match(command([launcher, '--help'], consumer), /--generate-key/);
  const setup = command([launcher, 'setup'], consumer);
  for (const text of ['CORS_ORIGIN', 'DATA_DIR', 'operator.read', '--generate-key', '--env-file']) assert(setup.includes(text));
  assert.match(command([npmCli, 'exec', '--offline', '--prefix', consumer, '--', 'openclaw-pixel-agents', 'setup'], consumer), /OpenClaw Pixel Agents setup/);
  const unconfigured = spawnSync(process.execPath, [launcher], { cwd: consumer, env, encoding: 'utf8', timeout: 5000 });
  assert.equal(unconfigured.status, 1); assert.match(unconfigured.stderr, /openclaw-pixel-agents setup/);
  assert(!existsSync(join(home, '.openclaw-pixel-agents')), 'Setup or first-run guidance created office data');
  const firstKey = command([launcher, '--generate-key'], consumer).trim();
  const secondKey = command([launcher, '--generate-key'], consumer).trim();
  assert.match(firstKey, /^[a-f0-9]{64}$/); assert.notEqual(firstKey, secondKey);
  const noticeConsumer = join(fixture, 'notice-consumer'); await mkdir(noticeConsumer);
  // npm 12 authorizes a local archive by its exact resolved file identity.
  await writeFile(join(noticeConsumer, 'package.json'), JSON.stringify({ private: true, allowScripts: { [`file:${tarball}`]: true } }));
  const notice = command([npmCli, 'install', '--prefix', noticeConsumer, '--omit=dev', '--foreground-scripts', '--no-audit', '--no-fund', '--package-lock=false', `${pkg.name}@file:${tarball}`], root, true);
  assert.match(notice, /Next: openclaw-pixel-agents setup/);
  assert(!existsSync(join(home, '.openclaw-pixel-agents')), 'Install notice created office data');
  assert(!existsSync(join(noticeConsumer, 'pixel-agents.env')), 'Install notice created configuration');
  const lease = createServer(); lease.listen(0, '127.0.0.1'); await once(lease, 'listening');
  const port = lease.address().port; await new Promise((accept, reject) => lease.close(error => error ? reject(error) : accept()));
  const origin = `http://127.0.0.1:${port}`;
  const config = join(fixture, 'office.env');
  await writeFile(config, `PORT=${port}\nCORS_ORIGIN=${origin}\nDATA_SOURCE=ingest\nINGEST_API_TOKEN=synthetic-package-fixture\n`, { mode: 0o600 });
  const start = async () => {
    logs = '';
    child = spawn(process.execPath, [launcher, '--env-file', config], { cwd: consumer, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', error => { logs += error.message; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(`Packed server exited: ${logs}`);
      try { if ((await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* wait for listener */ }
      await delay(100);
    }
    throw new Error(`Packed server did not start: ${logs}`);
  };
  const ingest = async () => assert.equal((await fetch(`${origin}/api/ingest/agents`, { method: 'POST',
    headers: { Authorization: 'Bearer synthetic-package-fixture', 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions: [] }), signal: AbortSignal.timeout(5000) })).status, 200);
  await start();
  const page = await fetch(origin); assert.equal(page.status, 200); assert.match(await page.text(), /id="root"/);
  const manifest = await fetch(`${origin}/assets/furniture/DESK/manifest.json`);
  assert.equal(manifest.status, 200); assert.equal((await manifest.json()).id, 'DESK');
  const sprite = await fetch(`${origin}/assets/source/MetroCity/Outfits/Outfit5.png`);
  assert.equal(sprite.status, 200); assert.match(sprite.headers.get('content-type'), /image\/png/);
  assert.deepEqual([...new Uint8Array(await sprite.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  await ingest();
  const recipe = { bodyIndex: 4, hairIndex: 3, outfitIndex: 5 };
  assert.equal((await fetch(`${origin}/api/agents/main/recipe`, { method: 'PUT',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(recipe) })).status, 200);
  await ingest(); await stop(); await start(); await ingest();
  const { agents } = await (await fetch(`${origin}/api/agents`)).json();
  assert.deepEqual(agents.find(agent => agent.id === 'main').recipe, recipe);
  const prefs = JSON.parse(await readFile(join(home, '.openclaw-pixel-agents', 'agent-prefs.json'), 'utf8'));
  assert.deepEqual(prefs.main.recipe, recipe);
  console.log(`Package verified: ${pkg.name}@${pkg.version}; ${files.size} files, script-disabled setup, enabled install notice, production startup, assets, key generation, ingest and restart persistence.`);
  if (values['pack-destination']) console.log(`Tested tarball: ${tarball}`);
} finally {
  await stop();
  await rm(fixture, { recursive: true, force: true });
}
