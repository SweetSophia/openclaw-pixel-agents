import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmodSync, constants, linkSync, lstatSync, mkdirSync, openSync, readFileSync, closeSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeviceStorageError } from './errors';

export interface DeviceIdentity { version: 1; deviceId: string; publicKeyPem: string; privateKeyPem: string }
function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw Error('Invalid task device directory');
  chmodSync(directory, 0o700);
}
function privateRead(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { chmodSync(path, 0o600); return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
function atomicWrite(path: string, value: unknown, createOnly = false): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    if (createOnly) linkSync(temp, path);
    else {
      // Token replacement is atomic; never follow an existing destination symlink.
      renameSync(temp, path);
    }
  } finally { try { unlinkSync(temp); } catch { /* already renamed */ } }
}
export function loadOrCreateDeviceIdentity(directory: string): DeviceIdentity {
  ensureDirectory(directory);
  const path = join(directory, 'device.json');
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const keys = generateKeyPairSync('ed25519');
    const publicKeyPem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const privateKeyPem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const deviceId = createHash('sha256').update(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).digest('hex');
    try { atomicWrite(path, { version: 1, deviceId, publicKeyPem, privateKeyPem }, true); }
    catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; }
  }
  try {
    const value = JSON.parse(privateRead(path)) as DeviceIdentity;
    if (value.version !== 1 || typeof value.publicKeyPem !== 'string' || typeof value.privateKeyPem !== 'string') throw Error();
    const privateKey = createPrivateKey(value.privateKeyPem);
    const publicKey = createPublicKey(value.publicKeyPem);
    const raw = publicKey.export({ format: 'der', type: 'spki' });
    if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519'
      || !createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).equals(raw)
      || value.deviceId !== createHash('sha256').update(raw.subarray(-32)).digest('hex')) throw Error();
    return { version: 1, deviceId: value.deviceId, publicKeyPem: value.publicKeyPem, privateKeyPem: value.privateKeyPem };
  } catch (error) { if (isDeviceStorageError(error)) throw error; throw Error('Invalid stored task device identity'); }
}
export interface DeviceGrant { deviceId: string; endpoint: string; token: string; scopes: string[] }
function grantPath(directory: string, endpoint: string): string {
  return join(directory, `grant-${createHash('sha256').update(endpoint).digest('hex')}.json`);
}
export function readDeviceGrantDetails(directory: string, endpoint: string, deviceId: string): DeviceGrant | undefined {
  try {
    const value: DeviceGrant = JSON.parse(privateRead(grantPath(directory, endpoint)));
    if (value.deviceId === deviceId && value.endpoint === endpoint && typeof value.token === 'string'
      && value.token.length > 0 && value.token.length <= 16384 && Array.isArray(value.scopes) && value.scopes.length <= 16
      && value.scopes.every(scope => typeof scope === 'string' && scope.length > 0 && scope.length <= 128)) return { deviceId, endpoint, token: value.token, scopes: [...value.scopes] };
  } catch (error) { if (isDeviceStorageError(error)) throw error; /* Missing or invalid grants require fresh authentication. */ }
}
export function readDeviceGrant(directory: string, endpoint: string, deviceId: string, scopes: string[]): string | undefined {
  const value = readDeviceGrantDetails(directory, endpoint, deviceId);
  return value && scopes.every(scope => value.scopes.includes(scope)) ? value.token : undefined;
}
export function writeDeviceGrant(directory: string, endpoint: string, deviceId: string, token: string, scopes: string[]): void {
  atomicWrite(grantPath(directory, endpoint), { deviceId, endpoint, token, scopes });
}
