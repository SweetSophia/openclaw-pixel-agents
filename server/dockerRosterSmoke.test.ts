// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const script = fileURLToPath(new URL('../scripts/smoke-docker-roster.mjs', import.meta.url));

function probe({ comma = false, uid = 1000, writable = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pixel-docker-probe-')); roots.push(root);
  const bin = join(root, 'bin'); const temporary = join(root, comma ? 'tmp,comma' : 'tmp');
  mkdirSync(bin); mkdirSync(temporary);
  // Docker is the external boundary; fail at port discovery if the utility
  // skips either safety check, avoiding a network/readiness timeout.
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
case "$1" in
  create) printf '%s\\n' '${'a'.repeat(64)}' ;;
  start|rm|logs) exit 0 ;;
  exec) printf '%s\\n' '${uid}' ;;
  inspect) printf '%s\\n' '[{"Type":"bind","Destination":"/run/pixel","RW":${writable}}]' ;;
  *) echo 'fixture refused port discovery' >&2; exit 1 ;;
esac
`, { mode: 0o700 });
  return spawnSync(process.execPath, [script, 'fixture-image'], {
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, TMPDIR: temporary },
    encoding: 'utf8', timeout: 5000,
  });
}

it.skipIf(process.platform === 'win32')('rejects comma-containing temporary paths before Docker mount parsing', () => {
  const result = probe({ comma: true });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/TMPDIR.*comma/);
});
it.skipIf(process.platform === 'win32')('does not qualify a root runtime as non-root access', () => {
  const result = probe({ uid: 0 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/non-root/);
});
it.skipIf(process.platform === 'win32')('does not qualify a writable bind mount as read-only', () => {
  const result = probe({ writable: true });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/read-only/);
});
