// @vitest-environment node
import { execFile, spawnSync } from 'node:child_process';
import { Server } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const events = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'] as const;
let root: string; let rosterPath: string; let dataDir: string;
let modules: Array<typeof import('./index')> = [];
let beforeListeners: Map<string, Function[]>;
let timers: ReturnType<typeof vi.spyOn>;
const origin = 'https://pixel.test';
const both = [{ id: 'main', name: 'Coordinator' }, { id: 'researcher', name: '研究 Assistant' }];
function setRoster(agents = both) { writeFileSync(rosterPath, JSON.stringify({ version: 1, agents })); }
async function load(reset = true) { if (reset) vi.resetModules(); const module = await import('./index'); modules.push(module); return module; }
async function closeCurrent() { for (const module of modules.splice(0)) await new Promise<void>(resolve => module.io.close(() => resolve())); }
async function ingest(app: typeof import('./index')['app'], sessions: unknown[] = []) {
  await request(app).post('/api/ingest/agents').set('Authorization', 'Bearer roster-fixture').send({ sessions }).expect(200);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixel-roster-http-')); dataDir = join(root, 'data'); rosterPath = join(root, 'agents.json');
  mkdirSync(dataDir); setRoster();
  beforeListeners = new Map(events.map(event => [event, [...process.listeners(event)]]));
  timers = vi.spyOn(globalThis, 'setInterval');
  vi.stubEnv('DATA_DIR', dataDir); vi.stubEnv('AGENT_ROSTER_PATH', rosterPath);
  vi.stubEnv('DATA_SOURCE', 'ingest'); vi.stubEnv('INGEST_API_TOKEN', 'roster-fixture');
  vi.stubEnv('CORS_ORIGIN', origin); vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('PORT', '0');
  vi.stubEnv('OPENCLAW_GATEWAY_URL', ''); vi.stubEnv('PIXEL_CONTROL_TOKEN', '');
});
afterEach(async () => {
  await closeCurrent();
  for (const result of timers.mock.results) if (result.type === 'return') clearInterval(result.value as ReturnType<typeof setInterval>);
  for (const event of events) for (const listener of process.listeners(event)) if (!beforeListeners.get(event)?.includes(listener)) process.removeListener(event, listener);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true });
});

