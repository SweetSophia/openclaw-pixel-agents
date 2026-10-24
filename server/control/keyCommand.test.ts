// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { createControlAccess } from './access';
import { loadControlConfig } from './config';

it('generates a fresh operator key accepted by task access without revealing an existing configured key', async () => {
  const existing = 'a'.repeat(64);
  const generate = () => spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/generate-control-key.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, PIXEL_CONTROL_TOKEN: existing },
  });
  const first = generate(); const second = generate();
  expect(first.status).toBe(0); expect(second.status).toBe(0);
  expect(first.stderr).toBe(''); expect(first.stdout).toMatch(/^[a-f0-9]{64}\n$/);
  const key = first.stdout.trim();
  expect(key).not.toBe(existing); expect(key).not.toBe(second.stdout.trim());
  const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'ws://localhost:18789', PIXEL_CONTROL_TOKEN: key }, '/tmp/key-command-fixture');
  const app = express(); app.use(createControlAccess(config)); app.get('/', (_req, res) => res.json({ unlocked: true }));
  expect((await request(app).get('/').auth(key, { type: 'bearer' })).status).toBe(200);
  expect((await request(app).get('/').auth(existing, { type: 'bearer' })).status).toBe(401);
});
