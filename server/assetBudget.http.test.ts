import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe('default public budget for cold office browsers', () => {
  let runtime: typeof import('./index');
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'pixel-asset-budget-'));
    const frontend = join(root, 'client');
    mkdirSync(join(frontend, 'assets'), { recursive: true });
    writeFileSync(join(frontend, 'index.html'), '<!doctype html><title>Office fixture</title>');
    // A cold office loads roughly 80 static requests: manifests, sprites, floors and source sheets.
    for (let asset = 0; asset < 80; asset++) writeFileSync(join(frontend, 'assets', `sprite-${asset}.txt`), 'fixture');
    vi.stubEnv('DATA_DIR', join(root, 'data'));
    vi.stubEnv('DATA_SOURCE', 'ingest'); vi.stubEnv('INGEST_API_TOKEN', 'asset-budget-fixture');
    vi.stubEnv('OPENCLAW_GATEWAY_URL', ''); vi.stubEnv('PIXEL_CONTROL_TOKEN', '');
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('CORS_ORIGIN', 'https://pixel.test');
    vi.stubEnv('FRONTEND_DIR', frontend); vi.stubEnv('PUBLIC_GET_RATE_LIMIT_MAX', undefined);
    vi.stubEnv('TRUST_PROXY', undefined);
    vi.resetModules(); runtime = await import('./index');
  });
  beforeEach(() => runtime._resetRateLimitBuckets());
  afterAll(async () => {
    await new Promise<void>(resolve => runtime.io.close(() => resolve()));
    rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.resetModules();
  });

  it('serves complete cold asset loads for four browsers sharing one IP', async () => {
    for (let browser = 0; browser < 4; browser++) {
      await request(runtime.app).get('/').expect(200);
      for (let asset = 0; asset < 80; asset++) {
        await request(runtime.app).get(`/assets/sprite-${asset}.txt?v=${'a'.repeat(32)}`).expect(200);
      }
    }
  });

  it('still bounds shared GET and HEAD traffic at the default public limit', async () => {
    for (let asset = 0; asset < 512; asset++) await request(runtime.app).get('/assets/sprite-0.txt').expect(200);
    const blocked = await request(runtime.app).head('/assets/sprite-0.txt').expect(429);
    expect(blocked.headers['x-ratelimit-limit']).toBe('512');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    await request(runtime.app).get('/api/status').expect(200);
  });
});