it('publishes only configured agents with configured active and sleeping names', async () => {
  const { app } = await load();
  await ingest(app, [{ agentId: 'researcher', key: 'agent:researcher:fixture', updatedAt: Date.now() }]);
  const result = await request(app).get('/api/agents').expect(200);
  expect(result.body.agents).toEqual([
    expect.objectContaining({ id: 'main', name: 'Coordinator', activity: 'sleeping', active: false }),
    expect.objectContaining({ id: 'researcher', name: '研究 Assistant', active: true, tags: [], roomId: 'office' }),
  ]);
  await request(app).post('/api/ingest/agents').set('Authorization', 'Bearer roster-fixture').send({ sessions: [{ agentId: 'miku', key: 'agent:miku:unregistered' }] }).expect(400);
  await request(app).put('/api/agents/miku/recipe').set('Origin', origin).send({ bodyIndex: 0, hairIndex: 0, outfitIndex: 0 }).expect(404);
});
it('keeps saved preferences through rename, removal, another save and re-addition', async () => {
  const recipe = { bodyIndex: 4, hairIndex: 7, outfitIndex: 5 };
  let { app } = await load(); await ingest(app);
  await request(app).put('/api/agents/researcher/recipe').set('Origin', origin).send(recipe).expect(200);
  await request(app).put('/api/agents/researcher/tags').set('Origin', origin).send({ tags: ['analysis'] }).expect(200);
  await request(app).post('/api/agents/researcher/toggle').set('Origin', origin).send({ enabled: false }).expect(200);
  await closeCurrent(); setRoster([{ id: 'main', name: 'Coordinator' }, { id: 'researcher', name: 'New public name' }]);
  ({ app } = await load()); await ingest(app);
  expect((await request(app).get('/api/agents')).body.agents.find((agent: { id: string }) => agent.id === 'researcher')).toMatchObject({ name: 'New public name', recipe, tags: ['analysis'], pixelEnabled: false });
  await closeCurrent(); setRoster([{ id: 'main', name: 'Coordinator' }]);
  ({ app } = await load()); await ingest(app);
  await request(app).post('/api/agents/main/toggle').set('Origin', origin).send({ enabled: false }).expect(200);
  expect(JSON.parse(readFileSync(join(dataDir, 'agent-prefs.json'), 'utf8')).researcher).toMatchObject({ recipe, tags: ['analysis'], pixelEnabled: false });
  await closeCurrent(); setRoster(); ({ app } = await load()); await ingest(app);
  expect((await request(app).get('/api/agents')).body.agents.find((agent: { id: string }) => agent.id === 'researcher')).toMatchObject({ name: '研究 Assistant', recipe, tags: ['analysis'], pixelEnabled: false });
});
it('does not retain invalid persisted keys or invalid preference records', async () => {
  writeFileSync(join(dataDir, 'agent-prefs.json'), '{"__proto__":{"pixelEnabled":false},"bad/id":{"pixelEnabled":false},"orphan":{"recipe":{"bodyIndex":99}},"retained":{"pixelEnabled":false}}');
  const { app } = await load();
  await request(app).post('/api/agents/main/toggle').set('Origin', origin).send({ enabled: true }).expect(200);
  const prefs = JSON.parse(readFileSync(join(dataDir, 'agent-prefs.json'), 'utf8'));
  expect(prefs.retained).toEqual({ pixelEnabled: false });
  expect(Object.keys(prefs).sort()).toEqual(['main', 'researcher', 'retained']);
});
it('warns about rejected persisted identities without logging the untrusted key', () => {
  writeFileSync(join(dataDir, 'agent-prefs.json'), JSON.stringify({ ['synthetic-hidden-key\u001b']: { pixelEnabled: false }, 'another/invalid': { pixelEnabled: false } }));
  const module = fileURLToPath(new URL('./index.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', `const {io}=require(${JSON.stringify(module)});io.close();`],
    { env: { ...process.env, LOG_LEVEL: 'warn' }, encoding: 'utf8', timeout: 5000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/invalid agent ID/);
  expect(result.stdout + result.stderr).not.toContain('synthetic-hidden-key');
  const warnings = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(warnings).toEqual([expect.objectContaining({ subsystem: 'prefs', invalidAgentIdCount: 2 })]);
});
it('keeps a custom shodan seat through removal, unrelated layout save, restart and re-addition', async () => {
  setRoster([{ id: 'main', name: 'Coordinator' }, { id: 'shodan', name: 'Custom' }]);
  let { app } = await load();
  const created = await request(app).post('/api/layouts').set('Origin', origin).send({ name: 'Seat preservation', width: 24, height: 16, furniture: [], seats: { shodan: { x: 9, y: 4 } } }).expect(200);
  const id = created.body.layout.id;
  await closeCurrent(); setRoster([{ id: 'main', name: 'Coordinator' }]); ({ app } = await load());
  const current = (await request(app).get(`/api/layouts/${id}`).expect(200)).body;
  await request(app).put(`/api/layouts/${id}`).set('Origin', origin).send({ name: 'Unrelated edit', baseUpdatedAt: current.updatedAt }).expect(200);
  await closeCurrent(); setRoster([{ id: 'main', name: 'Coordinator' }, { id: 'shodan', name: 'Restored' }]); ({ app } = await load());
  const restored = (await request(app).get(`/api/layouts/${id}`).expect(200)).body;
  expect(restored.seats).toEqual({ shodan: { x: 9, y: 4 } });
  expect(JSON.parse(readFileSync(join(dataDir, 'layouts', `${id}.json`), 'utf8')).seats).toEqual(restored.seats);
});
it('uses the custom registry in the real CLI polling path', async () => {
  vi.stubEnv('DATA_SOURCE', 'cli');
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: null, stdout: string, stderr: string) => void;
    callback(null, JSON.stringify({ sessions: [{ agentId: 'researcher', key: 'agent:researcher:fixture', updatedAt: Date.now() }] }), '');
    return {};
  }) as typeof execFile);
  const { server, startServer } = await load(); const listening = once(server, 'listening'); startServer(); await listening;
  await vi.waitFor(async () => {
    const result = await request(server).get('/api/agents');
    expect(result.body.agents).toEqual([expect.objectContaining({ id: 'main', name: 'Coordinator', active: false }), expect.objectContaining({ id: 'researcher', name: '研究 Assistant', active: true })]);
  });
});
it('fails before listener/polling/Gateway construction and can import cleanly after repair', async () => {
  vi.resetModules();
  const gateway = await import('./control/gatewayClient'); const createGateway = vi.spyOn(gateway, 'createControlGateway');
  const listen = vi.spyOn(Server.prototype, 'listen'); const execBefore = vi.mocked(execFile).mock.calls.length;
  writeFileSync(rosterPath, '{"version":1,"agents":[]}');
  await expect(load(false)).rejects.toThrow(/roster/i);
  expect(listen).not.toHaveBeenCalled(); expect(createGateway).not.toHaveBeenCalled(); expect(vi.mocked(execFile).mock.calls).toHaveLength(execBefore);
  setRoster(); vi.resetModules();
  const repairedGateway = await import('./control/gatewayClient'); const repairedCreate = vi.spyOn(repairedGateway, 'createControlGateway');
  const repaired = await load(false); expect(repairedCreate).toHaveBeenCalledOnce(); await ingest(repaired.app);
  expect((await request(repaired.app).get('/api/agents')).body.agents).toHaveLength(2);
});
