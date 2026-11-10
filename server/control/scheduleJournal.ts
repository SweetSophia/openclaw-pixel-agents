import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { controlByteSize, controlRecord } from '../../shared/control';
import { ControlError } from './errors';
import { isCanonicalScheduleAgentId } from './scheduleProjection';

export interface ScheduleReservation {
  operationId: string; agentId: string; declarationKey: string; requestDigest: string; bindingDigest: string;
  createdAt: number; state: 'uncertain' | 'acknowledged' | 'observed' | 'changed'; jobId?: string;
}
export interface ScheduleJournal {
  reserve(input: { operationId: string; agentId: string; requestDigest: string }): Promise<ScheduleReservation & { reserved: boolean }>;
  record(operationId: string, state: ScheduleReservation['state'], jobId?: string): Promise<void>;
  list(agentId: string): ScheduleReservation[];
  close(): Promise<void>;
}
interface Metadata { version: 1; installationId: string; records: ScheduleReservation[] }
const MAX_BYTES = 1024 * 1024;
const MAX_RECORDS = 500;
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const states: readonly string[] = ['uncertain', 'acknowledged', 'observed', 'changed'];
const jobIdValid = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && !/[\ud800-\udfff]/u.test(value);
const unavailable = () => new ControlError('schedule-storage-unavailable');
const changed = () => new ControlError('schedule-changed');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = controlRecord(value);
  if (!record || Reflect.ownKeys(record).some(key => typeof key !== 'string' || !keys.includes(key))) throw unavailable();
  return record;
}
function privateMode(stat: fs.Stats, mode: number): void {
  if ((stat.mode & 0o7777) !== mode || (process.getuid && stat.uid !== process.getuid())) throw unavailable();
}
function sameFile(left: fs.Stats, right: fs.Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function privateFile(stat: fs.Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unavailable();
  privateMode(stat, 0o600);
}
function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Refuse symlinks in the entire path, not just at the final directory component.
function checkDirectory(directory: string, create: boolean): boolean {
  if (typeof fs.constants.O_NOFOLLOW !== 'number' || typeof fs.constants.O_DIRECTORY !== 'number' || !process.getuid) throw unavailable();
  const absolute = resolve(directory); const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (!missing(error)) throw error;
      if (!create) return false;
      fs.mkdirSync(current, { mode: 0o700 });
      syncDirectory(dirname(current)); stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  }
  privateMode(fs.lstatSync(absolute), 0o700);
  return true;
}
function parseMetadata(value: unknown): Metadata {
  const root = closed(value, ['version', 'installationId', 'records']);
  if (root.version !== 1 || !uuid(root.installationId) || !Array.isArray(root.records) || root.records.length > MAX_RECORDS) throw unavailable();
  const ids = new Set<string>();
  const records = root.records.map(value => {
    const row = closed(value, ['operationId', 'agentId', 'declarationKey', 'requestDigest', 'bindingDigest', 'createdAt', 'state', 'jobId']);
    if (!uuid(row.operationId) || ids.has(row.operationId.toLowerCase()) || typeof row.agentId !== 'string'
      || !isCanonicalScheduleAgentId(row.agentId) || !digest(row.requestDigest) || !digest(row.bindingDigest)
      || row.declarationKey !== `pixel-agents:${root.installationId}:${row.operationId}`
      || typeof row.createdAt !== 'number' || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || row.createdAt > 8640000000000000
      || typeof row.state !== 'string' || !states.includes(row.state) || ('jobId' in row && !jobIdValid(row.jobId))) throw unavailable();
    ids.add(row.operationId.toLowerCase());
    return { ...row } as unknown as ScheduleReservation;
  });
  return { version: 1, installationId: root.installationId, records };
}
function readMetadata(directory: string): Metadata | undefined {
  const path = join(directory, 'journal.json');
  for (let attempt = 0; attempt < 3; attempt++) {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(path); } catch (error) { if (missing(error)) return undefined; throw error; }
    privateFile(stat);
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd);
      // Atomic writer replacement can change the inode or detach an already-open file.
      // Never read either descriptor: close it and repeat all path/descriptor checks.
      if (!sameFile(stat, opened) || opened.nlink === 0) continue;
      privateFile(opened);
      if (opened.size > MAX_BYTES) throw unavailable();
      const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break; length += count;
      }
      if (length > MAX_BYTES) throw unavailable();
      return parseMetadata(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))));
    } finally { fs.closeSync(fd); }
  }
  throw unavailable();
}

