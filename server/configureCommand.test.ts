// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Standalone packaged JavaScript CLI.
import { runConfigure } from '../bin/configure.mjs';

const roots: string[] = [];
const launcher = fileURLToPath(new URL('../bin/openclaw-pixel-agents.mjs', import.meta.url));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pixel-config-'space-")); roots.push(root);
  const output: string[] = []; const questions: string[] = [];
  return { root, output, questions, async run(answers: Array<string | Error>) {
    return runConfigure({ home: root, cwd: root, output: (text: string) => output.push(text), ask: async (text: string) => {
      questions.push(text);
      const answer = answers.shift();
      if (answer instanceof Error || answer === undefined) throw Error('synthetic EOF');
      return answer;
    } });
  } };
}

it('saves local defaults only after presenting a redacted preview and affirmative confirmation', async () => {
  const f = fixture();
  await f.run(['', '3002', '', '', '', '', '', 'yes']);
  const file = join(f.root, '.openclaw-pixel-agents-config', 'office.env');
  const office = parseEnv(readFileSync(file, 'utf8'));
  expect(office.CORS_ORIGIN).toBe('http://localhost:3002');
  expect(office.DATA_SOURCE).toBe('cli');
  expect(office.PIXEL_CONTROL_TOKEN).toBeUndefined();
  expect(f.output.join('\n')).toContain('Preview');
  expect(f.output.join('\n')).toContain('Saved');
  expect(f.questions[f.questions.length - 1]).toMatch(/save.*\[y\/N\]/i);
  expect(f.output.join('\n')).toContain("'\"'\"'"); // POSIX shell-safe apostrophe in an absolute startup path.
});
it('writes matching remote files with private access disabled for mutations and never prints their secrets', async () => {
  const f = fixture();
  await f.run(['remote', '', 'https://office.example', '', '', 'https://collector.example/base', '/opt/bin/openclaw', 'yes', 'wss://gateway.example', 'y']);
  const dir = join(f.root, '.openclaw-pixel-agents-config');
  const office = parseEnv(readFileSync(join(dir, 'office.env'), 'utf8'));
  const collector = parseEnv(readFileSync(join(dir, 'collector.env'), 'utf8'));
  expect(office.CORS_ORIGIN).toBe('https://office.example');
  expect(collector.PIXEL_AGENTS_URL).toBe('https://collector.example/base');
  expect(office.INGEST_API_TOKEN).toBe(collector.PIXEL_INGEST_TOKEN);
  expect(office.PIXEL_CONTROL_TOKEN).not.toBe(office.INGEST_API_TOKEN);
  expect(office.CONTROL_SEND_ENABLED).toBe('false');
  expect(office.CONTROL_APPROVALS_ENABLED).toBe('false');
  const text = f.output.join('\n');
  expect(text).not.toContain(office.PIXEL_CONTROL_TOKEN);
  expect(text).not.toContain(office.INGEST_API_TOKEN);
  expect(text).toContain('--dry-run'); expect(text).toContain('operator.read');
  expect(text).not.toMatch(/connected successfully|connection verified/i);
});
it.each(['', 'no'])('defaults save confirmation to no (%j)', async confirmation => {
  const f = fixture(); await f.run(['', '', '', '', '', '', '', confirmation]);
  expect(readdirSync(f.root)).toEqual([]);
});
it('retries invalid choices/URLs without echoing unsafe values', async () => {
  const f = fixture();
  await f.run(['unexpected', '', '0', '3003', 'https://user:synthetic-secret@example.com', '', '', '', '', 'invalid', 'no', '']);
  expect(readdirSync(f.root)).toEqual([]);
  expect(f.output.join('\n')).not.toContain('synthetic-secret');
  expect(f.questions.filter(q => q.startsWith('Listener port')).length).toBe(2);
});
it('rejects control text rather than allowing it into defaults or preview', async () => {
  const f = fixture(); await f.run(['\u001b[31m', '', '', '', '', '', '', '', '']);
  expect(f.output.join('')).not.toContain('\u001b');
  expect(readdirSync(f.root)).toEqual([]);
});
it.each([0, 1, 4, 7])('creates nothing when input ends at question %i', async count => {
  const f = fixture();
  await expect(f.run(Array(count).fill(''))).rejects.toThrow(/cancel/i);
  expect(readdirSync(f.root)).toEqual([]);
});
it('has no written configuration when a private-mode user aborts at the save preview', async () => {
  const f = fixture(); await expect(f.run(['', '', '', '', '', '', 'yes', '', Error('interrupt')])).rejects.toThrow(/cancel/i);
  expect(readdirSync(f.root)).toEqual([]);
});
it('presents the preview before attempting any filesystem mutation', async () => {
  const f = fixture(); let index = 0;
  const answers = ['', '', '', '', '', '', '', 'yes'];
  await runConfigure({ home: f.root, cwd: f.root, output: (text: string) => f.output.push(text), ask: async () => {
    expect(readdirSync(f.root)).toEqual([]);
    if (index === 7) expect(f.output.join('\n')).toContain('Preview');
    return answers[index++];
  } });
  expect(readdirSync(f.root)).toEqual(['.openclaw-pixel-agents-config']);
});
it('defaults saved secrets outside a source checkout, in a new private home directory', async () => {
  const f = fixture(); const home = join(f.root, 'home'); const checkout = join(f.root, 'checkout');
  mkdirSync(home); mkdirSync(checkout);
  const answers = ['remote', '', '', '', '', 'https://collector.example', 'C:\\Program Files\\OpenClaw\\openclaw.exe', 'yes', 'wss://gateway.example', 'yes'];
  await runConfigure({ home, cwd: checkout, output: () => {}, ask: async () => {
    if (!answers.length) throw Error('Test input exhausted');
    return answers.shift();
  } });
  expect(readdirSync(checkout)).toEqual([]);
  expect(readdirSync(home)).toEqual(['.openclaw-pixel-agents-config']);
  const dir = join(home, '.openclaw-pixel-agents-config');
  expect(parseEnv(readFileSync(join(dir, 'collector.env'), 'utf8')).OPENCLAW_BIN).toBe('C:\\Program Files\\OpenClaw\\openclaw.exe');
  expect(parseEnv(readFileSync(join(dir, 'office.env'), 'utf8')).PIXEL_CONTROL_TOKEN).toMatch(/^[a-f0-9]{64}$/);
});
it.each([['configure'], ['configure', '--env-file', 'missing.env'], ['configure', '--generate-key'], ['configure', '--version'], ['configure', 'extra']].map(args => ({ args })))('fails safely without a terminal or with incompatible options: $args', ({ args }) => {
  const f = fixture();
  const result = spawnSync(process.execPath, [launcher, ...args], { cwd: f.root, encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, HOME: f.root, USERPROFILE: f.root, PIXEL_CONTROL_TOKEN: 'synthetic-ambient-office-key', OPENCLAW_GATEWAY_TOKEN: 'synthetic-ambient-bootstrap' } });
  expect(result.status).not.toBe(0); // Native Node env-file preflight can exit before launcher dispatch.
  if (args.length === 1) expect(result.stderr).toContain('interactive terminal');
  expect(result.stdout).not.toMatch(/[a-f0-9]{64}/);
  expect(result.stdout + result.stderr).not.toContain('synthetic-ambient');
  expect(readdirSync(f.root)).toEqual([]);
});
it('prints configure help without a terminal or creating files', () => {
  const f = fixture(); const result = spawnSync(process.execPath, [launcher, 'configure', '--help'], { cwd: f.root, encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('configure'); expect(result.stdout).toContain('preview');
  expect(readdirSync(f.root)).toEqual([]);
});
