// @vitest-environment node
import express from 'express';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadControlConfig } from './config';
import { createControlRouter } from './routes';
import { createTaskService } from './taskService';
import { createScheduleService, type ScheduleService } from './scheduleService';
import type { ControlGateway, ScheduleGateway } from './gatewayClient';

const directories: string[] = []; const services: ScheduleService[] = []; const cleanups: Array<() => void> = [];
function fixture(enabled = true, manage = false) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pixel-schedule-http-')); directories.push(directory);
  const config = loadControlConfig(enabled ? { OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:9', PIXEL_CONTROL_TOKEN: 'synthetic-schedule-key' } : {}, directory);
  const reader: ControlGateway = { start: vi.fn(), close: vi.fn(), status: () => ({ configured: enabled, state: enabled ? 'ready' : 'disabled', canRead: enabled, canSend: false }),
    onEvent: () => () => {}, request: vi.fn(async () => ({ jobs: [], snapshotRevision: 'synthetic-revision', total: 0, offset: 0, limit: 50, hasMore: false, nextOffset: null })) };
  const manager: ScheduleGateway = { start: vi.fn(), close: vi.fn(), status: () => ({ configured: manage, state: manage ? 'pairing-required' : 'disabled', canManage: false, epoch: null, reason: manage ? 'pairing-required' : 'disabled' }), connection: () => null, request: vi.fn() };
  const schedules = createScheduleService({ reader, manager, config: { enabled: manage, deviceDirectory: join(directory, 'control-schedules') }, registeredAgents: () => new Set(['main', 'Upper']) }); services.push(schedules);
  const tasks = createTaskService(reader, () => new Set(['main', 'Upper'])); cleanups.push(() => tasks.close());
  vi.mocked(reader.request).mockClear();
  const app = express(); app.use('/api/control', createControlRouter({ gateway: reader, tasks, config, schedules }));
  return { app, reader, manager, schedules, directory };
}
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('private agent schedule routes', () => {
  const path = '/api/control/agents/main/schedules';
  it('authenticates_before_lazy_management_and_returns_no_store_without_a_session', async () => {
    const f = fixture(true, true);
    for (const endpoint of [path, `${path}/operations`]) {
      const locked = await request(f.app).get(endpoint).auth('wrong-key', { type: 'bearer' });
      expect(locked.status).toBe(401); expect(locked.headers['cache-control']).toBe('no-store');
    }
    expect(f.manager.start).not.toHaveBeenCalled(); expect(f.reader.request).not.toHaveBeenCalled();
    const operations = await request(f.app).get(`${path}/operations`).auth('synthetic-schedule-key', { type: 'bearer' });
    expect(operations.body).toEqual([]); expect(operations.headers['cache-control']).toBe('no-store'); expect(f.manager.start).not.toHaveBeenCalled();
    const result = await request(f.app).get(path).auth('synthetic-schedule-key', { type: 'bearer' });
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ agentId: 'main', jobs: [], management: { state: 'pairing-required', canManage: false } });
    expect(result.headers['cache-control']).toBe('no-store'); expect(f.manager.start).toHaveBeenCalledTimes(1);
    expect(f.reader.request).toHaveBeenCalledWith('cron.list', expect.objectContaining({ agentId: 'main' }), expect.any(AbortSignal));
    expect(fs.readdirSync(f.directory)).toEqual([]);
  });
  it('retains_literal_parent_identity_and_rejects_unknown_agents_and_invalid_cursors', async () => {
    const f = fixture();
    expect((await request(f.app).get('/api/control/agents/missing/schedules').auth('synthetic-schedule-key', { type: 'bearer' })).status).toBe(404);
    expect((await request(f.app).get('/api/control/agents/Upper/schedules').auth('synthetic-schedule-key', { type: 'bearer' })).body.code).toBe('schedule-denied');
    for (const query of ['cursor=', 'cursor=a&cursor=b', `cursor=${'x'.repeat(2049)}`, 'offset=1']) {
      expect((await request(f.app).get(`${path}?${query}`).auth('synthetic-schedule-key', { type: 'bearer' })).status).toBe(400);
    }
    const expired = await request(f.app).get(`${path}?cursor=unknown`).auth('synthetic-schedule-key', { type: 'bearer' });
    expect(expired.status).toBe(409); expect(expired.body.code).toBe('schedule-changed');
    expect(f.reader.request).not.toHaveBeenCalled();
  });
  it('rejects_forwarded_transport_unconfigured_control_and_every_mutation', async () => {
    const f = fixture(); f.app.set('trust proxy', 1);
    expect((await request(f.app).get(path).set('X-Forwarded-For', '198.51.100.4').auth('synthetic-schedule-key', { type: 'bearer' })).status).toBe(403);
    const disabled = fixture(false); const result = await request(disabled.app).get(path).auth('synthetic-schedule-key', { type: 'bearer' });
    expect(result.status).toBe(503); expect(result.body.code).toBe('disabled'); expect(disabled.reader.request).not.toHaveBeenCalled();
    for (const endpoint of [path, `${path}/create`, `${path}/rpc`, `${path}/operations`]) expect((await request(f.app).post(endpoint).auth('synthetic-schedule-key', { type: 'bearer' }).send({})).status).toBe(404);
    expect(f.manager.request).not.toHaveBeenCalled();
  });
  it.each([false, true])('uses_real_app_origin_and_close_wiring_without_startServer_or_real_host_configuration (disposal rejection: %s)', async failClose => {
    const f = fixture(true, true); vi.resetModules();
    const events = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'] as const;
    const listeners = new Map(events.map(event => [event, [...process.listeners(event)]])); const intervals = vi.spyOn(globalThis, 'setInterval');
    for (const [key, value] of Object.entries({ DATA_DIR: f.directory, DATA_SOURCE: 'ingest', INGEST_API_TOKEN: 'synthetic-ingest-key', AGENT_ROSTER_PATH: '',
      NODE_ENV: 'production', CORS_ORIGIN: 'https://pixel.synthetic.test', PORT: '0', LOG_LEVEL: 'silent',
      OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:9', PIXEL_CONTROL_TOKEN: 'synthetic-schedule-key', OPENCLAW_GATEWAY_TOKEN: '', OPENCLAW_GATEWAY_PASSWORD: '',
      CONTROL_SCHEDULES_MANAGE_ENABLED: 'true', OPENCLAW_SCHEDULES_GATEWAY_TOKEN: '', OPENCLAW_SCHEDULES_GATEWAY_PASSWORD: '',
      CONTROL_SEND_ENABLED: 'false', CONTROL_APPROVALS_ENABLED: 'false', CONTROL_ALLOW_TAILNET_HTTP: 'false' })) vi.stubEnv(key, value);
    const closeService = vi.spyOn(f.schedules, 'close');
    vi.doMock('./gatewayClient', async importOriginal => ({ ...await importOriginal<typeof import('./gatewayClient')>(), createControlGateway: () => f.reader, createScheduleGateway: () => f.manager }));
    vi.doMock('./scheduleService', () => ({ createScheduleService: () => f.schedules }));
    const runtime = await import('../index');
    const { logger } = await import('../logger'); const logged = vi.spyOn(logger, 'error');
    try {
      await new Promise<void>(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
      expect(f.manager.start).not.toHaveBeenCalled();
      const forbidden = await request(runtime.server).post(path).set('Origin', 'https://foreign.synthetic.test').auth('synthetic-schedule-key', { type: 'bearer' }).send({});
      expect(forbidden.status).toBe(403); expect(f.manager.start).not.toHaveBeenCalled();
      const result = await request(runtime.server).get(path).set('Origin', 'https://pixel.synthetic.test').auth('synthetic-schedule-key', { type: 'bearer' });
      expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
      if (failClose) vi.mocked(f.manager.close).mockImplementation(() => { throw Error('synthetic-private-disposal-detail'); });
      await new Promise<void>(resolve => runtime.server.close(() => resolve()));
      expect(closeService).toHaveBeenCalled();
      if (failClose) {
        await expect(closeService.mock.results[0].value).rejects.toMatchObject({ code: 'unavailable' });
        expect(logged).toHaveBeenCalledWith({ subsystem: 'control-schedules', code: 'unavailable' }, 'private scheduling disposal failed');
        expect(JSON.stringify(logged.mock.calls)).not.toContain('synthetic-private-disposal-detail');
      } else await closeService.mock.results[0].value;
      expect(f.manager.close).toHaveBeenCalledTimes(1); expect(f.reader.close).toHaveBeenCalled();
    } finally {
      await runtime.io.close(); for (const timer of intervals.mock.results) if (timer.type === 'return') clearInterval(timer.value);
      for (const event of events) for (const listener of process.listeners(event)) if (!listeners.get(event)?.includes(listener)) process.removeListener(event, listener);
      vi.doUnmock('./gatewayClient'); vi.doUnmock('./scheduleService'); vi.resetModules();
      if (failClose) services.splice(services.indexOf(f.schedules), 1);
    }
  });
});
