// @vitest-environment node
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createControlAccess, controlTransportAllowed, matchesControlToken } from './access';
import { loadControlConfig } from './config';

const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'ws://localhost:18789', PIXEL_CONTROL_TOKEN: 'fixture-key' }, '/tmp/fixture');
describe('private task access', () => {
  it('compares fixed-size token digests for equal and unequal lengths', () => {
    expect(matchesControlToken('fixture-key', 'fixture-key')).toBe(true);
    for (const key of ['', 'fixture-kex', 'x'.repeat(200), 'x'.repeat(20000)]) expect(matchesControlToken(key, 'fixture-key')).toBe(false);
  });
  it('requires a bounded bearer token and applies independent access budgets', async () => {
    const app = express(); app.use(createControlAccess(config)); app.get('/', (_req, res) => res.json({ private: true }));
    expect((await request(app).get('/')).status).toBe(401);
    expect((await request(app).get('/').set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(app).get('/').set('Authorization', `Bearer ${'x'.repeat(5000)}`)).status).toBe(401);
    for (let i = 0; i < 120; i++) expect((await request(app).get('/').auth('fixture-key', { type: 'bearer' })).status).toBe(200);
    expect((await request(app).get('/').auth('fixture-key', { type: 'bearer' })).status).toBe(429);
    const denied = express(); denied.use(createControlAccess(config));
    for (let i = 0; i < 60; i++) expect((await request(denied).get('/')).status).toBe(401);
    expect((await request(denied).get('/')).status).toBe(429);
  });
  it('requires actual direct Tailnet endpoints, ignoring forwarded headers', () => {
    const interfaces = { tailscale0: [{ address: '100.100.1.1' }, { address: 'fd7a:115c:a1e0::1' }] };
    const req = (localAddress: string, remoteAddress: string, secure = false) => ({ secure, socket: { localAddress, remoteAddress }, headers: { 'x-forwarded-proto': 'https' } });
    expect(controlTransportAllowed(req('192.168.1.2', '192.168.1.3'), true, interfaces)).toBe(false);
    expect(controlTransportAllowed(req('100.100.1.1', '100.64.2.2'), false, interfaces)).toBe(false);
    expect(controlTransportAllowed(req('100.100.1.1', '100.64.2.2'), true, interfaces)).toBe(true);
    expect(controlTransportAllowed(req('192.168.1.2', '100.64.2.2'), true, interfaces)).toBe(false);
    expect(controlTransportAllowed(req('100.100.1.1', '192.168.1.3'), true, interfaces)).toBe(false);
    expect(controlTransportAllowed(req('fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::2'), true, interfaces)).toBe(true);
    expect(controlTransportAllowed(req('127.0.0.1', '127.0.0.1'), false, {})).toBe(true);
    expect(controlTransportAllowed(req('192.168.1.2', '192.168.1.3', true), false, {})).toBe(true);
  });
  it('does not mistake a trusted loopback proxy for a local development client', () => {
    const req = { secure: false, ip: '203.0.113.4', socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.4', 'x-forwarded-proto': 'http' } };
    expect(controlTransportAllowed(req, false, {})).toBe(false);
    expect(controlTransportAllowed({ ...req, secure: true }, false, {})).toBe(true);
  });
});
