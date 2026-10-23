// @vitest-environment node
import { createHash, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateDeviceIdentity } from './deviceIdentity';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('private task device identity', () => {
  it('persists one verifiable identity with owner-only directory and file modes', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'pixel-device-')), 'control'); dirs.push(join(dir, '..'));
    const identity = loadOrCreateDeviceIdentity(dir);
    const raw = createPublicKey(identity.privateKeyPem).export({ type: 'spki', format: 'der' }).subarray(-32);
    expect(identity.deviceId).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(loadOrCreateDeviceIdentity(dir)).toEqual(identity);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'device.json')).mode & 0o777).toBe(0o600);
  });
  it('fails closed for corrupt or mismatched identity without replacing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixel-device-')); dirs.push(dir);
    const identity = loadOrCreateDeviceIdentity(dir);
    const corrupted = JSON.stringify({ ...identity, deviceId: 'invalid-device' });
    writeFileSync(join(dir, 'device.json'), corrupted);
    expect(() => loadOrCreateDeviceIdentity(dir)).toThrow('Invalid stored task device identity');
    expect(readFileSync(join(dir, 'device.json'), 'utf8')).toBe(corrupted);
  });
});
