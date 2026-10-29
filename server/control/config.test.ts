// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadControlConfig } from './config';

const key = 'fixture-control-access-key';
describe('opt-in task Gateway configuration', () => {
  it('requires an exact explicit approvals opt-in independent of sending', () => {
    for (const value of [undefined, 'false', 'TRUE', '1']) expect(loadControlConfig({ CONTROL_APPROVALS_ENABLED: value }, '/tmp/fixture').approvalsEnabled).toBe(false);
    expect(loadControlConfig({ CONTROL_APPROVALS_ENABLED: 'true' }, '/tmp/fixture')).toMatchObject({ approvalsEnabled: true, sendEnabled: false });
  });
  it('disables task access when URL or separate operator key is missing', () => {
    expect(loadControlConfig({}, '/tmp/fixture').enabled).toBe(false);
    expect(loadControlConfig({ OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:18789' }, '/tmp/fixture').enabled).toBe(false);
  });
  it('accepts encrypted endpoints and explicit loopback plaintext only', () => {
    for (const url of ['wss://gateway.example/socket', 'ws://127.0.0.1:18789', 'ws://[::1]:18789']) {
      const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: url, PIXEL_CONTROL_TOKEN: key }, '/tmp/fixture');
      expect(config.enabled).toBe(true);
      expect(config.sendEnabled).toBe(false);
      expect(config.deviceDirectory).toBe('/tmp/fixture/control');
    }
  });
  it('rejects remote plaintext, embedded credentials, queries and fragments', () => {
    for (const url of ['ws://100.123.144.72:18789', 'https://gateway.example', 'wss://user:secret@gateway.example', 'wss://gateway.example/?token=secret', 'wss://gateway.example/#fragment']) {
      expect(() => loadControlConfig({ OPENCLAW_GATEWAY_URL: url, PIXEL_CONTROL_TOKEN: key }, '/tmp/fixture')).toThrow();
    }
  });
  it('makes write capability and the Tailnet HTTP exception explicit opt-ins', () => {
    const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'ws://localhost:18789', PIXEL_CONTROL_TOKEN: key, CONTROL_SEND_ENABLED: 'true', CONTROL_ALLOW_TAILNET_HTTP: 'true' }, '/tmp/fixture');
    expect(config.sendEnabled).toBe(true);
    expect(config.allowTailnetHttp).toBe(true);
  });
});
