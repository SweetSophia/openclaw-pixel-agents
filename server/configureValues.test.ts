// @vitest-environment node
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';
// @ts-expect-error Standalone packaged JavaScript CLI.
import { buildConfiguration, dotenvValue } from '../bin/configure-values.mjs';
// @ts-expect-error Standalone packaged collector.
import { getIngestEndpoint } from '../collector/push-pixel-agents.mjs';
import { loadControlConfig } from './control/config';

const context = { home: join(process.cwd(), 'synthetic home'), cwd: process.cwd() };
const remote = { mode: 'remote', collectorUrl: 'https://ingest.example/office', openclawBin: '/opt/openclaw/bin/openclaw' };

it('builds a local office using stable defaults without enabling private access', () => {
  const result = buildConfiguration({}, context);
  expect(result.directory).toBe(join(context.cwd, 'pixel-agents-config'));
  expect(Object.keys(result.files)).toEqual(['office.env']);
  const office = parseEnv(result.files['office.env']);
  expect(office.PORT).toBe('3001');
  expect(office.CORS_ORIGIN).toBe('http://localhost:3001');
  expect(office.DATA_SOURCE).toBe('cli');
  expect(office.DATA_DIR).toBe(join(context.home, '.openclaw-pixel-agents'));
  expect(office.OPENCLAW_BIN).toBeUndefined();
  expect(loadControlConfig(office, context.home).enabled).toBe(false);
});

it('keeps collector addressing distinct and generates matching ingest keys but a separate office key', () => {
  const result = buildConfiguration({ ...remote, port: '3002', origin: 'https://office.example', privateAccess: true,
    gatewayUrl: 'wss://gateway.example' }, context);
  const office = parseEnv(result.files['office.env']);
  const collector = parseEnv(result.files['collector.env']);
  expect(office.DATA_SOURCE).toBe('ingest');
  expect(office.CORS_ORIGIN).toBe('https://office.example');
  expect(collector.PIXEL_AGENTS_URL).toBe('https://ingest.example/office');
  expect(getIngestEndpoint(collector.PIXEL_AGENTS_URL).href).toBe('https://ingest.example/office/api/ingest/agents');
  expect(office.INGEST_API_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  expect(collector.PIXEL_INGEST_TOKEN).toBe(office.INGEST_API_TOKEN);
  expect(office.PIXEL_CONTROL_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  expect(office.PIXEL_CONTROL_TOKEN).not.toBe(office.INGEST_API_TOKEN);
  expect(loadControlConfig(office, context.home).enabled).toBe(true);
  for (const flag of ['CONTROL_SEND_ENABLED', 'CONTROL_APPROVALS_ENABLED', 'CONTROL_ALLOW_TAILNET_HTTP']) expect(office[flag]).toBe('false');
  expect(office.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
  expect(office.OPENCLAW_GATEWAY_PASSWORD).toBeUndefined();
  expect(result.preview).not.toContain(office.INGEST_API_TOKEN);
  expect(result.preview).not.toContain(office.PIXEL_CONTROL_TOKEN);
  expect(buildConfiguration(remote, context).files['office.env']).not.toBe(result.files['office.env']);
});

it.each(['0', '-1', '65536', '3.5', '1e3', 'not-a-port'])('rejects invalid listener port %s', port => {
  expect(() => buildConfiguration({ port }, context)).toThrow(/port/i);
});
it.each(['1', '65535'])('accepts boundary listener port %s', port => {
  expect(parseEnv(buildConfiguration({ port }, context).files['office.env']).PORT).toBe(port);
});
it.each(['https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?x=1', 'https://example.com/#x', 'ftp://example.com', 'https://example.com/'])('rejects non-exact origin %s', origin => {
  expect(() => buildConfiguration({ origin }, context)).toThrow(/origin/i);
});
it.each(['http://gateway.example', 'ws://gateway.example', 'wss://user:pass@gateway.example', 'wss://gateway.example/?x=1', 'wss://gateway.example/#x'])('rejects unsafe Gateway %s', gatewayUrl => {
  expect(() => buildConfiguration({ privateAccess: true, gatewayUrl }, context)).toThrow(/Gateway/i);
});
it.each(['ws://127.0.0.1:18789', 'ws://[::1]:18789', 'wss://gateway.example/protocol'])('matches accepted Gateway transport %s', gatewayUrl => {
  const office = parseEnv(buildConfiguration({ privateAccess: true, gatewayUrl }, context).files['office.env']);
  expect(loadControlConfig(office, context.home).enabled).toBe(true);
});
it.each(['http://office.example', 'https://user:pass@office.example', 'https://office.example/?token=secret', 'https://office.example/#x'])('rejects unsafe collector URL %s', collectorUrl => {
  expect(() => buildConfiguration({ ...remote, collectorUrl }, context)).toThrow(/collector/i);
});
it('requires remote host executable and Gateway paths explicitly without interpreting them as local paths', () => {
  expect(() => buildConfiguration({ ...remote, openclawBin: 'openclaw' }, context)).toThrow(/absolute/i);
  expect(() => buildConfiguration({ ...remote, privateAccess: true }, context)).toThrow(/Gateway/i);
  expect(() => buildConfiguration({ dataDir: './data' }, context)).toThrow(/absolute/i);
  expect(() => buildConfiguration({ openclawBin: './openclaw' }, context)).toThrow(/absolute/i);
  expect(() => buildConfiguration({ mode: 'auto' }, context)).toThrow(/mode/i);
});
it.each([' spaced # value $HOME `command` ', "a'b", 'a"b', 'C:\\Users\\Name\\office', 'ends\\', ''])('round-trips dotenv scalar %j without shell expansion', value => {
  expect(parseEnv(`VALUE=${dotenvValue(value)}\n`).VALUE).toBe(value);
});
it.each(['a\nb', 'a\rb', 'a\u0000b', '\u001b[31m', '\u007f', 'a\tb', 'both\'"quotes'])('rejects unsupported dotenv/control input %j', value => {
  expect(() => dotenvValue(value)).toThrow();
});
