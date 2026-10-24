// @vitest-environment node
import express, { type Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContentBudget } from './contentBudget';

afterEach(() => vi.restoreAllMocks());
describe('independent private content admission', () => {
  it('admits only two concurrent transfers and releases each response once across finish and close', async () => {
    const app = express(); const pending: Response[] = [];
    app.post('/file', createContentBudget(), (_req, res) => { pending.push(res); });
    const first = request(app).post('/file').then(response => response); const second = request(app).post('/file').then(response => response);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect((await request(app).post('/file')).status).toBe(429);
    pending[0].end('done'); await first;
    const replacement = request(app).post('/file').then(response => response); await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect((await request(app).post('/file')).status).toBe(429);
    pending[1].end('done'); pending[2].end('done'); await Promise.all([second, replacement]);
  });
  it('allows six admitted requests per IP per minute and reopens after the window expires', async () => {
    const app = express(); app.post('/file', createContentBudget(), (_req, res) => res.end('done'));
    for (let index = 0; index < 6; index++) expect((await request(app).post('/file')).status).toBe(200);
    const denied = await request(app).post('/file'); expect(denied.status).toBe(429); expect(denied.body.code).toBe('rate-limited');
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 60001);
    expect((await request(app).post('/file')).status).toBe(200);
  });
});
