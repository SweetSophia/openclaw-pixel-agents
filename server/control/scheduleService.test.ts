// @vitest-environment node
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlByteSize } from '../../shared/control';
import { parseScheduleOperationsPage, parseScheduleSnapshot, type ScheduleManagement } from '../../shared/controlSchedules';
import { createScheduleService, type ScheduleService } from './scheduleService';
import type { ControlGateway, GatewayEvent, ScheduleGateway } from './gatewayClient';
import { openScheduleJournal } from './scheduleJournal';

const directories: string[] = []; const services: ScheduleService[] = [];
function native(id: string, agentId = 'main', message = 'Synthetic prompt') {
  return { id, agentId, effectiveAgentId: agentId, owner: { agentId }, name: 'Synthetic', enabled: false,
    configRevision: 'revision-1', schedule: { kind: 'every', everyMs: 60000 }, sessionTarget: 'isolated',
    wakeMode: 'now', payload: { kind: 'agentTurn', message }, delivery: { mode: 'none' }, failureAlert: false, state: {} };
}
function writeRecovery(root: string, count = 500) {
  const directory = join(root, 'control-schedules'); fs.mkdirSync(directory, { mode: 0o700 }); const installationId = randomUUID();
  const records = Array.from({ length: count }, () => {
    const operationId = randomUUID(); return { operationId, agentId: 'main', declarationKey: `pixel-agents:${installationId}:${operationId}`,
      requestDigest: 'a'.repeat(64), bindingDigest: 'b'.repeat(64), createdAt: 1700000000000, state: 'acknowledged', jobId: '界'.repeat(200) };
  });
  const metadata = { version: 1, installationId, records }; const path = join(directory, 'journal.json');
  fs.writeFileSync(path, JSON.stringify(metadata), { mode: 0o600 }); return { metadata, path, directory };
}
function fixture(rows = [native('one')], enabled = false) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pixel-schedule-service-')); directories.push(directory);
  const events = new Set<(event: GatewayEvent) => void>();
  let generation = 1; let revision = 'snapshot-1'; let readable = true;
  let management: ScheduleManagement = { configured: enabled, state: enabled ? 'pairing-required' : 'disabled', canManage: false, epoch: null, reason: enabled ? 'pairing-required' : 'disabled' };
  const reader: ControlGateway = { start() {}, close() {}, status: () => ({ configured: true, state: readable ? 'ready' : 'unavailable', canRead: readable, canSend: false }),
    onEvent(listener) { events.add(listener); return () => events.delete(listener); },
    artifactConnection: () => readable ? { id: `reader-${generation}`, generation, gatewayUrl: 'ws://127.0.0.1:9/' } : null,
    request: vi.fn(async (_method, params) => {
      const offset = params.offset as number; const jobs = rows.slice(offset, offset + 50); const next = offset + jobs.length;
      return { jobs, snapshotRevision: revision, total: rows.length, offset, limit: 50, hasMore: next < rows.length, nextOffset: next < rows.length ? next : null };
    }) };
  const manager: ScheduleGateway = { start: vi.fn(), close: vi.fn(), status: () => management, connection: () => null, request: vi.fn(async () => { throw Error('Admin must not read'); }) };
  const service = createScheduleService({ reader, manager, config: { enabled, deviceDirectory: join(directory, 'control-schedules') }, registeredAgents: () => new Set(['main', 'other', 'Upper']) });
  services.push(service);
  return { service, reader, manager, directory, rows,
    invalidate() { generation++; for (const listener of events) listener({ event: 'source.invalidated', payload: null }); },
    setRevision(value: string) { revision = value; }, setReadable(value: boolean) { readable = value; },
    setManagement(value: ScheduleManagement) { management = value; } };
}
afterEach(async () => { vi.useRealTimers(); for (const service of services.splice(0)) await service.close(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('bounded private schedule browsing', () => {
  it('filters_owned_jobs_but_tracks_scanned_native_rows', async () => {
    const f = fixture(Array.from({ length: 251 }, (_, i) => native(`job-${i}`, i === 199 || i === 250 ? 'main' : 'foreign')));
    const first = await f.service.read('main');
    expect(first.jobs.map(row => row.id)).toEqual(['job-199']); expect(first.scanned).toBe(200); expect(first.truncated).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(f.reader.request).toHaveBeenCalledTimes(4);
    expect(f.reader.request).toHaveBeenNthCalledWith(1, 'cron.list', { agentId: 'main', includeDisabled: true, includeDeliveryPreviews: false, limit: 50, offset: 0 }, expect.any(AbortSignal));
    const last = await f.service.read('main', first.nextCursor);
    expect(last.jobs.map(row => row.id)).toEqual(['job-250']); expect(last.scanned).toBe(251); expect(last.truncated).toBe(true); expect(last.nextCursor).toBeUndefined();
    expect(f.manager.start).not.toHaveBeenCalled(); expect(f.manager.request).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.directory)).toEqual([]);
  });
  it('large_prompts_continue_at_unreturned_row', async () => {
    const f = fixture(Array.from({ length: 50 }, (_, i) => native(`job-${i}`, 'main', 'x'.repeat(16384))));
    const all: string[] = []; let cursor: string | undefined; let previous = 0;
    do {
      const snapshot = await f.service.read('main', cursor);
      expect(controlByteSize(snapshot)).toBeLessThanOrEqual(256 * 1024);
      expect(snapshot.jobs.length).toBeLessThanOrEqual(50); expect(snapshot.jobs.length).toBeGreaterThan(0);
      expect(snapshot.jobs.every(row => row.draft?.message.length === 16384)).toBe(true);
      expect(parseScheduleSnapshot(snapshot)).not.toBeNull();
      if (!cursor) expect(snapshot.nextCursor).toEqual(expect.any(String));
      expect(snapshot.jobs[0].id).toBe(`job-${previous}`);
      all.push(...snapshot.jobs.map(row => row.id)); expect(snapshot.scanned).toBe(all.length);
      previous = all.length; cursor = snapshot.nextCursor;
    } while (cursor);
    expect(all).toEqual(Array.from({ length: 50 }, (_, i) => `job-${i}`));
  });
  it('caps_returned_jobs_and_cumulative_native_rows', async () => {
    const own = fixture(Array.from({ length: 80 }, (_, i) => native(`job-${i}`)));
    const first = await own.service.read('main'); expect(first.jobs).toHaveLength(50); expect(first.scanned).toBe(50);
    const f = fixture(Array.from({ length: 2050 }, (_, i) => native(`foreign-${i}`, 'foreign')));
    let cursor: string | undefined; let snapshot;
    for (let i = 1; i <= 10; i++) { snapshot = await f.service.read('main', cursor); expect(snapshot.scanned).toBe(i * 200); cursor = snapshot.nextCursor; }
    expect(snapshot).toMatchObject({ jobs: [], scanned: 2000, truncated: true }); expect(cursor).toBeUndefined(); expect(f.reader.request).toHaveBeenCalledTimes(40);
  });
  it('accounts_for_scanned_count_json_growth_before_accepting_a_byte_boundary_row', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1700000000000);
    const large = Array.from({ length: 10 }, (_, i) => native(`large-${i}`, 'main', i < 9 ? '"'.repeat(14000) : 'x'));
    const projected = large.map(job => ({ id: job.id, agentId: 'main', name: 'Synthetic', enabled: false,
      revision: 'revision-1', scheduleKind: 'every', draft: { name: 'Synthetic', message: job.payload.message, schedule: { kind: 'every', everyMs: 60000 } }, readOnlyReason: null }));
    // Fill the old-count encoding exactly; accepting row 100 must account for its extra count byte.
    const bytes = controlByteSize({ agentId: 'main', source: { state: 'current', observedAt: 1700000000000 },
      management: { configured: false, state: 'disabled', canManage: false, epoch: null, reason: 'disabled' },
      jobs: projected, operations: [], scanned: 99, truncated: true, nextCursor: 'x'.repeat(43) });
    large[9].payload.message = 'x'.repeat(1 + 256 * 1024 - bytes);
    expect(large[9].payload.message.length).toBeLessThanOrEqual(16384);
    const f = fixture([...Array.from({ length: 50 }, (_, i) => native(`first-${i}`)), ...large.slice(0, 9),
      ...Array.from({ length: 40 }, (_, i) => native(`foreign-${i}`, 'foreign')), large[9], native('last')]);
    const first = await f.service.read('main'); const snapshot = await f.service.read('main', first.nextCursor);
    expect(snapshot.jobs).toHaveLength(9); expect(snapshot.scanned).toBe(99); expect(controlByteSize(snapshot)).toBeLessThanOrEqual(256 * 1024);
    expect(snapshot.nextCursor).toEqual(expect.any(String));
  });
  it.each([
    {}, { jobs: [] }, { jobs: [], snapshotRevision: 's', total: 1, offset: 0, limit: 50, hasMore: true, nextOffset: 0 },
    { jobs: [], snapshotRevision: 's', total: 1, offset: 0, limit: 50, hasMore: false, nextOffset: null },
    { jobs: [], snapshotRevision: 's', total: 0, offset: 0, limit: 49, hasMore: false, nextOffset: null },
    { jobs: [null], snapshotRevision: 's', total: 1, offset: 0, limit: 50, hasMore: false, nextOffset: null },
    { jobs: [], snapshotRevision: 's', total: 0, offset: 0, limit: 50, hasMore: false, nextOffset: null, unknown: true },
  ])('malformed_page_does_not_claim_empty (%j)', async page => {
    const f = fixture(); vi.mocked(f.reader.request).mockResolvedValue(page);
    await expect(f.service.read('main')).rejects.toMatchObject({ code: 'invalid-source' });
  });
  it('uppercase_roster_disables_without_retargeting', async () => {
    const f = fixture(); await expect(f.service.read('Upper')).rejects.toMatchObject({ code: 'schedule-denied' });
    await expect(f.service.operations('Upper')).rejects.toMatchObject({ code: 'schedule-denied' }); expect(f.reader.request).not.toHaveBeenCalled();
    await expect(f.service.read('missing')).rejects.toMatchObject({ code: 'invalid-target' });
  });
  it('reader_outage_never_falls_back_to_admin', async () => {
    const f = fixture(undefined, true); f.setReadable(false);
    await expect(f.service.read('main')).rejects.toMatchObject({ code: 'unavailable' }); expect(f.manager.request).not.toHaveBeenCalled(); expect(f.manager.start).not.toHaveBeenCalled();
  });
  it('keeps_management_pairing_independent_and_starts_only_on_new_browse', async () => {
    const f = fixture(Array.from({ length: 51 }, (_, i) => native(`job-${i}`)), true);
    await f.service.operations('main'); expect(f.manager.start).not.toHaveBeenCalled();
    const first = await f.service.read('main'); expect(first.management).toMatchObject({ state: 'pairing-required', canManage: false });
    expect(f.manager.start).toHaveBeenCalledTimes(1); await f.service.read('main', first.nextCursor); expect(f.manager.start).toHaveBeenCalledTimes(1);
    await f.service.read('main'); expect(f.manager.start).toHaveBeenCalledTimes(1);
  });
  it('requires_refresh_when_native_deletion_clamps_a_continuation_offset', async () => {
    const f = fixture(Array.from({ length: 51 }, (_, i) => native(`job-${i}`))); const first = await f.service.read('main');
    vi.mocked(f.reader.request).mockResolvedValue({ jobs: [], snapshotRevision: 'changed-snapshot', total: 0, offset: 0, limit: 50, hasMore: false, nextOffset: null });
    await expect(f.service.read('main', first.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
  });
  it('rejects_a_nonadvancing_terminal_continuation_even_with_an_unchanged_native_revision', async () => {
    const f = fixture(Array.from({ length: 51 }, (_, i) => native(`job-${i}`))); const first = await f.service.read('main');
    vi.mocked(f.reader.request).mockResolvedValue({ jobs: [], snapshotRevision: 'snapshot-1', total: 50, offset: 50, limit: 50, hasMore: false, nextOffset: null });
    await expect(f.service.read('main', first.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
  });
  it('keeps_filtered_terminal_pages_partial_and_never_exports_manager_secrets', async () => {
    const f = fixture([native('foreign', 'foreign')], true);
    f.setManagement(Object.assign({ configured: true, state: 'ready' as const, canManage: true, epoch: 'manager-epoch', reason: null }, { token: 'synthetic-secret', deviceToken: 'synthetic-device-token' }));
    const snapshot = await f.service.read('main');
    expect(snapshot).toMatchObject({ jobs: [], scanned: 1, truncated: true }); expect(snapshot.nextCursor).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-secret|synthetic-device-token|deviceToken/); expect(parseScheduleSnapshot(snapshot)).not.toBeNull();
  });
  it('rejects_cursors_across_agents_epochs_native_revisions_expiry_eviction_and_restart', async () => {
    const f = fixture(Array.from({ length: 51 }, (_, i) => native(`job-${i}`)));
    const first = await f.service.read('main');
    await expect(f.service.read('other', first.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    f.invalidate(); await expect(f.service.read('main', first.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    const second = await f.service.read('main'); f.setRevision('snapshot-2');
    await expect(f.service.read('main', second.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    const expired = await f.service.read('main'); vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60001);
    await expect(f.service.read('main', expired.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' }); vi.useRealTimers();
    const evicted = await f.service.read('main'); for (let i = 0; i < 100; i++) await f.service.read('main');
    await expect(f.service.read('main', evicted.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    await expect(fixture().service.read('main', expired.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
  });
  it('rejects_reader_invalidation_during_an_admitted_page', async () => {
    const f = fixture(); const original = f.reader.request;
    vi.mocked(f.reader.request).mockImplementationOnce(async (...args) => { const page = await original(...args); f.invalidate(); return page; });
    await expect(f.service.read('main')).rejects.toMatchObject({ code: 'schedule-changed' });
  });
  it('projects_recovery_metadata_without_allocating_identity_or_reconciling_changed_binding', async () => {
    const f = fixture(undefined, true); const directory = join(f.directory, 'control-schedules');
    const journal = openScheduleJournal({ directory, binding: { gatewayUrl: 'ws://old.synthetic.test', deviceId: 'old-device' } });
    const reserved = await journal.reserve({ operationId: randomUUID(), agentId: 'main', requestDigest: 'a'.repeat(64) }); await journal.close();
    const before = fs.readdirSync(directory); const result = await f.service.operations('main');
    expect(result).toEqual({ agentId: 'main', operations: [{ operationId: reserved.operationId, agentId: 'main', action: 'create', state: 'unknown' }] });
    expect(fs.readdirSync(directory)).toEqual(before); expect(JSON.stringify(result)).not.toMatch(/digest|declaration|binding|old-device/);
    expect(f.manager.start).not.toHaveBeenCalled(); expect(f.manager.request).not.toHaveBeenCalled();
    fs.writeFileSync(join(directory, 'journal.json'), '{}');
    await expect(f.service.operations('main')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
    await expect(f.service.read('main')).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
  });
  it('browses_intact_native_prompts_and_retrieves_all_500_large_recovery_records_independently', async () => {
    const f = fixture([native('large', 'main', 'x'.repeat(16384))], true); const saved = writeRecovery(f.directory);
    const metadata = await f.service.operations('main'); expect(metadata.operations).toHaveLength(50); expect(metadata.nextCursor).toEqual(expect.any(String));
    expect(f.manager.start).not.toHaveBeenCalled(); expect(f.reader.request).not.toHaveBeenCalled();
    const snapshot = await f.service.read('main'); expect(parseScheduleSnapshot(snapshot)).not.toBeNull();
    expect(snapshot.jobs[0].draft?.message).toBe('x'.repeat(16384)); expect(controlByteSize(snapshot)).toBeLessThanOrEqual(256 * 1024);
    expect(snapshot.operations).toEqual(metadata.operations); expect(snapshot.operationsCursor).toEqual(expect.any(String));
    expect(snapshot.nextCursor).toBeUndefined(); expect(snapshot.truncated).toBe(false); expect(snapshot.scanned).toBe(1);
    const all = [...snapshot.operations]; let cursor = snapshot.operationsCursor; let pages = 1;
    while (cursor) {
      const page = await f.service.operations('main', cursor); expect(parseScheduleOperationsPage(page)).not.toBeNull();
      expect(page.operations).toHaveLength(50); expect(controlByteSize(page)).toBeLessThanOrEqual(256 * 1024);
      all.push(...page.operations); cursor = page.nextCursor; pages++; expect(pages).toBeLessThanOrEqual(10);
    }
    expect(all.map(row => row.operationId)).toEqual(saved.metadata.records.map(row => row.operationId)); expect(pages).toBe(10);
    expect(all.every(row => row.state === 'unknown' && row.jobId === '界'.repeat(200))).toBe(true);
    expect(f.reader.request).toHaveBeenCalledTimes(1); expect(f.manager.start).toHaveBeenCalledTimes(1); expect(f.manager.request).not.toHaveBeenCalled();
    expect(fs.readdirSync(saved.directory)).toEqual(['journal.json']); expect(JSON.parse(fs.readFileSync(saved.path, 'utf8'))).toEqual(saved.metadata);
  });
  it('isolates_recovery_cursors_by_purpose_agent_metadata_revision_expiry_and_restart', async () => {
    const f = fixture(Array.from({ length: 51 }, (_, i) => native(`job-${i}`))); const saved = writeRecovery(f.directory);
    const metadata = await f.service.operations('main'); const first = await f.service.read('main');
    await expect(f.service.read('main', metadata.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    await expect(f.service.operations('main', first.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    await expect(f.service.operations('other', metadata.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    await expect(f.service.operations('main', `${metadata.nextCursor}x`)).rejects.toMatchObject({ code: 'schedule-changed' });
    f.invalidate(); expect((await f.service.operations('main', metadata.nextCursor)).operations).toHaveLength(50);
    saved.metadata.records[0].state = 'observed'; fs.writeFileSync(saved.path, JSON.stringify(saved.metadata));
    await expect(f.service.operations('main', metadata.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    const fresh = await f.service.operations('main'); vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60001);
    await expect(f.service.operations('main', fresh.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' }); vi.useRealTimers();
    await expect(fixture().service.operations('main', fresh.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(f.manager.start).not.toHaveBeenCalled(); expect(f.manager.request).not.toHaveBeenCalled();
  });
  it('shares_the_100_cursor_capacity_between_native_and_recovery_continuations', async () => {
    const f = fixture(Array.from({ length: 51 }, (_, i) => native(`job-${i}`))); writeRecovery(f.directory);
    const first = await f.service.read('main');
    for (let i = 0; i < 100; i++) await f.service.operations('main');
    await expect(f.service.read('main', first.nextCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    await expect(f.service.operations('main', first.operationsCursor)).rejects.toMatchObject({ code: 'schedule-changed' });
  });
  it('synchronously_closes_admission_and_manager_then_awaits_admitted_reads', async () => {
    const f = fixture(); let settle!: (value: unknown) => void; let aborted = false;
    vi.mocked(f.reader.request).mockImplementation((_method, _params, signal) => new Promise(resolve => { settle = resolve; signal?.addEventListener('abort', () => { aborted = true; }); }));
    const read = f.service.read('main'); const rejected = expect(read).rejects.toMatchObject({ code: 'unavailable' });
    await vi.waitFor(() => expect(settle).toEqual(expect.any(Function)));
    let finished = false; const closing = f.service.close().then(() => { finished = true; });
    expect(f.manager.close).toHaveBeenCalledTimes(1); expect(aborted).toBe(true); expect(finished).toBe(false);
    await expect(f.service.read('main')).rejects.toMatchObject({ code: 'unavailable' });
    settle({}); await closing; await rejected; expect(finished).toBe(true);
  });
});
