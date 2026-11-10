import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { io as connectSocket } from 'socket.io-client';

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
  for (const required of ['bin/openclaw-pixel-agents.mjs', 'bin/setup.mjs', 'bin/configure.mjs', 'bin/configure-values.mjs', 'bin/configure-files.mjs', 'scripts/install-notice.mjs', 'dist/client/index.html',
    'dist/server/server/index.js', 'dist/server/shared/characterRecipes.js',
    'shared/agentRoster.cjs', 'dist/server/shared/agentRoster.cjs', 'agents.example.json',
    'scripts/generate-control-key.mjs', 'docs/task-access-setup.md', 'docs/configuration.md', 'docs/schedules.md', '.env.example',
    'collector/.env.collector.example', 'LICENSE', 'README.md']) assert(files.has(required), `Missing ${required}`);
  for (const path of files) {
    assert(!/(^|\/)(data|node_modules|coverage|\.git|\.superpowers|\.worktrees)(\/|$)/.test(path), `Runtime/private path packed: ${path}`);
    assert(!/\.(test|spec)\.|\.map$|(^|\/)\.env($|\.(?!example$|collector\.example$))/.test(path), `Development/private file packed: ${path}`);
    assert(/^(dist\/client\/|dist\/server\/(server|shared)\/.*\.js$|(?:shared|dist\/server\/shared)\/agentRoster\.cjs$|agents\.example\.json$|bin\/(openclaw-pixel-agents|setup|configure|configure-values|configure-files)\.mjs$|scripts\/(generate-control-key|install-notice)\.mjs$|collector\/(README\.md|push-pixel-agents\.mjs|\.env\.collector\.example|systemd\/[^/]+)$|docs\/(task-access-setup|configuration|schedules|editor|releases)\.md$|package\.json$|README\.md$|LICENSE$|\.env\.example$)/.test(path), `Unexpected package file: ${path}`);
  }
  const tarball = join(destination, packed.filename);
  command([npmCli, 'install', '--prefix', consumer, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', `${pkg.name}@file:${tarball}`]);
  const installed = join(consumer, 'node_modules', pkg.name);
  assert.match(await readFile(join(installed, 'docs/configuration.md'), 'utf8'), /\]\(schedules\.md\)/);
  assert.match(await readFile(join(installed, 'docs/schedules.md'), 'utf8'), /500 records/);
  const sourceRoster = await import(pathToFileURL(join(installed, 'shared/agentRoster.cjs')).href);
  const compiledRoster = await import(pathToFileURL(join(installed, 'dist/server/shared/agentRoster.cjs')).href);
  assert.deepEqual(sourceRoster.createDefaultAgentRoster(), compiledRoster.createDefaultAgentRoster());
  assert.deepEqual(sourceRoster.parseAgentRoster(JSON.parse(await readFile(join(installed, 'agents.example.json'), 'utf8'))).agents,
    [{ id: 'main', name: 'Coordinator' }, { id: 'researcher', name: 'Research Assistant' }]);
  const launcher = join(installed, pkg.bin['openclaw-pixel-agents']);
  assert.equal(command([launcher, '--version'], consumer).trim(), pkg.version);
  assert.equal(command([npmCli, 'exec', '--offline', '--prefix', consumer, '--', 'openclaw-pixel-agents', '--version'], consumer).trim(), pkg.version);
  assert.match(command([launcher, '--help'], consumer), /--generate-key/);
  assert.match(command([launcher, 'configure', '--help'], consumer), /preview/);
  const noninteractive = spawnSync(process.execPath, [launcher, 'configure'], { cwd: consumer, env, encoding: 'utf8', timeout: 5000 });
  assert.equal(noninteractive.status, 1); assert.match(noninteractive.stderr, /interactive terminal/);
  assert(!existsSync(join(home, '.openclaw-pixel-agents-config')), 'Noninteractive configure created configuration');
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
  const { runConfigure } = await import(pathToFileURL(join(installed, 'bin/configure.mjs')).href);
  const answers = ['remote', String(port), origin, '', '', origin, process.execPath, 'no', '2', 'main', 'Coordinator', 'researcher', 'Research Assistant', 'no', 'yes'];
  const wizardOutput = [];
  await runConfigure({ home, output: text => wizardOutput.push(text), ask: async () => {
    assert(answers.length, 'Wizard asked an unexpected question'); return answers.shift();
  } });
  const config = join(home, '.openclaw-pixel-agents-config', 'office.env');
  const generated = parseEnv(await readFile(config, 'utf8'));
  const rosterPath = join(home, '.openclaw-pixel-agents-config', 'agents.json');
  assert.equal(generated.AGENT_ROSTER_PATH, rosterPath);
  assert.deepEqual(JSON.parse(await readFile(rosterPath, 'utf8')), { version: 1, agents: [{ id: 'main', name: 'Coordinator' }, { id: 'researcher', name: 'Research Assistant' }] });
  // The working directory is never an implicit roster source.
  await writeFile(join(consumer, 'agents.json'), 'synthetic-private-marker invalid JSON');
  const collector = parseEnv(await readFile(join(home, '.openclaw-pixel-agents-config', 'collector.env'), 'utf8'));
  assert.match(generated.INGEST_API_TOKEN, /^[a-f0-9]{64}$/);
  assert.equal(generated.INGEST_API_TOKEN, collector.PIXEL_INGEST_TOKEN);
  assert(!wizardOutput.join('\n').includes(generated.INGEST_API_TOKEN), 'Wizard printed its ingest secret');
  const start = async (overrides = {}) => {
    logs = '';
    child = spawn(process.execPath, [launcher, '--env-file', config], { cwd: consumer, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    headers: { Authorization: `Bearer ${generated.INGEST_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions: [] }), signal: AbortSignal.timeout(5000) })).status, 200);
  const agents = async () => (await (await fetch(`${origin}/api/agents`, { signal: AbortSignal.timeout(5000) })).json()).agents;
  const observeSocket = () => new Promise((accept, reject) => {
    const socket = connectSocket(origin, { autoConnect: false, transports: ['websocket'], extraHeaders: { Origin: origin }, reconnection: false, timeout: 3000 });
    const timer = setTimeout(() => finish(Error('Timed out waiting for the installed server roster socket')), 5000);
    const finish = (error, snapshot) => { clearTimeout(timer); socket.disconnect(); error ? reject(error) : accept(snapshot); };
    socket.once('agents:update', snapshot => finish(undefined, snapshot));
    socket.once('connect_error', error => finish(error));
    socket.connect();
  });
  const writeRoster = entries => writeFile(rosterPath, JSON.stringify({ version: 1, agents: entries }));
  const main = { id: 'main', name: 'Coordinator' };
  await start();
  const page = await fetch(origin); assert.equal(page.status, 200); assert.match(await page.text(), /id="root"/);
  const manifest = await fetch(`${origin}/assets/furniture/DESK/manifest.json`);
  assert.equal(manifest.status, 200); assert.equal((await manifest.json()).id, 'DESK');
  const sprite = await fetch(`${origin}/assets/source/MetroCity/Outfits/Outfit5.png`);
  assert.equal(sprite.status, 200); assert.match(sprite.headers.get('content-type'), /image\/png/);
  assert.deepEqual([...new Uint8Array(await sprite.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  await ingest();
  assert.deepEqual((await agents()).map(({ id, name }) => ({ id, name })), [main, { id: 'researcher', name: 'Research Assistant' }]);
  assert.deepEqual((await observeSocket()).map(({ id, name }) => ({ id, name })), [main, { id: 'researcher', name: 'Research Assistant' }]);
  assert(!existsSync(join(generated.DATA_DIR, 'control-schedules')), 'Default-off packaged startup created scheduling state');
  await stop();
  for (const scheduling of [{}, { CONTROL_SCHEDULES_MANAGE_ENABLED: 'true' }]) {
    await start({ OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:9', PIXEL_CONTROL_TOKEN: firstKey,
      OPENCLAW_SCHEDULES_GATEWAY_TOKEN: secondKey, ...scheduling });
    const recovery = await fetch(`${origin}/api/control/agents/main/schedules/operations`, { headers: { Authorization: `Bearer ${firstKey}` } });
    assert.equal(recovery.status, 200); assert.deepEqual(await recovery.json(), { agentId: 'main', operations: [] });
    assert(!existsSync(join(generated.DATA_DIR, 'control-schedules')), 'Startup/recovery read paired scheduling without an authenticated native browse');
    await stop();
  }
  await start();
  const recipe = { bodyIndex: 4, hairIndex: 3, outfitIndex: 5 };
  assert.equal((await fetch(`${origin}/api/agents/main/recipe`, { method: 'PUT',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(recipe) })).status, 200);
  const customRecipe = { bodyIndex: 2, hairIndex: 8, outfitIndex: 1 };
  assert.equal((await fetch(`${origin}/api/agents/researcher/recipe`, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(customRecipe) })).status, 200);
  await ingest(); await stop();
  await writeRoster([main, { id: 'researcher', name: 'Renamed without rebuilding' }]);
  await start(); await ingest();
  assert.deepEqual((await agents()).find(agent => agent.id === 'main').recipe, recipe);
  assert.equal((await agents()).find(agent => agent.id === 'researcher').name, 'Renamed without rebuilding');
  assert.equal((await observeSocket()).find(agent => agent.id === 'researcher').name, 'Renamed without rebuilding');
  await stop(); await writeRoster([main]); await start(); await ingest();
  assert.equal((await fetch(`${origin}/api/agents/main/toggle`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(generated.DATA_DIR, 'agent-prefs.json'), 'utf8')).researcher.recipe, customRecipe);
  await stop(); await writeRoster([main, { id: 'researcher', name: 'Restored identity' }]); await start(); await ingest();
  assert.deepEqual((await agents()).find(agent => agent.id === 'researcher').recipe, customRecipe);
  assert.equal((await fetch(`${origin}/api/ingest/agents`, { method: 'POST', headers: { Authorization: `Bearer ${generated.INGEST_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessions: [{ agentId: 'unknown', key: 'agent:unknown:fixture' }] }) })).status, 400);
  await stop();
  const ambientPath = join(home, 'ambient-roster.json');
  await writeFile(ambientPath, JSON.stringify({ version: 1, agents: [{ id: 'override', name: 'Ambient override' }] }));
  await start({ AGENT_ROSTER_PATH: ambientPath }); await ingest();
  assert.deepEqual((await agents()).map(({ id, name }) => ({ id, name })), [{ id: 'override', name: 'Ambient override' }]);
  await stop();
  for (const [name, contents] of [['missing.json', null], ['malformed.json', '{"private":"synthetic-private-marker" invalid'], ['oversize.json', 'x'.repeat(65537)]]) {
    const path = join(home, name); if (contents !== null) await writeFile(path, contents);
    const failed = spawnSync(process.execPath, [launcher, '--env-file', config], { cwd: consumer, env: { ...env, AGENT_ROSTER_PATH: path }, encoding: 'utf8', timeout: 5000 });
    assert.equal(failed.error, undefined); assert.equal(failed.status, 1);
    assert.match(failed.stderr, /AGENT_ROSTER_PATH/);
    assert.doesNotMatch(failed.stdout + failed.stderr, /synthetic-private-marker|server running/);
  }
  const prefs = JSON.parse(await readFile(join(generated.DATA_DIR, 'agent-prefs.json'), 'utf8'));
  assert.deepEqual(prefs.main.recipe, recipe);
  console.log(`Package verified: ${pkg.name}@${pkg.version}; ${files.size} files, script-disabled setup, enabled install notice, guided custom rosters, API/socket rename without rebuild, removal/re-addition persistence, env precedence, fail-closed startup, assets and key generation.`);
  if (values['pack-destination']) console.log(`Tested tarball: ${tarball}`);
} finally {
  await stop();
  await rm(fixture, { recursive: true, force: true });
}
