// @vitest-environment node
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';
// @ts-expect-error Standalone packaged JavaScript CLI.
import { buildConfiguration as buildActualConfiguration, dotenvValue } from '../bin/configure-values.mjs';
// @ts-expect-error Standalone packaged collector.
import { getIngestEndpoint } from '../collector/push-pixel-agents.mjs';
import { loadControlConfig } from './control/config';
import { parseAgentRoster } from '../shared/agentRoster.cjs';

const context = { home: join(process.cwd(), 'synthetic home'), cwd: process.cwd() };
function buildConfiguration(answers: Record<string, unknown>, environment: { home: string }) {
  // Supply a directly executable synthetic path for unrelated policy tests on Windows.
  return buildActualConfiguration({ ...(process.platform === 'win32' ? { openclawBin: process.execPath } : {}), ...answers }, environment);
}
const remote = { mode: 'remote', collectorUrl: 'https://ingest.example/office', openclawBin: '/opt/openclaw/bin/openclaw' };

it('builds a local office using stable defaults without enabling private access', () => {
  const result = buildConfiguration({}, context);
  expect(result.directory).toBe(join(context.home, '.openclaw-pixel-agents-config'));
  expect(Object.keys(result.files)).toEqual(['office.env', 'agents.json']);
  const office = parseEnv(result.files['office.env']);
  expect(office.PORT).toBe('3001');
  expect(office.CORS_ORIGIN).toBe('http://localhost:3001');
  expect(office.DATA_SOURCE).toBe('cli');
  expect(office.DATA_DIR).toBe(join(context.home, '.openclaw-pixel-agents-config', 'data'));
  expect(office.AGENT_ROSTER_PATH).toBe(join(result.directory, 'agents.json'));
  expect(parseAgentRoster(JSON.parse(result.files['agents.json'])).agents).toHaveLength(8);
  expect(office.OPENCLAW_BIN).toBe(process.platform === 'win32' ? process.execPath : undefined);
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
  expect(collector.AGENT_ROSTER_PATH).toBeUndefined();
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
it.each(['/opt/openclaw/bin/openclaw', 'C:\\Program Files\\OpenClaw\\openclaw.exe', 'D:/tools/openclaw.exe', '\\\\host\\share\\openclaw.exe'])('accepts an absolute remote-host path independently of the dashboard OS: %s', openclawBin => {
  const result = buildConfiguration({ ...remote, openclawBin }, context);
  expect(parseEnv(result.files['collector.env']).OPENCLAW_BIN).toBe(openclawBin);
});
it.each(['openclaw', './openclaw', 'C:relative.exe', '\\root-relative.exe'])('rejects relative remote-host executable %s', openclawBin => {
  expect(() => buildConfiguration({ ...remote, openclawBin }, context)).toThrow(/absolute/i);
});
it.each([' spaced # value $HOME `command` ', "a'b", 'a"b', 'C:\\Users\\Name\\office', 'ends\\', ''])('round-trips dotenv scalar %j without shell expansion', value => {
  expect(parseEnv(`VALUE=${dotenvValue(value)}\n`).VALUE).toBe(value);
});
it.each(['a\nb', 'a\rb', 'a\u0000b', '\u001b[31m', '\u007f', 'a\tb', '\u2028edge', 'mid\u2029line', 'both\'"quotes'])('rejects unsupported dotenv/control input %j', value => {
  expect(() => dotenvValue(value)).toThrow();
});
it('uses a canonical browser origin for the default HTTP port', () => {
  expect(parseEnv(buildConfiguration({ port: '80' }, context).files['office.env']).CORS_ORIGIN).toBe('http://localhost');
});
it('resolves relative bundle paths under home and gives each bundle isolated stable state', () => {
  const first = buildConfiguration({ directory: 'first-office' }, context);
  const second = buildConfiguration({ directory: 'second-office' }, context);
  expect(first.directory).toBe(join(context.home, 'first-office'));
  expect(parseEnv(first.files['office.env']).DATA_DIR).toBe(join(context.home, 'first-office', 'data'));
  expect(parseEnv(second.files['office.env']).DATA_DIR).toBe(join(context.home, 'second-office', 'data'));
  const existing = join(context.home, 'existing-office-state');
  expect(parseEnv(buildConfiguration({ directory: 'replacement', dataDir: existing }, context).files['office.env']).DATA_DIR).toBe(existing);
});
it('rejects a bundle path whose new roster-path environment value cannot be represented', () => {
  const directory = join(context.home, `O'Brien's "office"`);
  expect(() => buildConfiguration({ directory, dataDir: join(context.home, 'separate-state') }, context)).toThrow(/quotes|environment/i);
});
it('validates and serializes custom IDs/names into an editable roster with a public preview', () => {
  const roster = { version: 1, agents: [{ id: 'sub-worker', name: '研究 Assistant' }] };
  const plan = buildConfiguration({ roster }, context);
  expect(JSON.parse(plan.files['agents.json'])).toEqual(roster);
  expect(plan.preview).toContain('sub-worker'); expect(plan.preview).toContain('研究 Assistant');
  expect(() => buildConfiguration({ roster: { version: 1, agents: [] } }, context)).toThrow(/roster/i);
});
it('keeps URL paths out of the preview while preserving them in the private files', () => {
  const result = buildConfiguration({ ...remote, collectorUrl: 'https://collector.example/private-route', privateAccess: true,
    gatewayUrl: 'wss://gateway.example/secret-route' }, context);
  expect(parseEnv(result.files['collector.env']).PIXEL_AGENTS_URL).toBe('https://collector.example/private-route');
  expect(parseEnv(result.files['office.env']).OPENCLAW_GATEWAY_URL).toBe('wss://gateway.example/secret-route');
  expect(result.preview).not.toContain('private-route'); expect(result.preview).not.toContain('secret-route');
  expect(result.preview).toContain('https://collector.example'); expect(result.preview).toContain('wss://gateway.example');
});
it('rejects unserializable collector URLs at field validation, not after all prompts', async () => {
  // @ts-expect-error Standalone packaged JavaScript CLI.
  const { validateCollectorUrl } = await import('../bin/configure-values.mjs');
  expect(() => validateCollectorUrl(`https://collector.example/a'"b`)).toThrow();
});
it.each(['C:\\tools\\openclaw.cmd', 'C:\\tools\\openclaw.BAT'])('rejects Windows remote batch shims rather than promising execFile support: %s', openclawBin => {
  expect(() => buildConfiguration({ ...remote, openclawBin }, context)).toThrow(/batch|directly executable/i);
});
