import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2] ?? 'openclaw-pixel-agents:ci';
assert(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image), 'Supply a Docker image name, not options');
const docker = args => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, `Docker ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
};
const temporaryRoot = tmpdir();
assert(!temporaryRoot.includes(','), 'TMPDIR must not contain a comma for the Docker bind-mount smoke');
const root = await mkdtemp(join(temporaryRoot, 'pixel-roster-docker-'));
const directory = join(root, 'roster'); const path = join(directory, 'agents.json');
const owned = [];
const token = randomBytes(32).toString('hex');
const origin = 'http://roster.test';
const first = [{ id: 'main', name: 'Docker Coordinator' }, { id: 'sub-worker', name: 'Docker Worker 研究' }];
const updated = [{ id: 'main', name: 'Docker Coordinator' }, { id: 'sub-worker', name: 'Renamed without an image rebuild' }];
const writeRoster = async agents => {
  const temporary = join(directory, 'new.json');
  await writeFile(temporary, JSON.stringify({ version: 1, agents })); await chmod(temporary, 0o644);
  await rename(temporary, path);
};
function create(suffix, publish = false) {
  const id = docker(['create', '--name', `pixel-roster-${process.pid}-${randomBytes(4).toString('hex')}-${suffix}`,
    ...(publish ? ['--publish', '127.0.0.1::3001'] : []),
    '--env', `CORS_ORIGIN=${origin}`, '--env', 'DATA_SOURCE=ingest', '--env', `INGEST_API_TOKEN=${token}`,
    '--env', 'AGENT_ROSTER_PATH=/run/pixel/agents.json',
    '--mount', `type=bind,source=${directory},target=/run/pixel,readonly`, '--volume', '/app/data', image]);
  assert(/^[a-f0-9]{64}$/.test(id)); owned.push(id); return id;
}
function baseFor(id) {
  const binding = docker(['port', id, '3001/tcp']); assert(/^127\.0\.0\.1:\d+$/.test(binding));
  return `http://${binding}`;
}
async function ready(base) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1000) })).ok) return; }
    catch { /* Bounded startup retry for this fixture only. */ }
    await delay(100);
  }
  throw Error('Configured Docker fixture did not become ready');
}
async function snapshot(base) {
  const response = await fetch(`${base}/api/ingest/agents`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"sessions":[]}', signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return (await (await fetch(`${base}/api/agents`, { signal: AbortSignal.timeout(5000) })).json()).agents.map(({ id, name }) => ({ id, name }));
}

try {
  await mkdir(directory); await chmod(directory, 0o755); // Synthetic public roster only; no secret files are mounted.
  await writeRoster(first);
  const id = create('valid', true); docker(['start', id]);
  assert(/^[1-9]\d*$/.test(docker(['exec', id, 'id', '-u'])), 'Docker roster fixture must run as a non-root user');
  const mounts = JSON.parse(docker(['inspect', '--format', '{{json .Mounts}}', id]));
  assert(mounts.some(mount => mount.Type === 'bind' && mount.Destination === '/run/pixel' && mount.RW === false), 'Docker roster fixture requires a read-only roster bind mount');
  let base = baseFor(id);
  await ready(base); assert.deepEqual(await snapshot(base), first);
  assert.equal((await fetch(base, { signal: AbortSignal.timeout(5000) })).status, 200);
  assert.equal((await fetch(`${base}/assets/furniture/DESK/manifest.json`, { signal: AbortSignal.timeout(5000) })).status, 200);
  const originalImage = docker(['inspect', '--format', '{{.Image}}', id]);
  await writeRoster(updated);
  assert.deepEqual(await snapshot(base), first, 'Editing the file must not hot-reload it');
  docker(['restart', '--timeout', '5', id]);
  base = baseFor(id); // Docker can reassign an ephemeral host port on restart.
  await ready(base); assert.deepEqual(await snapshot(base), updated);
  assert.equal(docker(['inspect', '--format', '{{.Image}}', id]), originalImage);
  docker(['stop', '--timeout', '5', id]);
  await writeRoster([]);
  const invalid = create('invalid'); docker(['start', invalid]);
  assert.equal(docker(['wait', invalid]), '1');
  const diagnostic = docker(['logs', invalid]);
  assert.match(diagnostic, /Invalid roster/); assert.doesNotMatch(diagnostic, /server running/);
  console.log('Docker roster verified: read-only directory mount, non-root file access, real API/SPA/assets, host file replacement, restart without rebuild, no hot reload and fail-closed invalid startup.');
} catch (error) {
  for (const id of owned) { try { console.error(docker(['logs', '--tail', '20', id])); } catch { /* Original failure wins. */ } }
  throw error;
} finally {
  for (const id of owned) { try { docker(['rm', '--force', '--volumes', id]); } catch { /* Reported Docker failure must not prevent local cleanup. */ } }
  await rm(root, { recursive: true, force: true });
}
