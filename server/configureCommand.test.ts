// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { loadAgentRoster } from './agentRoster';
// @ts-expect-error Standalone packaged JavaScript CLI.
import { runConfigure } from '../bin/configure.mjs';

const roots: string[] = [];
const launcher = fileURLToPath(new URL('../bin/openclaw-pixel-agents.mjs', import.meta.url));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function localAnswer(question: string, answer: string) {
  return question.startsWith('Local OpenClaw') && answer === '' && process.platform === 'win32' ? process.execPath : answer;
}
function boundedAsk(reply: (question: string) => string | Promise<string>) {
  let count = 0;
  return async (question: string) => {
    if (++count > 40) throw Error('Fixture question limit');
    if (question.startsWith('Use the built-in agent roster')) return ''; // Existing non-roster fixtures accept its default.
    return localAnswer(question, await reply(question));
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pixel-config-space-')); roots.push(root);
  const output: string[] = []; const questions: string[] = [];
  return { root, output, questions, async run(answers: Array<string | Error>) {
    return runConfigure({ home: root, output: (text: string) => output.push(text), ask: async (text: string) => {
      questions.push(text);
      if (text.startsWith('Use the built-in agent roster')) return ''; // New roster-specific fixtures below drive it explicitly.
      const answer = answers.shift();
      if (answer instanceof Error || answer === undefined) throw Error('synthetic EOF');
      return localAnswer(text, answer);
    } });
  } };
}

it('saves local defaults only after presenting a redacted preview and affirmative confirmation', async () => {
  const f = fixture();
  const directory = join(f.root, "O'Brien's office");
  await f.run(['', '3002', '', directory, join(f.root, 'state'), '', '', 'yes']);
  const file = join(directory, 'office.env');
  const office = parseEnv(readFileSync(file, 'utf8'));
  expect(office.CORS_ORIGIN).toBe('http://localhost:3002');
  expect(office.DATA_SOURCE).toBe('cli');
  expect(office.PIXEL_CONTROL_TOKEN).toBeUndefined();
  expect(loadAgentRoster(office.AGENT_ROSTER_PATH).agents).toHaveLength(8);
  expect(f.output.join('\n')).toContain('Preview');
  expect(f.output.join('\n')).toContain('Saved');
  expect(f.questions[f.questions.length - 1]).toMatch(/save.*\[y\/N\]/i);
  expect(f.output.join('\n')).toContain(process.platform === 'win32' ? "''" : "'\"'\"'");
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
  await runConfigure({ home: f.root, output: (text: string) => f.output.push(text), ask: boundedAsk(async () => {
    expect(readdirSync(f.root)).toEqual([]);
    if (index === 7) expect(f.output.join('\n')).toContain('Preview');
    if (index >= answers.length) throw Error('Fixture input exhausted');
    return answers[index++];
  }) });
  expect(readdirSync(f.root)).toEqual(['.openclaw-pixel-agents-config']);
});
it('defaults saved secrets outside a source checkout, in a new private home directory', async () => {
  const f = fixture(); const home = join(f.root, 'home'); const checkout = join(f.root, 'checkout');
  mkdirSync(home); mkdirSync(checkout);
  const answers = ['remote', '', '', '', '', 'https://collector.example', 'C:\\Program Files\\OpenClaw\\openclaw.exe', '', 'yes', 'wss://gateway.example', 'yes'];
  const moduleUrl = new URL('../bin/configure.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const {runConfigure}=await import(${JSON.stringify(moduleUrl)}); const answers=${JSON.stringify(answers)}; await runConfigure({home:${JSON.stringify(home)},output:()=>{},ask:async()=>{if(!answers.length)throw Error('Input exhausted');return answers.shift();}});`], { cwd: checkout, encoding: 'utf8', timeout: 5000 });
  expect(result.status, result.stderr).toBe(0);
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
it('accepts the canonical default origin at port 80', async () => {
  const f = fixture(); await f.run(['', '80', '', '', '', '', '', 'yes']);
  const office = parseEnv(readFileSync(join(f.root, '.openclaw-pixel-agents-config', 'office.env'), 'utf8'));
  expect(office.CORS_ORIGIN).toBe('http://localhost');
});
it('retries an unserializable collector URL without losing the rest of the session', async () => {
  const f = fixture(); await f.run(['remote', '', '', '', '', `https://collector.example/a'"b`, 'https://collector.example/valid', '/opt/bin/openclaw', 'no', 'yes']);
  const collector = parseEnv(readFileSync(join(f.root, '.openclaw-pixel-agents-config', 'collector.env'), 'utf8'));
  expect(collector.PIXEL_AGENTS_URL).toBe('https://collector.example/valid');
});
it('retries occupied destinations before preview, preserving existing files and the other answers', async () => {
  const f = fixture(); const existing = join(f.root, 'existing'); mkdirSync(existing);
  let directories = 0;
  await runConfigure({ home: f.root, output: (text: string) => f.output.push(text), ask: boundedAsk(async (question: string) => {
    if (question.startsWith('New configuration directory')) return ++directories === 1 ? existing : 'fresh-office';
    if (question.startsWith('Save these new files?')) return 'yes';
    return '';
  }) });
  expect(directories).toBe(2); expect(readdirSync(existing)).toEqual([]);
  const office = parseEnv(readFileSync(join(f.root, 'fresh-office', 'office.env'), 'utf8'));
  expect(office.DATA_DIR).toBe(join(f.root, 'fresh-office', 'data'));
});
it('recovers from a destination created after preview and requires a fresh confirmation', async () => {
  const f = fixture(); let directories = 0; let confirmations = 0;
  await runConfigure({ home: f.root, output: () => {}, ask: boundedAsk(async (question: string) => {
    if (question.startsWith('New configuration directory')) return ++directories === 1 ? 'raced-office' : 'retry-office';
    if (question.startsWith('Save these new files?')) {
      if (++confirmations === 1) mkdirSync(join(f.root, 'raced-office'));
      return 'yes';
    }
    return '';
  }) });
  expect(confirmations).toBe(2); expect(readdirSync(join(f.root, 'raced-office'))).toEqual([]);
  expect(parseEnv(readFileSync(join(f.root, 'retry-office', 'office.env'), 'utf8')).DATA_DIR).toBe(join(f.root, 'retry-office', 'data'));
});
it('rejects Unicode line separators before trimming or previewing', async () => {
  const f = fixture(); await f.run(['\u2028', '', '', '', '', '', '', '', '']);
  expect(f.output.join('')).not.toContain('\u2028'); expect(readdirSync(f.root)).toEqual([]);
  expect(f.questions.filter(question => question.startsWith('OpenClaw location'))).toHaveLength(2);
});
it('ignores generated configuration filenames in the source repository', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync('git', ['check-ignore', '--no-index', 'office.env', 'nested/collector.env', 'pixel-agents-config/anything', '.openclaw-pixel-agents-config/anything'], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split('\n')).toHaveLength(4);
});
it('refuses the implicit PATH command on a simulated Windows dashboard instead of generating an unusable local config', () => {
  const f = fixture(); const moduleUrl = new URL('../bin/configure-values.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `Object.defineProperty(process, 'platform', { value: 'win32' }); const {buildConfiguration}=await import(${JSON.stringify(moduleUrl)}); buildConfiguration({},${JSON.stringify({ home: f.root, cwd: f.root })});`], { encoding: 'utf8', timeout: 5000 });
  expect(result.status).not.toBe(0); expect(result.stderr).toMatch(/directly executable/i);
});
it('rejects a missing parent at the directory prompt instead of losing the session after confirmation', async () => {
  const f = fixture(); let destinations = 0; let questions = 0;
  await runConfigure({ home: f.root, output: (text: string) => f.output.push(text), ask: async (question: string) => {
    if (++questions > 25) throw Error('Fixture question limit');
    if (question.startsWith('New configuration directory')) return ++destinations === 1 ? join(f.root, 'missing-parent', 'office') : 'valid-office';
    if (question.startsWith('Local OpenClaw')) return process.platform === 'win32' ? process.execPath : '';
    if (question.startsWith('Save these new files?')) return 'yes';
    return '';
  } });
  expect(destinations).toBe(2);
  expect(readdirSync(f.root)).toEqual(['valid-office']);
});
it('recovers when the parent disappears after preview and asks for confirmation again', async () => {
  const f = fixture(); const parent = join(f.root, 'parent'); mkdirSync(parent);
  let destinations = 0; let confirmations = 0; let questions = 0;
  await runConfigure({ home: f.root, output: () => {}, ask: async (question: string) => {
    if (++questions > 30) throw Error('Fixture question limit');
    if (question.startsWith('New configuration directory')) return ++destinations === 1 ? join(parent, 'office') : 'recovered-office';
    if (question.startsWith('Local OpenClaw')) return process.platform === 'win32' ? process.execPath : '';
    if (question.startsWith('Save these new files?')) { if (++confirmations === 1) rmdirSync(parent); return 'yes'; }
    return '';
  } });
  expect(confirmations).toBe(2);
  expect(parseEnv(readFileSync(join(f.root, 'recovered-office', 'office.env'), 'utf8')).DATA_DIR).toBe(join(f.root, 'recovered-office', 'data'));
});
it('retains an explicitly typed default-shaped state path through multiple destination collisions', async () => {
  const f = fixture(); const state = join(f.root, 'office-1', 'data');
  let destinations = 0; let confirmations = 0; let stateAnswers = 0; let questions = 0;
  await runConfigure({ home: f.root, output: () => {}, ask: async (question: string) => {
    if (++questions > 35) throw Error('Fixture question limit');
    if (question.startsWith('New configuration directory')) return `office-${++destinations}`;
    if (question.startsWith('Stable absolute office DATA_DIR')) return ++stateAnswers === 1 ? state : '';
    if (question.startsWith('Local OpenClaw')) return process.platform === 'win32' ? process.execPath : '';
    if (question.startsWith('Save these new files?')) { if (++confirmations < 3) mkdirSync(join(f.root, `office-${confirmations}`)); return 'yes'; }
    return '';
  } });
  expect(confirmations).toBe(3);
  expect(parseEnv(readFileSync(join(f.root, 'office-3', 'office.env'), 'utf8')).DATA_DIR).toBe(state);
});
it('retries an unrepresentable derived roster path at the destination prompt before DATA_DIR', async ({ skip }) => {
  // This real-filesystem fixture uses a double quote, which Windows filenames forbid.
  if (process.platform === 'win32') { skip(); return; }
  const f = fixture(); let explained = false; let questions = 0; let destinations = 0;
  await runConfigure({ home: f.root, output: (text: string) => f.output.push(text), ask: async (question: string) => {
    if (++questions > 20) throw Error('Fixture question limit');
    if (question.startsWith('New configuration directory')) return ++destinations === 1 ? `O'Brien's "office"` : 'safe-office';
    if (question.startsWith('Stable absolute office DATA_DIR')) { expect(destinations).toBe(2); explained = /quotes|environment/i.test(f.output.join('\n')); return join(f.root, 'state'); }
    if (question.startsWith('Local OpenClaw')) return process.platform === 'win32' ? process.execPath : '';
    if (question.startsWith('Save these new files?')) return 'yes';
    return '';
  } });
  expect(explained).toBe(true);
});

it('guides custom ID/name entry with bounded count/duplicate retries and a literal preview', async () => {
  const f = fixture(); const counts = ['0', '51', '2']; const secondIds = ['sub-worker', 'bad/id', 'researcher']; let questions = 0;
  await runConfigure({ home: f.root, output: (text: string) => f.output.push(text), ask: async (question: string) => {
    if (++questions > 30) throw Error('Fixture question limit');
    if (question.startsWith('Local OpenClaw')) return process.platform === 'win32' ? process.execPath : '';
    if (question.startsWith('Use the built-in agent roster')) return 'no';
    if (question.startsWith('Number of agents')) return counts.shift()!;
    if (question.startsWith('Agent 1 ID')) return 'sub-worker';
    if (question.startsWith('Agent 1 display name')) return ' 研究 Assistant ';
    if (question.startsWith('Agent 2 ID')) return secondIds.shift()!;
    if (question.startsWith('Agent 2 display name')) return '<b>Research</b>';
    if (question.startsWith('Save these new files?')) { expect(readdirSync(f.root)).toEqual([]); expect(f.output.join('\n')).toContain('sub-worker'); return 'yes'; }
    return '';
  } });
  const directory = join(f.root, '.openclaw-pixel-agents-config');
  expect(JSON.parse(readFileSync(join(directory, 'agents.json'), 'utf8'))).toEqual({ version: 1, agents: [{ id: 'sub-worker', name: '研究 Assistant' }, { id: 'researcher', name: '<b>Research</b>' }] });
  expect(loadAgentRoster(join(directory, 'agents.json')).agents).toEqual([{ id: 'sub-worker', name: '研究 Assistant' }, { id: 'researcher', name: '<b>Research</b>' }]);
  expect(parseEnv(readFileSync(join(directory, 'office.env'), 'utf8')).AGENT_ROSTER_PATH).toBe(join(directory, 'agents.json'));
  expect(f.output.join('\n')).toMatch(/restart/i); expect(f.output.join('\n')).not.toMatch(/discovered|connection verified/i);
});
it.each(['Use the built-in agent roster', 'Number of agents', 'Agent 1 ID', 'Agent 1 display name'])('creates nothing when input ends at %s', async stage => {
  const f = fixture(); let questions = 0;
  await expect(runConfigure({ home: f.root, output: () => {}, ask: async (question: string) => {
    if (++questions > 20) throw Error('Fixture question limit');
    if (question.startsWith(stage)) throw Error('synthetic EOF');
    if (question.startsWith('Local OpenClaw')) return process.platform === 'win32' ? process.execPath : '';
    if (question.startsWith('Use the built-in agent roster')) return 'no';
    if (question.startsWith('Number of agents')) return '1';
    if (question.startsWith('Agent 1 ID')) return 'worker';
    if (question.startsWith('Save these new files?')) return 'yes';
    return '';
  } })).rejects.toThrow(/cancel/i);
  expect(readdirSync(f.root)).toEqual([]);
});
it('retains a custom roster and recomputes its path through a save-time collision', async () => {
  const f = fixture(); let destinations = 0; let saves = 0; let idPrompts = 0; let questions = 0;
  await runConfigure({ home: f.root, output: () => {}, ask: async (question: string) => {
    if (++questions > 30) throw Error('Fixture question limit');
    if (question.startsWith('New configuration directory')) return ++destinations === 1 ? 'raced-office' : 'final-office';
    if (question.startsWith('Local OpenClaw')) return process.platform === 'win32' ? process.execPath : '';
    if (question.startsWith('Use the built-in agent roster')) return 'no';
    if (question.startsWith('Number of agents')) return '1';
    if (question.startsWith('Agent 1 ID')) { idPrompts++; return 'worker'; }
    if (question.startsWith('Agent 1 display name')) return 'Worker';
    if (question.startsWith('Save these new files?')) { if (++saves === 1) mkdirSync(join(f.root, 'raced-office')); return 'yes'; }
    return '';
  } });
  expect(idPrompts).toBe(1); expect(saves).toBe(2);
  const dir = join(f.root, 'final-office');
  expect(parseEnv(readFileSync(join(dir, 'office.env'), 'utf8')).AGENT_ROSTER_PATH).toBe(join(dir, 'agents.json'));
  expect(JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents).toEqual([{ id: 'worker', name: 'Worker' }]);
  expect(readdirSync(join(f.root, 'raced-office'))).toEqual([]);
});
it('retries control-bearing names without putting rejected text in the preview', async () => {
  const f = fixture(); const names = ['rejected-marker\u001b[31m', 'rejected-marker\u2028name', 'Worker']; let namePrompts = 0;
  await runConfigure({ home: f.root, output: (text: string) => f.output.push(text), ask: async (question: string) => {
    if (question.startsWith('Local OpenClaw')) return process.platform === 'win32' ? process.execPath : '';
    if (question.startsWith('Use the built-in agent roster')) return 'no';
    if (question.startsWith('Agent 1 ID')) return 'worker';
    if (question.startsWith('Agent 1 display name')) { if (++namePrompts > 3) throw Error('Fixture question limit'); return names.shift()!; }
    if (question.startsWith('Save these new files?')) return 'yes';
    return '';
  } });
  expect(namePrompts).toBe(3); expect(f.output.join('\n')).not.toMatch(/rejected-marker|\u001b|\u2028/);
});
it('accepts fifty explicitly entered IDs with default names', async () => {
  const f = fixture(); let idCount = 0; let questions = 0;
  await runConfigure({ home: f.root, output: () => {}, ask: async (question: string) => {
    if (++questions > 120) throw Error('Fixture question limit');
    if (question.startsWith('Local OpenClaw')) return process.platform === 'win32' ? process.execPath : '';
    if (question.startsWith('Use the built-in agent roster')) return 'no';
    if (question.startsWith('Number of agents')) return '50';
    if (/^Agent \d+ ID/.test(question)) return `worker-${++idCount}`;
    if (question.startsWith('Save these new files?')) return 'yes';
    return '';
  } });
  const roster = loadAgentRoster(join(f.root, '.openclaw-pixel-agents-config', 'agents.json'));
  expect(roster.agents).toHaveLength(50); expect(roster.agents[49]).toEqual({ id: 'worker-50', name: 'worker-50' });
});