/** Existing metadata only: never creates a directory, installation, identity, or lock. */
export async function readScheduleRecovery(directory: string, agentId: string): Promise<ScheduleReservation[]> {
  try {
    if (typeof agentId !== 'string' || !isCanonicalScheduleAgentId(agentId)) throw changed();
    if (!checkDirectory(directory, false)) return [];
    return readMetadata(directory)?.records.filter(row => row.agentId === agentId).map(row => ({ ...row })) ?? [];
  } catch (error) { if (error instanceof ControlError) throw error; throw unavailable(); }
}

export function openScheduleJournal(options: { directory: string; binding: { gatewayUrl: string; deviceId: string } }): ScheduleJournal {
  const directory = resolve(options.directory);
  const path = join(directory, 'journal.json'); const lockPath = join(directory, 'journal.lock');
  let metadata: Metadata | undefined; let directoryFd: number | undefined; let lockFd: number | undefined;
  let lockStat: fs.Stats | undefined; let directoryStat: fs.Stats; let poisoned = false;
  let closing = false; let closedAlready = false; let tail: Promise<void> = Promise.resolve(); let closePromise: Promise<void> | undefined;
  let bindingDigest: string;

  function checkLocation(): void {
    checkDirectory(directory, false);
    if (!sameFile(directoryStat, fs.lstatSync(directory))) throw unavailable();
  }
  function ownsLock(): boolean {
    if (lockFd === undefined || !lockStat) return false;
    try { const stat = fs.lstatSync(lockPath); privateFile(stat); return sameFile(lockStat, stat); }
    catch { return false; }
  }
  function assertWriter(): void {
    if (poisoned || lockFd === undefined || closedAlready) throw unavailable();
    try { checkLocation(); if (!ownsLock()) throw unavailable(); }
    catch { poisoned = true; throw unavailable(); }
  }
  function write(next: Metadata): void {
    const temp = join(directory, `journal.${randomUUID()}.tmp`); let fd: number | undefined; let tempStat: fs.Stats | undefined;
    try {
      assertWriter();
      if (controlByteSize(next) > MAX_BYTES) throw unavailable();
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      tempStat = fs.fstatSync(fd); privateFile(tempStat);
      fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      assertWriter();
      // Refuse an unsafe replacement destination even though rename itself does not follow links.
      try { privateFile(fs.lstatSync(path)); } catch (error) { if (!missing(error)) throw error; }
      const source = fs.lstatSync(temp); privateFile(source);
      if (!sameFile(tempStat, source)) throw unavailable();
      fs.renameSync(temp, path); fs.fsyncSync(directoryFd!);
    } catch { poisoned = true; throw unavailable(); }
    finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { poisoned = true; } }
      if (tempStat) {
        try { if (sameFile(tempStat, fs.lstatSync(temp))) fs.unlinkSync(temp); }
        catch (error) { if (!missing(error)) poisoned = true; }
      }
    }
  }
  function releaseLock(): void {
    try {
      if (ownsLock()) { checkLocation(); fs.unlinkSync(lockPath); fs.fsyncSync(directoryFd!); }
    } finally {
      const fd = lockFd; lockFd = undefined;
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  function closeDirectory(): void {
    const fd = directoryFd; directoryFd = undefined;
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    const binding = closed(options.binding, ['gatewayUrl', 'deviceId']);
    if (typeof binding.gatewayUrl !== 'string' || !binding.gatewayUrl.length || binding.gatewayUrl.length > 4096
      || typeof binding.deviceId !== 'string' || !binding.deviceId.length || binding.deviceId.length > 200) throw unavailable();
    bindingDigest = createHash('sha256').update(JSON.stringify({ gatewayUrl: binding.gatewayUrl, deviceId: binding.deviceId })).digest('hex');
    checkDirectory(directory, true); directoryStat = fs.lstatSync(directory);
    metadata = readMetadata(directory);
    try {
      directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      if (!sameFile(directoryStat, fs.fstatSync(directoryFd))) throw unavailable();
      // Existing locks, including abandoned locks, are never removed or automatically verified.
      try { privateFile(fs.lstatSync(lockPath)); } catch (error) { if (!missing(error)) throw error; }
      lockFd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      lockStat = fs.fstatSync(lockFd); privateFile(lockStat);
      fs.writeFileSync(lockFd, randomUUID()); fs.fsyncSync(lockFd); fs.fsyncSync(directoryFd);
      // Re-read after the lock is acquired: a prior writer may have finished during acquisition.
      metadata = readMetadata(directory);
      if (!metadata) { metadata = { version: 1, installationId: randomUUID(), records: [] }; write(metadata); }
    } catch (error) {
      // Unsafe lock metadata is not an ordinary lock conflict.
      if (error instanceof ControlError && !poisoned) throw error;
      poisoned = true;
      try { releaseLock(); } catch { /* creation remains disabled */ }
      metadata = readMetadata(directory);
      if (!metadata) throw unavailable();
    }
  } catch {
    try { releaseLock(); } catch { /* never release another instance's lock */ }
    try { closeDirectory(); } catch { /* preserve the typed storage failure */ }
    throw unavailable();
  }
  function enqueue<T>(action: () => T): Promise<T> {
    if (closing) return Promise.reject(unavailable());
    const result = tail.then(() => { assertWriter(); return action(); });
    tail = result.then(() => undefined, () => undefined); return result;
  }
  return {
    reserve(input) {
      const request = controlRecord(input);
      if (!request) return Promise.reject(changed());
      const { operationId, agentId, requestDigest } = request;
      return enqueue(() => {
        if (!uuid(operationId) || typeof agentId !== 'string' || !isCanonicalScheduleAgentId(agentId) || !digest(requestDigest)) throw changed();
        const previous = metadata!.records.find(row => row.operationId.toLowerCase() === operationId.toLowerCase());
        if (previous) {
          if (previous.agentId !== agentId || previous.requestDigest !== requestDigest || previous.bindingDigest !== bindingDigest) throw changed();
          return { ...previous, reserved: false };
        }
        if (metadata!.records.some(row => row.agentId === agentId && row.requestDigest === requestDigest
          && (row.state === 'uncertain' || row.state === 'changed'))) throw changed();
        if (metadata!.records.length >= MAX_RECORDS) throw unavailable();
        const reservation: ScheduleReservation = { operationId, agentId, requestDigest, bindingDigest,
          declarationKey: `pixel-agents:${metadata!.installationId}:${operationId}`, createdAt: Date.now(), state: 'uncertain' };
        const next = { ...metadata!, records: [...metadata!.records, reservation] };
        // Only an explicitly new durable reservation authorizes first send; existing rows never grant replay.
        write(next); metadata = next; return { ...reservation, reserved: true };
      });
    },
    record(operationId, state, jobId) {
      return enqueue(() => {
        if (!uuid(operationId)) throw changed();
        const previous = metadata!.records.find(row => row.operationId.toLowerCase() === operationId.toLowerCase());
        if (!previous || previous.bindingDigest !== bindingDigest || !states.includes(state) || (jobId !== undefined && !jobIdValid(jobId))
          || (previous.jobId !== undefined && jobId !== undefined && previous.jobId !== jobId)) throw changed();
        const updated = { ...previous, state, ...(jobId !== undefined ? { jobId } : {}) };
        const next = { ...metadata!, records: metadata!.records.map(row => row === previous ? updated : row) };
        write(next); metadata = next;
      });
    },
    list(agentId) {
      if (typeof agentId !== 'string' || !isCanonicalScheduleAgentId(agentId)) throw changed();
      return metadata!.records.filter(row => row.agentId === agentId).map(row => ({ ...row }));
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = tail.then(() => {
        try {
          try { releaseLock(); }
          finally { closedAlready = true; closeDirectory(); }
        }
        catch { throw unavailable(); }
      });
      return closePromise;
    },
  };
}
