import React from 'react';
import express from 'express';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ControlAccessProvider } from '../control/ControlAccess';
import { AgentDetailPanel } from './AgentDetailPanel';
import { loadControlConfig } from '../../server/control/config';
import { createControlRouter } from '../../server/control/routes';
import { createTaskService } from '../../server/control/taskService';
import { createScheduleService } from '../../server/control/scheduleService';
import type { ControlGateway, ScheduleGateway } from '../../server/control/gatewayClient';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('real provider/private API creates disabled only after review and clears private drafts on lock', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pixel-schedule-component-'));
  const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:9/', PIXEL_CONTROL_TOKEN: 'synthetic-component-only-key' }, directory);
  let job: Record<string, unknown> | undefined; const nativeWrites: Record<string, unknown>[] = [];
  const reader: ControlGateway = { start() {}, close() {}, status: () => ({ configured: true, state: 'ready', canRead: true, canSend: false }), onEvent: () => () => {},
    request: async method => method === 'cron.list' ? { jobs: job ? [job] : [], total: job ? 1 : 0, offset: 0, limit: 50, hasMore: false, nextOffset: null, snapshotRevision: 'synthetic-1' } : { sessions: [] } };
  const manager: ScheduleGateway = { start() {}, close() {}, status: () => ({ configured: true, state: 'ready', canManage: true, epoch: 'synthetic-epoch', reason: null }),
    connection: () => ({ epoch: 'synthetic-epoch', gatewayUrl: 'ws://127.0.0.1:9/', deviceId: 'synthetic-device' }),
    request: async (method, params) => {
      if (method === 'cron.add') { nativeWrites.push(params!); job = { ...params, id: 'synthetic-job', configRevision: 'r1', state: {} }; return { created: true, job }; }
      if (method === 'cron.get') return job;
      throw Error(`Unexpected native mutation ${method}`);
    } };
  const schedules = createScheduleService({ reader, manager, config: { enabled: true, url: config.url, deviceDirectory: join(directory, 'control-schedules') }, registeredAgents: () => new Set(['cylena']) });
  const tasks = createTaskService(reader, () => new Set(['cylena']));
  const app = express(); app.use(express.json()); app.use('/api/control', createControlRouter({ gateway: reader, config, tasks, schedules }));
  const methods: string[] = [];
  // Real Express auth/validation/service/journal; only the browser transport and native host are synthetic.
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    methods.push(`${init?.method ?? 'GET'} ${path}`);
    const call = init?.method === 'POST' ? request(app).post(path) : request(app).get(path);
    for (const [key, value] of new Headers(init?.headers)) call.set(key, value);
    if (init?.body) call.send(JSON.parse(String(init.body)));
    const response = await call;
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }));
  try {
    render(<ControlAccessProvider><AgentDetailPanel agent={{ id: 'cylena', name: 'Synthetic agent', activity: 'idle', model: 'fixture', sessionKey: 'agent:cylena:fixture', active: false, pixelEnabled: true, tags: [], lastActivity: 0 }} onClose={() => {}} /></ControlAccessProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Schedules' }));
    fireEvent.change(await screen.findByLabelText('Task access key'), { target: { value: 'synthetic-component-only-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock task details' }));
    const create = await screen.findByRole('button', { name: 'New schedule' });
    await waitFor(() => expect(create).toBeEnabled()); fireEvent.click(create);
    fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Synthetic integration' } });
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'SYNTHETIC PRIVATE INTEGRATION PROMPT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review disabled creation' }));
    const review = await screen.findByRole('region', { name: 'Review schedule change' });
    expect(nativeWrites).toHaveLength(0);
    fireEvent.click(within(review).getByRole('button', { name: 'Create disabled schedule' }));
    await screen.findByText(/Native change acknowledged/);
    expect(nativeWrites).toHaveLength(1);
    expect(nativeWrites[0]).toMatchObject({ agentId: 'cylena', owner: { agentId: 'cylena' }, enabled: false, sessionTarget: 'isolated', wakeMode: 'now', deleteAfterRun: false, delivery: { mode: 'none' }, failureAlert: false });
    expect(fs.readFileSync(join(directory, 'control-schedules/journal.json'), 'utf8')).not.toContain('SYNTHETIC PRIVATE INTEGRATION PROMPT');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('button', { name: 'Enable Synthetic integration' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Synthetic integration' }));
    expect(screen.getByLabelText('Task prompt')).toHaveValue('SYNTHETIC PRIVATE INTEGRATION PROMPT');
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await waitFor(() => expect(screen.queryByLabelText('Task prompt')).toBeNull());
    expect(document.body.textContent).not.toContain('SYNTHETIC PRIVATE INTEGRATION PROMPT');
    expect(methods.filter(method => method.endsWith('/submit'))).toHaveLength(1);
    expect(methods.some(method => /reconcile|cron|socket/.test(method))).toBe(false);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  } finally { cleanup(); tasks.close(); await schedules.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
