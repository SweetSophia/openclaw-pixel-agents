// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openScheduleJournal, readScheduleRecovery, type ScheduleJournal, type ScheduleReservation } from './scheduleJournal';
import { scheduleCreateDigest } from './scheduleProjection';

const directories: string[] = [];
const journals: ScheduleJournal[] = [];
const binding = { gatewayUrl: 'https://gateway.example.test', deviceId: 'a'.repeat(64) };
const digest = (text = 'one') => createHash('sha256').update(text).digest('hex');
const input = (text = 'one') => ({ operationId: randomUUID(), agentId: 'main', requestDigest: digest(text) });
function directory(): string {
  const result = fs.mkdtempSync(join(tmpdir(), 'pixel-schedule-journal-'));
  directories.push(result); return result;
}
function open(dir: string, nextBinding = binding): ScheduleJournal {
  const result = openScheduleJournal({ directory: dir, binding: nextBinding }); journals.push(result); return result;
}
function disk(dir: string): { version: number; installationId: string; records: ScheduleReservation[] } {
  return JSON.parse(fs.readFileSync(join(dir, 'journal.json'), 'utf8'));
}
function writeDisk(dir: string, value: unknown): void {
  fs.writeFileSync(join(dir, 'journal.json'), JSON.stringify(value), { mode: 0o600 });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) await journal.close().catch(() => undefined);
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('durable metadata-only schedule journal', () => {
  it('first_reservation_only_grants_admission_once_and_never_persists_the_flag', async () => {
    const dir = directory(); const journal = open(dir); const request = input();
    const results = await Promise.all([journal.reserve(request), journal.reserve(request), journal.reserve(request)]);
    expect(results.map(row => row.reserved)).toEqual([true, false, false]);
    expect(journal.list('main')[0]).not.toHaveProperty('reserved');
    expect((await readScheduleRecovery(dir, 'main'))[0]).not.toHaveProperty('reserved');
    expect(disk(dir).records[0]).not.toHaveProperty('reserved');
    await journal.close(); expect((await open(dir).reserve(request)).reserved).toBe(false);
  });
  it('reservation_survives_restart_without_payload', async () => {
    const dir = directory(); const journal = open(dir);
    const request = { ...input(), requestDigest: scheduleCreateDigest('main', {
      name: 'Synthetic', message: 'private prompt sentinel', schedule: { kind: 'every', everyMs: 60000 },
    }) };
    const reserved = await journal.reserve(request);
    expect(reserved).toMatchObject({ ...request, state: 'uncertain' });
    expect(reserved.declarationKey).toBe(`pixel-agents:${disk(dir).installationId}:${request.operationId}`);
    expect(reserved.declarationKey.length).toBeLessThan(200);
    const raw = fs.readFileSync(join(dir, 'journal.json'), 'utf8');
    expect(raw).not.toMatch(/prompt|token|message|private prompt sentinel|gateway\.example/);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(dir, 'journal.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(dir, 'journal.lock')).mode & 0o777).toBe(0o600);
    await journal.close();
    const restarted = open(dir);
    expect(await restarted.reserve(request)).toEqual({ ...reserved, reserved: false });
    const { reserved: _admission, ...metadata } = reserved;
    expect(restarted.list('main')).toEqual([metadata]);
    const detached = restarted.list('main'); detached[0].state = 'changed';
    reserved.state = 'observed';
    expect(restarted.list('main')[0].state).toBe('uncertain');
  });

  it('digest_conflict_and_unresolved_duplicate_intent', async () => {
    const journal = open(directory()); const request = input(); await journal.reserve(request);
    for (const changed of [{ ...request, requestDigest: digest('different') }, { ...request, agentId: 'other' },
      { ...request, operationId: randomUUID() }]) {
      await expect(journal.reserve(changed)).rejects.toMatchObject({ code: 'schedule-changed' });
    }
    expect(journal.list('main')).toHaveLength(1);
  });

  it.each(['uncertain', 'changed', 'acknowledged', 'observed'] as const)('blocks fresh duplicate intent only when unresolved: %s', async state => {
    const journal = open(directory()); const request = input(); await journal.reserve(request);
    await journal.record(request.operationId, state, state === 'acknowledged' ? 'native-job' : undefined);
    const next = journal.reserve({ ...request, operationId: randomUUID() });
    if (state === 'uncertain' || state === 'changed') await expect(next).rejects.toMatchObject({ code: 'schedule-changed' });
    else await expect(next).resolves.toMatchObject({ state: 'uncertain' });
  });

  it.each(['gatewayUrl', 'deviceId'] as const)('refuses old-binding reuse and mutation after changing %s', async field => {
    const dir = directory(); const first = open(dir); const request = input();
    const { reserved: _admission, ...original } = await first.reserve(request); await first.close();
    const changed = open(dir, { ...binding, [field]: field === 'gatewayUrl' ? 'https://other.example.test' : 'b'.repeat(64) });
    expect(changed.list('main')).toEqual([original]);
    await expect(changed.reserve(request)).rejects.toMatchObject({ code: 'schedule-changed' });
    await expect(changed.record(request.operationId, 'acknowledged', 'wrong-job')).rejects.toMatchObject({ code: 'schedule-changed' });
    await expect(changed.reserve({ ...request, operationId: randomUUID() })).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(disk(dir).records).toEqual([original]);
    expect((await changed.reserve(input('different'))).bindingDigest).not.toBe(original.bindingDigest);
  });

  it('all_500_records_are_retained', async () => {
    const dir = directory(); const journal = open(dir);
    for (let index = 0; index < 500; index++) await journal.reserve(input(String(index)));
    await expect(journal.reserve(input('record-501'))).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    expect(journal.list('main')).toHaveLength(500);
    expect(disk(dir).records).toHaveLength(500);
    await journal.close(); expect(open(dir).list('main')).toHaveLength(500);
  }, 20000);

  it('serializes competing reservations and preserves acknowledged metadata on restart', async () => {
    const dir = directory(); const journal = open(dir); const request = input();
    const [first, duplicate] = await Promise.all([journal.reserve(request), journal.reserve(request)]);
    expect(duplicate).toEqual({ ...first, reserved: false }); expect(disk(dir).records).toHaveLength(1);
    await journal.record(request.operationId, 'acknowledged', 'native-job');
    await journal.record(request.operationId, 'observed');
    await journal.close();
    const { reserved: _admission, ...metadata } = first;
    expect(open(dir).list('main')).toEqual([{ ...metadata, state: 'observed', jobId: 'native-job' }]);
  });

  it('settles queued writes before idempotent close and refuses new writes while closing', async () => {
    const dir = directory(); const journal = open(dir); const request = input();
    const queued = journal.reserve(request); const closing = journal.close();
    await expect(journal.reserve(input('late'))).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    await expect(journal.record(request.operationId, 'observed')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    await queued; await closing; await journal.close();
    expect(fs.existsSync(join(dir, 'journal.lock'))).toBe(false);
    expect(open(dir).list('main')[0].state).toBe('uncertain');
  });

  it.each([false, true])('normalizes directory-close failures without closing a reused fd or removing a foreign lock (replaced lock: %s)', async replacedLock => {
    const dir = directory(); const journal = open(dir); await journal.reserve(input());
    const lockPath = join(dir, 'journal.lock');
    if (replacedLock) {
      fs.renameSync(lockPath, join(dir, 'original.lock'));
      fs.writeFileSync(lockPath, 'foreign-lock', { mode: 0o600 });
    }
    const realClose = fs.closeSync; let reusedFd: number | undefined;
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
      if (reusedFd === undefined && fs.fstatSync(fd).isDirectory()) {
        realClose(fd);
        reusedFd = fs.openSync(join(dir, 'unrelated-file'), 'w+', 0o600);
        expect(reusedFd).toBe(fd);
        throw Object.assign(new Error('synthetic directory close failure'), { code: 'EIO' });
      }
      realClose(fd);
    });
    try {
      await expect(journal.close()).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
      if (!replacedLock) fs.writeFileSync(lockPath, 'foreign-lock', { mode: 0o600 });
      await expect(journal.close()).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
      expect(fs.fstatSync(reusedFd!).isFile()).toBe(true);
      expect(fs.readFileSync(lockPath, 'utf8')).toBe('foreign-lock');
      await expect(journal.reserve(input('closed'))).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    } finally {
      vi.restoreAllMocks(); if (reusedFd !== undefined) realClose(reusedFd);
    }
  });

  it('preserves the typed initialization failure when directory cleanup also fails', () => {
    const dir = directory(); const lockPath = join(dir, 'journal.lock');
    fs.writeFileSync(lockPath, 'foreign-lock', { mode: 0o600 });
    const realClose = fs.closeSync;
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
      const isDirectory = fs.fstatSync(fd).isDirectory(); realClose(fd);
      if (isDirectory) throw Object.assign(new Error('synthetic directory close failure'), { code: 'EIO' });
    });
    expect(() => open(dir)).toThrow(expect.objectContaining({ code: 'schedule-storage-unavailable' }));
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('foreign-lock');
  });

  it('clears lock-fd ownership before a failing close so read-only fallback cannot close a reused descriptor', async () => {
    const dir = directory(); const original = open(dir); await original.reserve(input()); await original.close();
    const lockPath = join(dir, 'journal.lock'); const realSync = fs.fsyncSync; const realClose = fs.closeSync;
    let failedLockFd: number | undefined; let reusedFd: number | undefined;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (!fs.fstatSync(fd).isDirectory() && failedLockFd === undefined) {
        failedLockFd = fd; throw Object.assign(new Error('synthetic lock sync failure'), { code: 'EIO' });
      }
      realSync(fd);
    });
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
      realClose(fd);
      if (fd === failedLockFd && reusedFd === undefined) {
        reusedFd = fs.openSync(join(dir, 'unrelated-file'), 'w+', 0o600);
        expect(reusedFd).toBe(fd);
        throw Object.assign(new Error('synthetic lock close failure'), { code: 'EIO' });
      }
    });
    try {
      const readonly = open(dir); vi.restoreAllMocks();
      fs.writeFileSync(lockPath, 'foreign-lock', { mode: 0o600 });
      await readonly.close();
      expect(fs.fstatSync(reusedFd!).isFile()).toBe(true);
      expect(fs.readFileSync(lockPath, 'utf8')).toBe('foreign-lock');
    } finally {
      vi.restoreAllMocks(); if (reusedFd !== undefined) { try { realClose(reusedFd); } catch { /* regression closes the foreign fd */ } }
    }
  });

  it('keeps active writer lock intact when a second instance reads or closes', async () => {
    const dir = directory(); const first = open(dir); const request = input(); const { reserved: _admission, ...record } = await first.reserve(request);
    const lock = fs.readFileSync(join(dir, 'journal.lock'), 'utf8'); const second = open(dir);
    expect(second.list('main')).toEqual([record]);
    await expect(second.reserve(input('blocked'))).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    await expect(second.record(request.operationId, 'observed')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    await second.close(); expect(fs.readFileSync(join(dir, 'journal.lock'), 'utf8')).toBe(lock);
    await first.record(request.operationId, 'observed');
  });

  it('never steals an abandoned lock and still permits side-effect-free recovery', async () => {
    const dir = directory(); const journal = open(dir); const request = input(); const { reserved: _admission, ...original } = await journal.reserve(request);
    await journal.close(); fs.writeFileSync(join(dir, 'journal.lock'), 'abandoned-unverified-owner', { mode: 0o600 });
    const before = fs.readdirSync(dir); const raw = fs.readFileSync(join(dir, 'journal.json'), 'utf8');
    expect(await readScheduleRecovery(dir, 'main')).toEqual([original]);
    const readonly = open(dir);
    await expect(readonly.reserve(input('new'))).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    await expect(readonly.record(request.operationId, 'observed')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    await readonly.close();
    expect(fs.readdirSync(dir)).toEqual(before);
    expect(fs.readFileSync(join(dir, 'journal.lock'), 'utf8')).toBe('abandoned-unverified-owner');
    expect(fs.readFileSync(join(dir, 'journal.json'), 'utf8')).toBe(raw);
  });

  it('releases only its own lock and poisons writes when lock ownership is lost', async () => {
    const dir = directory(); const journal = open(dir); const request = input(); await journal.reserve(request);
    fs.renameSync(join(dir, 'journal.lock'), join(dir, 'abandoned-original.lock'));
    fs.writeFileSync(join(dir, 'journal.lock'), 'another-owner', { mode: 0o600 });
    await expect(journal.record(request.operationId, 'observed')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    await journal.close(); expect(fs.readFileSync(join(dir, 'journal.lock'), 'utf8')).toBe('another-owner');
    expect(disk(dir).records[0].state).toBe('uncertain');
  });

  it('recovery allocates neither a missing directory nor an identity or lock', async () => {
    const parent = directory(); const missing = join(parent, 'missing');
    expect(await readScheduleRecovery(missing, 'main')).toEqual([]); expect(fs.readdirSync(parent)).toEqual([]);
    const empty = directory(); expect(await readScheduleRecovery(empty, 'main')).toEqual([]);
    expect(fs.readdirSync(empty)).toEqual([]);
  });

  it('does not allocate a new installation beside a lock with missing journal metadata', async () => {
    const dir = directory(); fs.writeFileSync(join(dir, 'journal.lock'), 'unverified', { mode: 0o600 });
    expect(() => open(dir)).toThrow(expect.objectContaining({ code: 'schedule-storage-unavailable' }));
    expect(await readScheduleRecovery(dir, 'main')).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(['journal.lock']);
  });

  it('leaves crash-shaped foreign temporary files untouched and recovers uncertain metadata', async () => {
    const dir = directory(); const journal = open(dir); const { reserved: _admission, ...original } = await journal.reserve(input()); await journal.close();
    const orphan = join(dir, `journal.${randomUUID()}.tmp`);
    fs.writeFileSync(orphan, '{partial-write', { mode: 0o600 });
    const reopened = open(dir); await reopened.reserve(input('new'));
    expect(fs.readFileSync(orphan, 'utf8')).toBe('{partial-write');
    expect((await readScheduleRecovery(dir, 'main'))[0]).toEqual(original);
  });

  it('returns only validated read-only metadata when opening the writer directory fails', async () => {
    const dir = directory(); const first = open(dir); const { reserved: _admission, ...original } = await first.reserve(input()); await first.close();
    const real = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === dir) throw new Error('synthetic writer directory open failure'); return real(...args);
    });
    const readonly = open(dir);
    expect(readonly.list('main')).toEqual([original]);
    await expect(readonly.reserve(input('blocked'))).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    await expect(readonly.record(original.operationId, 'observed')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    await readonly.close(); expect(fs.existsSync(join(dir, 'journal.lock'))).toBe(false);
  });

  it.each(['json', 'version', 'unknown', 'reserved', 'installation', 'declaration', 'digest', 'state', 'time', 'operation', 'duplicate', 'jobId', 'records'])('rejects corrupt metadata without replacing it: %s', async corruption => {
    const dir = directory(); const journal = open(dir); await journal.reserve(input()); await journal.close();
    const value = disk(dir);
    if (corruption === 'json') fs.writeFileSync(join(dir, 'journal.json'), '{bad');
    else {
      const row = value.records[0] as unknown as Record<string, unknown>;
      if (corruption === 'version') value.version = 2;
      if (corruption === 'unknown') row.prompt = 'never permit private payload';
      if (corruption === 'reserved') Object.defineProperty(row, '__proto__', { value: {}, enumerable: true });
      if (corruption === 'installation') value.installationId = 'not-a-uuid';
      if (corruption === 'declaration') row.declarationKey = `pixel-agents:${randomUUID()}:${row.operationId}`;
      if (corruption === 'digest') row.requestDigest = 'invalid';
      if (corruption === 'state') row.state = 'sent';
      if (corruption === 'time') row.createdAt = -1;
      if (corruption === 'operation') row.operationId = '../unsafe';
      if (corruption === 'duplicate') value.records.push(value.records[0]);
      if (corruption === 'jobId') row.jobId = 'x'.repeat(201);
      if (corruption === 'records') value.records = Array.from({ length: 501 }, () => value.records[0]);
      writeDisk(dir, value);
    }
    const before = fs.readFileSync(join(dir, 'journal.json'), 'utf8');
    expect(() => open(dir)).toThrow(expect.objectContaining({ code: 'schedule-storage-unavailable' }));
    await expect(readScheduleRecovery(dir, 'main')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    expect(fs.readFileSync(join(dir, 'journal.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(join(dir, 'journal.lock'))).toBe(false);
  });

  it('bounds file bytes before parsing', async () => {
    const dir = directory(); fs.writeFileSync(join(dir, 'journal.json'), ' '.repeat(1024 * 1024 + 1), { mode: 0o600 });
    expect(() => open(dir)).toThrow(expect.objectContaining({ code: 'schedule-storage-unavailable' }));
    await expect(readScheduleRecovery(dir, 'main')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
  });

  it('rejects malformed UTF-8 instead of silently repairing persisted metadata', async () => {
    const dir = directory(); const journal = open(dir); const request = input(); await journal.reserve(request);
    await journal.record(request.operationId, 'acknowledged', 'native-job'); await journal.close();
    const bytes = fs.readFileSync(join(dir, 'journal.json'));
    bytes[bytes.indexOf('native-job')] = 0xff; fs.writeFileSync(join(dir, 'journal.json'), bytes);
    expect(() => open(dir)).toThrow(expect.objectContaining({ code: 'schedule-storage-unavailable' }));
    await expect(readScheduleRecovery(dir, 'main')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
  });

  it.each(['directory', 'file', 'unreadable'] as const)('refuses unsafe or missing permissions: %s', async target => {
    const dir = directory(); const journal = open(dir); await journal.reserve(input()); await journal.close();
    fs.chmodSync(target === 'directory' ? dir : join(dir, 'journal.json'), target === 'unreadable' ? 0 : 0o755);
    expect(() => open(dir)).toThrow(expect.objectContaining({ code: 'schedule-storage-unavailable' }));
    await expect(readScheduleRecovery(dir, 'main')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    fs.chmodSync(dir, 0o700); fs.chmodSync(join(dir, 'journal.json'), 0o600);
  });

  it.each(['directory', 'ancestor', 'file', 'lock'] as const)('refuses symbolic links without following them: %s', async target => {
    const dir = directory(); const real = join(dir, 'real'); fs.mkdirSync(real, { mode: 0o700 });
    const journal = open(real); await journal.reserve(input()); await journal.close();
    let selected = real;
    if (target === 'directory' || target === 'ancestor') {
      fs.symlinkSync(real, join(dir, 'link')); selected = join(dir, 'link');
      if (target === 'ancestor') { fs.mkdirSync(join(real, 'child'), { mode: 0o700 }); selected = join(selected, 'child'); }
    } else {
      const file = join(real, target === 'file' ? 'journal.json' : 'journal.lock');
      const outside = join(dir, 'outside'); fs.writeFileSync(outside, target === 'file' ? fs.readFileSync(file) : 'owner', { mode: 0o600 });
      if (target === 'file') fs.unlinkSync(file); fs.symlinkSync(outside, file);
    }
    expect(() => open(selected)).toThrow(expect.objectContaining({ code: 'schedule-storage-unavailable' }));
    if (target !== 'lock') await expect(readScheduleRecovery(selected, 'main')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
  });

  it.each(['open', 'write', 'rename', 'file-sync', 'directory-sync'] as const)('fails closed and poisons later mutations after %s failure', async failure => {
    const dir = directory(); const journal = open(dir); const first = input(); await journal.reserve(first);
    const original = fs.readFileSync(join(dir, 'journal.json'), 'utf8');
    if (failure === 'open') {
      const real = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
        if (String(args[0]).endsWith('.tmp')) throw new Error('synthetic open failure'); return real(...args);
      });
    }
    if (failure === 'write') vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('synthetic write failure'); });
    if (failure === 'rename') vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('synthetic rename failure'); });
    if (failure === 'file-sync' || failure === 'directory-sync') {
      const real = fs.fsyncSync;
      vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
        if (fs.fstatSync(fd).isDirectory() === (failure === 'directory-sync')) throw new Error('synthetic sync failure'); real(fd);
      });
    }
    const uncertain = input('not-acknowledged');
    await expect(journal.reserve(uncertain)).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    vi.restoreAllMocks();
    const afterFailure = fs.readFileSync(join(dir, 'journal.json'), 'utf8');
    await expect(journal.reserve(input('must-not-write'))).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    await expect(journal.record(first.operationId, 'observed')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    expect(fs.readFileSync(join(dir, 'journal.json'), 'utf8')).toBe(afterFailure);
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    if (failure !== 'directory-sync') expect(afterFailure).toBe(original);
    await journal.close(); const recovered = await readScheduleRecovery(dir, 'main');
    expect(recovered.every(row => row.state === 'uncertain')).toBe(true);
    expect(recovered.some(row => row.operationId === uncertain.operationId)).toBe(failure === 'directory-sync');
    expect(open(dir).list('main')).toEqual(recovered);
  });

  it('unsupported initial durability fails creation instead of returning a healthy empty journal', () => {
    const dir = directory(); vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('unsupported fsync'); });
    expect(() => open(dir)).toThrow(expect.objectContaining({ code: 'schedule-storage-unavailable' }));
  });

  it('rejects a substituted temporary file without renaming or deleting an unowned link', async () => {
    const dir = directory(); const journal = open(dir); await journal.reserve(input());
    const before = fs.readFileSync(join(dir, 'journal.json'), 'utf8');
    const outside = join(dir, 'outside'); fs.writeFileSync(outside, 'untouched', { mode: 0o600 });
    const real = fs.fsyncSync; let substituted: string | undefined;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      real(fd);
      if (!fs.fstatSync(fd).isDirectory() && !substituted) {
        substituted = join(dir, fs.readdirSync(dir).find(name => name.endsWith('.tmp'))!);
        fs.unlinkSync(substituted); fs.symlinkSync(outside, substituted);
      }
    });
    await expect(journal.reserve(input('replacement'))).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    vi.restoreAllMocks();
    expect(fs.readFileSync(join(dir, 'journal.json'), 'utf8')).toBe(before);
    expect(fs.lstatSync(substituted!).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
  });

  it('validates mutation identities and never stores extra request fields', async () => {
    const dir = directory(); const journal = open(dir);
    for (const changed of [{ ...input(), operationId: 'bad' }, { ...input(), agentId: 'Main' }, { ...input(), requestDigest: 'bad' }]) {
      await expect(journal.reserve(changed)).rejects.toMatchObject({ code: 'schedule-changed' });
    }
    const request = input(); await journal.reserve({ ...request, prompt: 'hidden', token: 'hidden' } as typeof request);
    await expect(journal.record(randomUUID(), 'observed')).rejects.toMatchObject({ code: 'schedule-changed' });
    await expect(journal.record(request.operationId, 'observed', 'x'.repeat(201))).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(fs.readFileSync(join(dir, 'journal.json'), 'utf8')).not.toMatch(/prompt|token|hidden/);
    expect(journal.list('other')).toEqual([]);
  });

  it('returns typed failures for malformed runtime mutation values without coercing agent IDs', async () => {
    const dir = directory(); const journal = open(dir);
    await expect(journal.reserve({ ...input(), agentId: 123 } as unknown as Parameters<ScheduleJournal['reserve']>[0]))
      .rejects.toMatchObject({ code: 'schedule-changed' });
    await expect(journal.reserve(null as unknown as Parameters<ScheduleJournal['reserve']>[0]))
      .rejects.toMatchObject({ code: 'schedule-changed' });
    await expect(journal.record(null as unknown as string, 'observed')).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(() => journal.list(123 as unknown as string)).toThrow(expect.objectContaining({ code: 'schedule-changed' }));
    expect(disk(dir).records).toEqual([]);
  });
});
