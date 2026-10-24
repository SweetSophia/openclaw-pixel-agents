#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

try {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean' }, version: { type: 'boolean' },
    'generate-key': { type: 'boolean' }, 'env-file': { type: 'string' },
  }, allowPositionals: false });
  if (values.help) {
    console.log(`OpenClaw Pixel Agents

Usage: openclaw-pixel-agents [--env-file /path/to/office.env]
       openclaw-pixel-agents --generate-key
       openclaw-pixel-agents --version

Runs the built production office on PORT (default 3001).
Set CORS_ORIGIN to the exact browser origin before starting.
DATA_DIR defaults to ~/.openclaw-pixel-agents, outside the installed package.
--env-file loads private configuration; existing environment variables win.
--generate-key prints a fresh task access key without changing configuration.

Setup: https://github.com/SweetSophia/openclaw-pixel-agents#readme`);
  } else if (values.version) {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  } else if (values['generate-key']) {
    await import('../scripts/generate-control-key.mjs');
  } else {
    if (values['env-file']) process.loadEnvFile(values['env-file']);
    process.env.NODE_ENV = 'production';
    process.env.DATA_DIR ||= join(homedir(), '.openclaw-pixel-agents');
    const { startServer } = await import('../dist/server/server/index.js');
    startServer();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not start Pixel Agents');
  process.exitCode = 1;
}
