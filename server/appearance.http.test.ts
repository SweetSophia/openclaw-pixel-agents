import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentState } from '../shared/types';

const itPosix = process.platform === 'win32' ? it.skip : it;

describe('durable agent appearance across bridge snapshots and restarts', () => {
  let runtime: typeof import('./index');
  let dataDir: string;
  const origin = 'https://pixel.test';
  const mainRecipe = { bodyIndex: 4, hairIndex: 3, outfitIndex: 5 };
  const mikuRecipe = { bodyIndex: 0, hairIndex: 7, outfitIndex: 1 };

  const close = async () => { await new Promise<void>(resolve => runtime.io.close(() => resolve())); };
  const ingest = () => request(runtime.app).post('/api/ingest/agents').auth('appearance-fixture', { type: 'bearer' }).send({ sessions: [] }).expect(200);
  const agents = async () => (await request(runtime.app).get('/api/agents').expect(200)).body.agents as AgentState[];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pixel-appearance-'));
    vi.stubEnv('DATA_DIR', dataDir);
    vi.stubEnv('DATA_SOURCE', 'ingest');
    vi.stubEnv('INGEST_API_TOKEN', 'appearance-fixture');
    vi.stubEnv('OPENCLAW_AGENTS_DIR', join(dataDir, 'agents'));
    vi.stubEnv('OPENCLAW_GATEWAY_URL', '');
    vi.stubEnv('PIXEL_CONTROL_TOKEN', '');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ORIGIN', origin);
    vi.resetModules();
    runtime = await import('./index');
  });
  afterEach(async () => {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules();
  });

  it('returns distinct authoritative recipes before any browser has customized an agent', async () => {
    await ingest();
    const snapshot = await agents();
    expect(snapshot.find(agent => agent.id === 'main')?.recipe).toEqual({ bodyIndex: 3, hairIndex: 0, outfitIndex: 2 });
    expect(snapshot.find(agent => agent.id === 'miku')?.recipe).toEqual({ bodyIndex: 1, hairIndex: 6, outfitIndex: 0 });
    expect(new Set(snapshot.map(agent => JSON.stringify(agent.recipe))).size).toBe(8);
  });

  it('serves saved recipes to a new client after repeated bridge snapshots and server bootstrap', async () => {
    await ingest();
    for (const [id, recipe] of [['main', mainRecipe], ['miku', mikuRecipe]] as const) {
      await request(runtime.app).put(`/api/agents/${id}/recipe`).set('Origin', origin).send(recipe).expect(200);
    }
    await ingest(); await ingest();
    expect((await agents()).find(agent => agent.id === 'main')?.recipe).toEqual(mainRecipe);
    await close(); vi.resetModules(); runtime = await import('./index');
    await ingest();
    const freshClient = await agents();
    expect(freshClient.find(agent => agent.id === 'main')?.recipe).toEqual(mainRecipe);
    expect(freshClient.find(agent => agent.id === 'miku')?.recipe).toEqual(mikuRecipe);
    expect(JSON.parse(readFileSync(join(dataDir, 'agent-prefs.json'), 'utf8'))).toMatchObject({
      main: { recipe: mainRecipe }, miku: { recipe: mikuRecipe },
    });
  });

  itPosix.each([
    { path: 'recipe', method: 'put', body: mikuRecipe, expected: { recipe: mikuRecipe } },
    { path: 'sprite', method: 'post', body: { spriteId: 'char_4' }, expected: { characterSpriteId: 'char_4' } },
    { path: 'toggle', method: 'post', body: { enabled: false }, expected: { pixelEnabled: false } },
    { path: 'tags', method: 'put', body: { tags: ['creative'] }, expected: { tags: ['creative'] } },
  ] as const)('keeps replaced $path preferences consistent with fresh bootstrap when directory sync cannot confirm durability', async ({ path, method, body, expected }) => {
    await ingest();
    await request(runtime.app).put('/api/agents/main/recipe').set('Origin', origin).send(mainRecipe).expect(200);
    const persistence = await import('./persistence');
    const actualWrite = persistence.atomicWriteFileSync;
    vi.spyOn(persistence, 'atomicWriteFileSync').mockImplementationOnce((directory, name, contents, options) => {
      actualWrite(directory, name, contents, { ...options, syncFile: () => { throw new Error('fixture directory sync failure'); } });
    });
    const emit = vi.spyOn(runtime.io, 'emit');
    const response = await request(runtime.app)[method](`/api/agents/main/${path}`).set('Origin', origin).send(body);
    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/applied.*durable saving could not be confirmed/i);
    const applied = (await agents()).find(agent => agent.id === 'main');
    expect(applied).toMatchObject(expected);
    expect(JSON.parse(readFileSync(join(dataDir, 'agent-prefs.json'), 'utf8')).main).toMatchObject(expected);
    if (path === 'recipe') expect(emit).toHaveBeenCalledWith('recipe-update', { agentId: 'main', recipe: mikuRecipe });
    else expect(emit).toHaveBeenCalledWith('agents:update', expect.arrayContaining([expect.objectContaining(expected)]));
    if (path === 'tags') expect(applied?.roomId).toBe('lounge');
    await close(); vi.resetModules(); runtime = await import('./index');
    await ingest();
    expect((await agents()).find(agent => agent.id === 'main')).toMatchObject(expected);
  });

  it.each([
    { path: 'recipe', method: 'put', body: mikuRecipe },
    { path: 'sprite', method: 'post', body: { spriteId: 'char_4' } },
    { path: 'toggle', method: 'post', body: { enabled: false } },
    { path: 'tags', method: 'put', body: { tags: ['creative'] } },
  ] as const)('rejects a failed $path disk write without changing the current or next snapshot', async ({ path, method, body }) => {
    await ingest();
    await request(runtime.app).put('/api/agents/main/recipe').set('Origin', origin).send(mainRecipe).expect(200);
    const before = (await agents()).find(agent => agent.id === 'main');
    const emit = vi.spyOn(runtime.io, 'emit');
    const file = join(dataDir, 'agent-prefs.json');
    const retained = join(dataDir, 'retained-prefs.json');
    renameSync(file, retained); mkdirSync(file); // A real rename failure, independent of user/root permission differences.
    try {
      await request(runtime.app)[method](`/api/agents/main/${path}`).set('Origin', origin).send(body).expect(500);
      expect((await agents()).find(agent => agent.id === 'main')).toEqual(before);
      expect(emit.mock.calls.filter(([name]) => name === 'recipe-update' || name === 'agents:update')).toHaveLength(0);
    } finally {
      rmSync(file, { recursive: true, force: true }); renameSync(retained, file);
    }
    await ingest();
    expect((await agents()).find(agent => agent.id === 'main')).toEqual(before);
    await close(); vi.resetModules(); runtime = await import('./index');
    await ingest();
    expect((await agents()).find(agent => agent.id === 'main')?.recipe).toEqual(mainRecipe);
  });
});
