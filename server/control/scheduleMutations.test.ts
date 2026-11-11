// @vitest-environment node
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleConfirmation, ScheduleIntent, ScheduleManagement } from '../../shared/controlSchedules';
import { createScheduleMutations, type ScheduleMutations } from './scheduleMutations';
import { openScheduleJournal, type ScheduleJournal } from './scheduleJournal';
import { buildScheduleCreate, scheduleCreateDigest } from './scheduleProjection';
import { GatewayRequestError, type ScheduleGateway } from './gatewayClient';

const draft = { name: 'Synthetic', message: 'Synthetic prompt', schedule: { kind: 'every' as const, everyMs: 60000 } };
const intent: ScheduleIntent = { kind: 'create', draft };
const directories: string[] = []; const mutations: ScheduleMutations[] = []; const journals: ScheduleJournal[] = [];
function native(declarationKey = 'external:synthetic') {
  return { ...buildScheduleCreate('main', declarationKey, draft), id: 'job-1', effectiveAgentId: 'main', configRevision: 'revision-1', state: {} };
}
function fixture(acquireRead: () => () => void = () => () => {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pixel-schedule-mutations-')); directories.push(directory);
  const connection = { epoch: 'epoch-1', gatewayUrl: 'ws://127.0.0.1:9/', deviceId: 'synthetic-device' };
  let management: ScheduleManagement = { configured: true, state: 'ready', canManage: true, epoch: 'epoch-1', reason: null };
  let readable = true; const registered = new Set(['main', 'other', 'Upper']);
  const binding = () => ({ gatewayUrl: connection.gatewayUrl, deviceId: connection.deviceId });
  let journal = openScheduleJournal({ directory, binding: binding() }); journals.push(journal);
  const manager: ScheduleGateway = { start() {}, close() {}, status: () => management, connection: () => connection,
    request: vi.fn(async (method, params) => {
      if (method === 'cron.get') return native();
      if (method === 'cron.add') return { created: true, job: { ...params, id: 'job-1', configRevision: 'revision-1', state: {} } };
      if (method === 'cron.update') return { ...native(), ...params.patch as object, configRevision: 'revision-2' };
      return { jobs: [], snapshotRevision: 'snapshot-1', total: 0, offset: params.offset, limit: 50, hasMore: false, nextOffset: null };
    }) };
  function open() {
    const result = createScheduleMutations({ manager, journal: () => journal, registeredAgents: () => registered, readerReady: () => readable, acquireRead });
    mutations.push(result); return result;
  }
  const service = open();
  return { service, manager, directory, journal, connection, registered, open,
    setReadable(value: boolean) { readable = value; }, setManagement(value: ScheduleManagement) { management = value; },
    replaceJournal(value: ScheduleJournal) { journal = value; },
    async restart() { await service.close(); await journal.close(); journal = openScheduleJournal({ directory, binding: binding() }); journals.push(journal); return open(); } };
}
async function submit(f: ReturnType<typeof fixture>, value: ScheduleIntent = intent) {
  const confirmation = await f.service.prepare('main', value);
  return f.service.submit('main', { operationId: confirmation.operationId, intent: confirmation.intent });
}
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const service of mutations.splice(0)) await service.close();
  for (const journal of journals.splice(0)) await journal.close().catch(() => undefined);
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('confirmed native schedule mutations without replay', () => {
  it('create_is_disabled_and_reserved_before_send', async () => {
    const f = fixture(); const request = vi.mocked(f.manager.request); const original = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => {
      if (args[0] === 'cron.add') {
        const records = JSON.parse(fs.readFileSync(join(f.directory, 'journal.json'), 'utf8')).records;
        expect(records).toHaveLength(1); expect(records[0].state).toBe('uncertain');
        expect(args[1]).toEqual({ name: 'Synthetic', agentId: 'main', owner: { agentId: 'main' }, declarationKey: records[0].declarationKey,
          schedule: { kind: 'every', everyMs: 60000 }, sessionTarget: 'isolated', wakeMode: 'now', enabled: false, deleteAfterRun: false,
          payload: { kind: 'agentTurn', message: 'Synthetic prompt' }, delivery: { mode: 'none' }, failureAlert: false });
        expect(args[2]).toBeUndefined();
      }
      return original(...args);
    });
    const result = await submit(f); expect(result).toMatchObject({ state: 'confirmed', jobId: 'job-1' });
    expect(f.journal.list('main')[0].state).toBe('acknowledged');
    expect(fs.readFileSync(join(f.directory, 'journal.json'), 'utf8')).not.toContain('Synthetic prompt');
  });
  it('duplicate_operation_never_adds_twice', async () => {
    const f = fixture(); const confirmation = await f.service.prepare('main', intent); const input = { operationId: confirmation.operationId, intent };
    const results = await Promise.all([f.service.submit('main', input), f.service.submit('main', input), f.service.submit('main', input)]);
    expect(results.every(row => row.state === 'confirmed')).toBe(true);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60001); expect(await f.service.submit('main', input)).toEqual(results[0]);
    expect(vi.mocked(f.manager.request).mock.calls.filter(call => call[0] === 'cron.add')).toHaveLength(1);
    await expect(f.service.submit('main', { ...input, intent: { kind: 'create', draft: { ...draft, message: 'different' } } })).rejects.toMatchObject({ code: 'schedule-changed' });
  });
  it('existing_reservation_is_never_first_send_admission_even_without_local_dedup', async () => {
    const f = fixture(); const confirmation = await f.service.prepare('main', intent);
    const real = f.journal; f.replaceJournal({ ...real, reserve: async input => {
      await real.reserve(input); return real.reserve(input);
    } });
    expect(await f.service.submit('main', { operationId: confirmation.operationId, intent })).toMatchObject({ state: 'unknown' });
    expect(f.manager.request).not.toHaveBeenCalled();
  });
  it('new_operation_same_uncertain_digest_is_blocked', async () => {
    const f = fixture(); vi.mocked(f.manager.request).mockRejectedValueOnce(new GatewayRequestError('schedule-outcome-unknown'));
    expect(await submit(f)).toMatchObject({ state: 'unknown' });
    await expect(submit(f)).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(f.manager.request).toHaveBeenCalledTimes(1);
  });
  it.each(['invalid-request', 'schedule-denied', 'unavailable'] as const)('post_reservation_%s_is_conservative_and_never_releases_creation_for_replay', async code => {
    const f = fixture(); vi.mocked(f.manager.request).mockRejectedValueOnce(new GatewayRequestError(code));
    const confirmation = await f.service.prepare('main', intent); const input = { operationId: confirmation.operationId, intent };
    expect(await f.service.submit('main', input)).toMatchObject({ state: 'unknown' });
    expect(f.journal.list('main')[0].state).toBe('uncertain');
    const restarted = await f.restart();
    expect(await restarted.submit('main', input)).toMatchObject({ state: 'unknown' });
    const next = await restarted.prepare('main', intent);
    await expect(restarted.submit('main', { operationId: next.operationId, intent })).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(vi.mocked(f.manager.request).mock.calls.map(call => call[0])).toEqual(['cron.add']);
  });
  it('lost_add_reply_after_restart_is_reads_only', async () => {
    const f = fixture(); vi.mocked(f.manager.request).mockRejectedValueOnce(new GatewayRequestError('schedule-outcome-unknown'));
    const confirmation = await f.service.prepare('main', intent); const input = { operationId: confirmation.operationId, intent };
    expect(await f.service.submit('main', input)).toMatchObject({ state: 'unknown' });
    const restarted = await f.restart(); expect(await restarted.submit('main', input)).toMatchObject({ state: 'unknown' });
    vi.mocked(f.manager.request).mockImplementation(async method => method === 'cron.list'
      ? { jobs: [native(f.journal.list('main')[0].declarationKey)], snapshotRevision: 's1', total: 1, offset: 0, limit: 50, hasMore: false, nextOffset: null } : native());
    expect(await restarted.reconcile('main', confirmation.operationId)).toMatchObject({ state: 'observed', jobId: 'job-1' });
    expect(vi.mocked(f.manager.request).mock.calls.filter(call => call[0] === 'cron.add')).toHaveLength(1);
  });
  it('durable_acknowledgement_remains_confirmed_on_duplicate_submission_after_restart', async () => {
    const f = fixture(); const confirmation = await f.service.prepare('main', intent); const input = { operationId: confirmation.operationId, intent };
    expect(await f.service.submit('main', input)).toEqual({ operationId: input.operationId, agentId: 'main', action: 'create', state: 'confirmed', jobId: 'job-1' });
    const restarted = await f.restart();
    expect(await restarted.submit('main', input)).toEqual({ operationId: input.operationId, agentId: 'main', action: 'create', state: 'confirmed', jobId: 'job-1' });
    expect(vi.mocked(f.manager.request).mock.calls.map(call => call[0])).toEqual(['cron.add']);
    expect(f.journal.list('main')[0].state).toBe('acknowledged');
  });
  it('native_edit_race_returns_conflict_without_rebase', async () => {
    const f = fixture(); const edit: ScheduleIntent = { kind: 'edit', jobId: 'job-1', revision: 'revision-1', draft: { ...draft, name: 'Changed' } };
    const original = vi.mocked(f.manager.request).getMockImplementation()!;
    vi.mocked(f.manager.request).mockImplementation(async (...args) => {
      if (args[0] === 'cron.update') throw new GatewayRequestError('schedule-changed'); return original(...args);
    });
    await expect(submit(f, edit)).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(vi.mocked(f.manager.request).mock.calls.filter(call => call[0] === 'cron.update').map(call => call[1])).toEqual([
      { id: 'job-1', expectedConfigRevision: 'revision-1', patch: { name: 'Changed', payload: { kind: 'agentTurn', message: 'Synthetic prompt' }, schedule: { kind: 'every', everyMs: 60000 } } },
    ]);
  });
  it('enabled_patch_never_reconstructs_job', async () => {
    const f = fixture(); await submit(f); const result = await submit(f, { kind: 'enabled', jobId: 'job-1', revision: 'revision-1', enabled: false });
    expect(result.state).toBe('confirmed');
    const nativeMethods = vi.mocked(f.manager.request).mock.calls.map(call => call[0]);
    const updateParams = vi.mocked(f.manager.request).mock.calls.find(call => call[0] === 'cron.update')?.[1];
    expect(updateParams).toEqual({ id: 'job-1', expectedConfigRevision: 'revision-1', patch: { enabled: false } });
    expect(nativeMethods.filter(method => method === 'cron.add')).toHaveLength(1);
  });
  it('changed_declaration_is_not_restored', async () => {
    const f = fixture(); const operationId = randomUUID();
    const reserved = await f.journal.reserve({ operationId, agentId: 'main', requestDigest: scheduleCreateDigest('main', draft) });
    vi.mocked(f.manager.request).mockResolvedValue({ jobs: [{ ...native(reserved.declarationKey), name: 'Edited elsewhere', enabled: true }], snapshotRevision: 's', total: 1, offset: 0, limit: 50, hasMore: false, nextOffset: null });
    expect(await f.service.reconcile('main', operationId)).toMatchObject({ state: 'changed', jobId: 'job-1' });
    expect(f.journal.list('main')[0].state).toBe('changed');
    expect(vi.mocked(f.manager.request).mock.calls.map(call => call[0])).toEqual(['cron.list']);
  });
  it('crash_before_send_is_conservatively_unknown', async () => {
    const f = fixture(); const operationId = randomUUID(); await f.journal.reserve({ operationId, agentId: 'main', requestDigest: scheduleCreateDigest('main', draft) });
    const restarted = await f.restart(); expect(await restarted.submit('main', { operationId, intent })).toMatchObject({ state: 'unknown' });
    expect(await restarted.reconcile('main', operationId)).toMatchObject({ state: 'unknown', recovery: { scanned: 0, truncated: false } });
    expect(f.manager.request).toHaveBeenCalledTimes(1);
  });
  it.each(['reservation', 'fsync', 'post-commit'] as const)('journal_%s_failure_never_authorizes_replay', async failure => {
    const f = fixture();
    if (failure === 'reservation') f.replaceJournal({ ...f.journal, reserve: async () => { throw Error('private disk detail'); } });
    if (failure === 'fsync') vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw Error('private disk detail'); });
    if (failure === 'post-commit') f.replaceJournal({ ...f.journal, record: async () => { throw Error('private disk detail'); } });
    const confirmation = await f.service.prepare('main', intent); const input = { operationId: confirmation.operationId, intent };
    if (failure === 'post-commit') {
      expect(await f.service.submit('main', input)).toMatchObject({ state: 'unknown' });
      expect(await f.service.submit('main', input)).toMatchObject({ state: 'unknown' }); expect(f.manager.request).toHaveBeenCalledTimes(1);
    } else {
      await expect(f.service.submit('main', input)).rejects.toMatchObject({ code: 'schedule-storage-unavailable' }); expect(f.manager.request).not.toHaveBeenCalled();
    }
  });
  it.each(['expired', 'epoch', 'endpoint', 'device', 'agent', 'body', 'registry', 'permission', 'reader'] as const)('rejects_%s_changes_before_dispatch', async change => {
    const f = fixture(); const confirmation = await f.service.prepare('main', intent); let agentId = 'main'; let selected = intent;
    if (change === 'expired') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60001); }
    if (change === 'epoch') f.connection.epoch = 'epoch-2';
    if (change === 'endpoint') f.connection.gatewayUrl = 'ws://127.0.0.1:8/';
    if (change === 'device') f.connection.deviceId = 'different';
    if (change === 'agent') agentId = 'other';
    if (change === 'body') selected = { kind: 'create', draft: { ...draft, message: 'Changed' } };
    if (change === 'registry') f.registered.delete('main');
    if (change === 'permission') f.setManagement({ configured: true, state: 'ready', canManage: false, epoch: 'epoch-1', reason: 'permission' });
    if (change === 'reader') f.setReadable(false);
    await expect(f.service.submit(agentId, { operationId: confirmation.operationId, intent: selected })).rejects.toBeDefined();
    expect(f.manager.request).not.toHaveBeenCalled(); expect(f.journal.list('main')).toHaveLength(0);
  });
  it('checks_canonical_agent_before_creation_and_never_requires_creation_storage_for_updates', async () => {
    const f = fixture(); await expect(f.service.prepare('Upper', intent)).rejects.toMatchObject({ code: 'schedule-denied' });
    f.replaceJournal({ ...f.journal, reserve: async () => { throw Error('no storage'); } });
    expect(await submit(f, { kind: 'enabled', jobId: 'job-1', revision: 'revision-1', enabled: true })).toMatchObject({ state: 'confirmed' });
    expect(f.journal.list('main')).toHaveLength(0);
  });
  it.each(['owner', 'revision', 'unsupported'] as const)('fresh_preflight_refuses_%s_changes', async change => {
    const f = fixture(); const selected: ScheduleIntent = { kind: 'enabled', jobId: 'job-1', revision: 'revision-1', enabled: true };
    const confirmation = await f.service.prepare('main', selected);
    vi.mocked(f.manager.request).mockResolvedValue({ ...native(), ...(change === 'owner' ? { owner: { agentId: 'foreign' } }
      : change === 'revision' ? { configRevision: 'revision-2' } : { trigger: {} }) });
    await expect(f.service.submit('main', { operationId: confirmation.operationId, intent: selected })).rejects.toBeDefined();
    expect(vi.mocked(f.manager.request).mock.calls.every(call => call[0] === 'cron.get')).toBe(true);
  });
  it.each(['declarative', 'imperative', 'upsert', 'ambiguous', 'wrong-owner', 'enabled'] as const)('validates_%s_add_receipts_without_claiming_a_run', async envelope => {
    const f = fixture(); vi.mocked(f.manager.request).mockImplementation(async (_method, params) => {
      const job = { ...params, id: 'job-1', configRevision: 'r', state: {}, ...(envelope === 'wrong-owner' ? { owner: { agentId: 'other' } } : envelope === 'enabled' ? { enabled: true } : {}) };
      return envelope === 'imperative' ? { ...job, deliveryPreview: { label: 'None', detail: 'Synthetic' } }
        : envelope === 'ambiguous' ? { ok: true, job } : { created: envelope !== 'upsert', job };
    });
    expect((await submit(f)).state).toBe(['declarative', 'imperative'].includes(envelope) ? 'confirmed' : 'unknown');
  });
  it('reconciliation_continues_only_explicitly_and_is_bound_capped_and_read_only', async () => {
    const f = fixture(); const operationId = randomUUID(); await f.journal.reserve({ operationId, agentId: 'main', requestDigest: scheduleCreateDigest('main', draft) });
    vi.mocked(f.manager.request).mockImplementation(async (_method, params) => {
      const offset = params.offset as number; return { jobs: Array.from({ length: 50 }, (_, i) => ({ ...native(`foreign:${i + offset}`), id: `job-${i + offset}` })),
        snapshotRevision: 's1', total: 2050, offset, limit: 50, hasMore: true, nextOffset: offset + 50 };
    });
    let result = await f.service.reconcile('main', operationId); expect(result).toMatchObject({ state: 'unknown', recovery: { scanned: 200, truncated: true } });
    expect(f.manager.request).toHaveBeenCalledTimes(4); const first = result.recovery!.nextCursor!;
    await expect(f.service.reconcile('other', operationId, first)).rejects.toBeDefined();
    for (let i = 2; i <= 10; i++) { result = await f.service.reconcile('main', operationId, result.recovery!.nextCursor); expect(result.recovery?.scanned).toBe(i * 200); }
    expect(result.recovery).toEqual({ scanned: 2000, truncated: true });
    await expect(f.service.reconcile('main', operationId, first)).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(vi.mocked(f.manager.request).mock.calls.every(call => call[0] === 'cron.list' && call[1].limit === 50)).toBe(true);
  });
  it('reconciliation_rejects_changed_native_revisions_between_automatic_pages_before_observing_a_job', async () => {
    const f = fixture(); const operationId = randomUUID();
    const reserved = await f.journal.reserve({ operationId, agentId: 'main', requestDigest: scheduleCreateDigest('main', draft) });
    vi.mocked(f.manager.request).mockImplementation(async (_method, params) => {
      const offset = params.offset as number;
      return { jobs: Array.from({ length: 50 }, (_, i) => native(offset && i === 0 ? reserved.declarationKey : `other:${offset + i}`)),
        snapshotRevision: offset ? 'snapshot-2' : 'snapshot-1', total: 100, offset, limit: 50, hasMore: offset === 0, nextOffset: offset === 0 ? 50 : null };
    });
    await expect(f.service.reconcile('main', operationId)).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(f.journal.list('main')[0].state).toBe('uncertain');
    expect(vi.mocked(f.manager.request).mock.calls.map(call => call[1].offset)).toEqual([0, 50]);
    vi.mocked(f.manager.request).mockResolvedValue({ jobs: [native(reserved.declarationKey)], snapshotRevision: 'snapshot-2', total: 1, offset: 0, limit: 50, hasMore: false, nextOffset: null });
    expect(await f.service.reconcile('main', operationId)).toMatchObject({ state: 'observed', jobId: 'job-1', recovery: { scanned: 1, truncated: false } });
    expect(vi.mocked(f.manager.request).mock.calls.every(call => call[0] === 'cron.list')).toBe(true);
  });
  it.each([false, true])('reconciliation_cursor_retains_native_revision_and_rejects_changed_or_clamped_offsets (clamped: %s)', async clamped => {
    const f = fixture(); const operationId = randomUUID();
    await f.journal.reserve({ operationId, agentId: 'main', requestDigest: scheduleCreateDigest('main', draft) });
    vi.mocked(f.manager.request).mockImplementation(async (_method, params) => {
      const offset = params.offset as number;
      return { jobs: Array.from({ length: 50 }, (_, i) => native(`other:${offset + i}`)), snapshotRevision: 'snapshot-1', total: 250,
        offset, limit: 50, hasMore: offset < 200, nextOffset: offset < 200 ? offset + 50 : null };
    });
    const first = await f.service.reconcile('main', operationId); const cursor = first.recovery!.nextCursor!;
    expect(first.recovery).toMatchObject({ scanned: 200, truncated: true });
    vi.mocked(f.manager.request).mockResolvedValue(clamped
      ? { jobs: [], snapshotRevision: 'snapshot-2', total: 0, offset: 0, limit: 50, hasMore: false, nextOffset: null }
      : { jobs: Array.from({ length: 49 }, (_, i) => native(`remaining:${i}`)), snapshotRevision: 'snapshot-2', total: 249, offset: 200, limit: 50, hasMore: false, nextOffset: null });
    await expect(f.service.reconcile('main', operationId, cursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(f.journal.list('main')[0].state).toBe('uncertain');
    await expect(f.service.reconcile('main', operationId, cursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(vi.mocked(f.manager.request).mock.calls.map(call => call[1].offset)).toEqual([0, 50, 100, 150, 200]);
  });
  it('update_uncertainty_reconciles_without_creation_storage_or_replay', async () => {
    const f = fixture(); const selected: ScheduleIntent = { kind: 'enabled', jobId: 'job-1', revision: 'revision-1', enabled: true };
    const confirmation = await f.service.prepare('main', selected); const original = vi.mocked(f.manager.request).getMockImplementation()!;
    vi.mocked(f.manager.request).mockImplementation(async (...args) => { if (args[0] === 'cron.update') throw new GatewayRequestError('schedule-outcome-unknown'); return original(...args); });
    expect(await f.service.submit('main', { operationId: confirmation.operationId, intent: selected })).toMatchObject({ state: 'unknown' });
    f.replaceJournal({ ...f.journal, list() { throw Error('creation storage unavailable'); } });
    vi.mocked(f.manager.request).mockResolvedValue({ ...native(), enabled: true, configRevision: 'revision-2' });
    expect(await f.service.reconcile('main', confirmation.operationId)).toMatchObject({ state: 'observed', action: 'enabled', jobId: 'job-1' });
    vi.mocked(f.manager.request).mockResolvedValue({ ...native(), name: 'Edited independently', enabled: true, configRevision: 'revision-3' });
    expect(await f.service.reconcile('main', confirmation.operationId)).toMatchObject({ state: 'changed' });
    expect(vi.mocked(f.manager.request).mock.calls.filter(call => call[0] === 'cron.update')).toHaveLength(1);
  });
  it('fences_connection_changes_after_durable_reservation_without_discarding_uncertainty', async () => {
    const f = fixture(); const original = f.journal;
    f.replaceJournal({ ...original, reserve: async input => { const row = await original.reserve(input); f.connection.epoch = 'epoch-2'; return row; } });
    expect(await submit(f)).toMatchObject({ state: 'unknown' }); expect(f.manager.request).not.toHaveBeenCalled();
    expect(original.list('main')[0].state).toBe('uncertain');
  });
  it('bounds_tickets_and_mutations_per_agent_global_and_per_minute', async () => {
    const f = fixture(); const first = await f.service.prepare('main', intent);
    for (let i = 0; i < 100; i++) await f.service.prepare('main', intent);
    await expect(f.service.submit('main', { operationId: first.operationId, intent })).rejects.toMatchObject({ code: 'schedule-changed' });
    const confirmations = [];
    for (const agentId of ['main', 'other', 'three', 'four', 'five']) {
      f.registered.add(agentId); confirmations.push(await f.service.prepare(agentId, intent));
    }
    const settle: Array<(value: unknown) => void> = [];
    vi.mocked(f.manager.request).mockImplementation(() => new Promise(resolve => { settle.push(resolve); }));
    const pending = confirmations.slice(0, 4).map(row => f.service.submit(row.agentId, { operationId: row.operationId, intent }));
    await vi.waitFor(() => expect(settle).toHaveLength(4));
    await expect(f.service.submit('five', { operationId: confirmations[4].operationId, intent })).rejects.toMatchObject({ code: 'rate-limited' });
    const concurrent = await f.service.prepare('main', { kind: 'create', draft: { ...draft, name: 'Other' } });
    await expect(f.service.submit('main', { operationId: concurrent.operationId, intent: concurrent.intent })).rejects.toMatchObject({ code: 'rate-limited' });
    settle.forEach(resolve => resolve({})); await Promise.all(pending);
    const enabled: ScheduleIntent = { kind: 'enabled', jobId: 'job-1', revision: 'revision-1', enabled: false };
    vi.mocked(f.manager.request).mockResolvedValue(native());
    for (let i = 0; i < 6; i++) await submit(f, enabled);
    await expect(submit(f, enabled)).rejects.toMatchObject({ code: 'rate-limited' });
    expect(f.journal.list('main')).toHaveLength(1);
  });
  it('read_admission_and_cancellation_never_send_mutations', async () => {
    const f = fixture(); const settles: Array<(value: unknown) => void> = [];
    vi.mocked(f.manager.request).mockImplementation(() => new Promise(resolve => { settles.push(resolve); }));
    const selected: ScheduleIntent = { kind: 'enabled', jobId: 'job-1', revision: 'revision-1', enabled: true };
    const controller = new AbortController();
    const reads = Array.from({ length: 4 }, () => f.service.prepare('main', selected, controller.signal));
    const rejected = reads.map(promise => expect(promise).rejects.toBeDefined());
    await vi.waitFor(() => expect(settles).toHaveLength(4));
    await expect(f.service.prepare('main', selected)).rejects.toMatchObject({ code: 'rate-limited' });
    controller.abort(); settles.forEach(resolve => resolve(native())); await Promise.all(rejected);
    expect(vi.mocked(f.manager.request).mock.calls.every(call => call[0] === 'cron.get')).toBe(true);
  });
  it('reconciliation_rejects_malformed_pages_and_stale_or_exchanged_cursors', async () => {
    const f = fixture(); const operationId = randomUUID(); await f.journal.reserve({ operationId, agentId: 'main', requestDigest: scheduleCreateDigest('main', draft) });
    vi.mocked(f.manager.request).mockResolvedValue({ jobs: [], total: 0, offset: 0, limit: 50, hasMore: false, nextOffset: null, nativeSecret: 'never-forward' });
    await expect(f.service.reconcile('main', operationId)).rejects.toMatchObject({ code: 'invalid-source' });
    vi.mocked(f.manager.request).mockImplementation(async (_method, params) => {
      const offset = params.offset as number; return { jobs: Array.from({ length: 50 }, (_, i) => native(`other:${offset + i}`)), snapshotRevision: 's1', total: 250, offset, limit: 50, hasMore: offset < 200, nextOffset: offset < 200 ? offset + 50 : null };
    });
    const first = await f.service.reconcile('main', operationId); const cursor = first.recovery!.nextCursor;
    f.connection.deviceId = 'other-device'; await expect(f.service.reconcile('main', operationId, cursor)).rejects.toMatchObject({ code: 'schedule-changed' });
    f.connection.deviceId = 'synthetic-device'; vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60001);
    await expect(f.service.reconcile('main', operationId, cursor)).rejects.toMatchObject({ code: 'schedule-changed' });
  });
  it('minute_admission_is_atomic_across_different_agents', async () => {
    const f = fixture(); const selected: ScheduleIntent = { kind: 'enabled', jobId: 'job-1', revision: 'revision-1', enabled: false };
    for (let i = 0; i < 7; i++) await submit(f, selected);
    const inputs: ScheduleConfirmation[] = [];
    for (const agentId of ['one', 'two', 'three', 'four']) {
      f.registered.add(agentId);
      vi.mocked(f.manager.request).mockResolvedValue({ ...native(), agentId, effectiveAgentId: agentId, owner: { agentId } });
      inputs.push(await f.service.prepare(agentId, selected));
    }
    vi.mocked(f.manager.request).mockImplementation(async (_method, _params) => {
      const agentId = inputs.shift()?.agentId; return { ...native(), agentId, effectiveAgentId: agentId, owner: { agentId } };
    });
    const confirmations = [...inputs];
    const result = await Promise.allSettled(confirmations.map(row => f.service.submit(row.agentId, { operationId: row.operationId, intent: row.intent })));
    expect(result.filter(row => row.status === 'rejected' && row.reason?.code === 'rate-limited')).toHaveLength(1);
  });
  it('duplicate_status_reflects_explicit_reconciliation_not_a_cached_unknown', async () => {
    const f = fixture(); vi.mocked(f.manager.request).mockRejectedValueOnce(new GatewayRequestError('schedule-outcome-unknown'));
    const confirmation = await f.service.prepare('main', intent); const input = { operationId: confirmation.operationId, intent };
    await f.service.submit('main', input); const reserved = f.journal.list('main')[0];
    vi.mocked(f.manager.request).mockResolvedValue({ jobs: [native(reserved.declarationKey)], snapshotRevision: 's1', total: 1, offset: 0, limit: 50, hasMore: false, nextOffset: null });
    expect(await f.service.reconcile('main', confirmation.operationId)).toMatchObject({ state: 'observed' });
    expect(await f.service.submit('main', input)).toMatchObject({ state: 'observed' });
  });
  it('missing_create_owner_is_changed_not_an_exact_observation', async () => {
    const f = fixture(); const operationId = randomUUID();
    const reserved = await f.journal.reserve({ operationId, agentId: 'main', requestDigest: scheduleCreateDigest('main', draft) });
    const { owner: _owner, ...job } = native(reserved.declarationKey) as Record<string, unknown>;
    vi.mocked(f.manager.request).mockResolvedValue({ jobs: [job], snapshotRevision: 's1', total: 1, offset: 0, limit: 50, hasMore: false, nextOffset: null });
    expect(await f.service.reconcile('main', operationId)).toMatchObject({ state: 'changed' });
  });
  it('failed_reconciliation_metadata_write_preserves_persistent_uncertainty', async () => {
    const f = fixture(); const operationId = randomUUID();
    const reserved = await f.journal.reserve({ operationId, agentId: 'main', requestDigest: scheduleCreateDigest('main', draft) });
    f.replaceJournal({ ...f.journal, record: async () => { throw Error('synthetic durability failure'); } });
    vi.mocked(f.manager.request).mockResolvedValue({ jobs: [native(reserved.declarationKey)], snapshotRevision: 's1', total: 1, offset: 0, limit: 50, hasMore: false, nextOffset: null });
    expect(await f.service.reconcile('main', operationId)).toMatchObject({ state: 'unknown', jobId: 'job-1' });
    expect(f.journal.list('main')[0].state).toBe('uncertain');
    expect(JSON.parse(fs.readFileSync(join(f.directory, 'journal.json'), 'utf8')).records[0].state).toBe('uncertain');
  });
  it('resolved_updates_retire_without_a_permanent_500_operation_admission_limit_or_replay', async () => {
    const f = fixture(); vi.useFakeTimers(); const start = Date.now();
    const enabled: ScheduleIntent = { kind: 'enabled', jobId: 'job-1', revision: 'revision-1', enabled: false };
    const first = await f.service.prepare('main', enabled); const input = { operationId: first.operationId, intent: first.intent };
    expect((await f.service.submit('main', input)).state).toBe('confirmed');
    for (let i = 1; i <= 500; i++) {
      vi.setSystemTime(start + i * 60001); expect((await submit(f, enabled)).state).toBe('confirmed');
    }
    expect(f.journal.list('main')).toHaveLength(0);
    await expect(f.service.submit('main', input)).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(vi.mocked(f.manager.request).mock.calls.filter(call => call[0] === 'cron.update')).toHaveLength(501);
  });
  it.each([false, true])('500_accumulated_create_attempts_do_not_block_safe_updates_or_allow_old_add_replay (uncertain: %s)', async uncertain => {
    const f = fixture(); vi.useFakeTimers(); const start = Date.now(); let first!: ScheduleConfirmation;
    const original = vi.mocked(f.manager.request).getMockImplementation()!;
    if (uncertain) vi.mocked(f.manager.request).mockImplementation(async (...args) => {
      if (args[0] === 'cron.add') throw new GatewayRequestError('schedule-outcome-unknown'); return original(...args);
    });
    for (let i = 0; i < 500; i++) {
      vi.setSystemTime(start + i * 60001);
      const confirmation = await f.service.prepare('main', { kind: 'create', draft: { ...draft, name: `Synthetic ${i}` } });
      if (!i) first = confirmation;
      expect((await f.service.submit('main', { operationId: confirmation.operationId, intent: confirmation.intent })).state).toBe(uncertain ? 'unknown' : 'confirmed');
    }
    vi.setSystemTime(start + 500 * 60001);
    expect((await submit(f, { kind: 'enabled', jobId: 'job-1', revision: 'revision-1', enabled: true })).state).toBe('confirmed');
    expect(f.journal.list('main')).toHaveLength(500);
    expect(await f.service.submit('main', { operationId: first.operationId, intent: first.intent })).toMatchObject({ state: uncertain ? 'unknown' : 'confirmed' });
    expect(vi.mocked(f.manager.request).mock.calls.filter(call => call[0] === 'cron.add')).toHaveLength(500);
  });
  it('retains_unknown_update_recovery_at_capacity_and_admits_new_work_after_explicit_resolution', async () => {
    const f = fixture(); vi.useFakeTimers(); const start = Date.now(); const inputs: ScheduleConfirmation[] = [];
    const original = vi.mocked(f.manager.request).getMockImplementation()!;
    vi.mocked(f.manager.request).mockImplementation(async (...args) => {
      if (args[0] === 'cron.update') throw new GatewayRequestError('schedule-outcome-unknown'); return original(...args);
    });
    const enabled: ScheduleIntent = { kind: 'enabled', jobId: 'job-1', revision: 'revision-1', enabled: false };
    for (let i = 0; i < 500; i++) {
      vi.setSystemTime(start + i * 60001); const confirmation = await f.service.prepare('main', enabled); inputs.push(confirmation);
      expect((await f.service.submit('main', { operationId: confirmation.operationId, intent: enabled })).state).toBe('unknown');
    }
    vi.setSystemTime(start + 500 * 60001);
    await expect(submit(f, enabled)).rejects.toMatchObject({ code: 'rate-limited' });
    expect((await f.service.submit('main', { operationId: inputs[1].operationId, intent: enabled })).state).toBe('unknown');
    expect((await f.service.reconcile('main', inputs[0].operationId)).state).toBe('observed');
    vi.mocked(f.manager.request).mockImplementation(original); expect((await submit(f, enabled)).state).toBe('confirmed');
    expect(vi.mocked(f.manager.request).mock.calls.filter(call => call[0] === 'cron.update')).toHaveLength(501);
  });
  it('delayed_add_receipt_cannot_overwrite_a_newer_independent_edit_observed_by_reconciliation', async () => {
    const f = fixture(); let release!: () => void; let current: Record<string, unknown>;
    vi.mocked(f.manager.request).mockImplementation(async (method, params) => {
      if (method === 'cron.add') {
        const receipt = { created: true, job: { ...params, id: 'job-1', configRevision: 'revision-1', state: {} } };
        current = { ...receipt.job, name: 'Changed independently', enabled: true, configRevision: 'revision-2' };
        return new Promise(resolve => { release = () => resolve(receipt); });
      }
      if (method === 'cron.get') return current;
      return { jobs: [current], snapshotRevision: 'snapshot-2', total: 1, offset: 0, limit: 50, hasMore: false, nextOffset: null };
    });
    const confirmation = await f.service.prepare('main', intent); const input = { operationId: confirmation.operationId, intent };
    const submitted = f.service.submit('main', input); await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
    const reconciled = f.service.reconcile('main', confirmation.operationId); setTimeout(() => release(), 0);
    const [, result] = await Promise.all([submitted, reconciled]);
    expect(result).toMatchObject({ state: 'changed', jobId: 'job-1' });
    expect(f.journal.list('main')[0].state).toBe('changed');
    expect((await f.service.submit('main', input)).state).toBe('changed');
    await expect(submit(f)).rejects.toMatchObject({ code: 'schedule-changed' });
    expect(vi.mocked(f.manager.request).mock.calls.filter(call => call[0] === 'cron.add')).toHaveLength(1);
  });
  it('cancelling_a_reconciliation_wait_uses_no_read_lease_and_does_not_cancel_admitted_creation', async () => {
    let leases = 0; const f = fixture(() => { leases++; return () => { leases--; }; }); let release!: () => void;
    vi.mocked(f.manager.request).mockImplementation(async (_method, params) => new Promise(resolve => {
      release = () => resolve({ created: true, job: { ...params, id: 'job-1', configRevision: 'revision-1', state: {} } });
    }));
    const confirmation = await f.service.prepare('main', intent);
    const admitted = f.service.submit('main', { operationId: confirmation.operationId, intent });
    await vi.waitFor(() => expect(release).toEqual(expect.any(Function))); const controller = new AbortController();
    try {
      const reconciliation = f.service.reconcile('main', confirmation.operationId, undefined, controller.signal);
      expect(leases).toBe(0); controller.abort();
      await expect(reconciliation).rejects.toMatchObject({ code: 'unavailable' });
      expect(vi.mocked(f.manager.request).mock.calls.map(call => call[0])).toEqual(['cron.add']);
      expect(vi.mocked(f.manager.request).mock.calls[0][2]).toBeUndefined();
    } finally { release(); }
    expect((await admitted).state).toBe('confirmed'); expect(leases).toBe(0);
    expect(f.journal.list('main')[0].state).toBe('acknowledged');
  });
  it('bounds_and_cancels_dispatch_waiters_on_close_without_native_replay_or_read_lease_deadlock', async () => {
    let leases = 0; const f = fixture(() => { leases++; return () => { leases--; }; }); let release!: () => void;
    vi.mocked(f.manager.request).mockImplementation(async (_method, params) => new Promise(resolve => {
      release = () => resolve({ created: true, job: { ...params, id: 'job-1', configRevision: 'revision-1', state: {} } });
    }));
    const confirmation = await f.service.prepare('main', intent);
    const admitted = f.service.submit('main', { operationId: confirmation.operationId, intent });
    await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
    const rejections = Array.from({ length: 4 }, () => expect(f.service.reconcile('main', confirmation.operationId)).rejects.toMatchObject({ code: 'unavailable' }));
    try {
      await expect(f.service.reconcile('main', confirmation.operationId)).rejects.toMatchObject({ code: 'rate-limited' });
      expect(leases).toBe(0); const closing = f.service.close(); await Promise.all(rejections);
      release(); await closing; expect((await admitted).state).toBe('unknown');
      expect(f.journal.list('main')[0].state).toBe('uncertain');
    } finally { release(); }
    expect(vi.mocked(f.manager.request).mock.calls.map(call => call[0])).toEqual(['cron.add']); expect(leases).toBe(0);
  });
  it('a_dispatch_wait_deadline_never_retries_or_cancels_the_admitted_native_add', async () => {
    const f = fixture(); let release!: () => void;
    vi.mocked(f.manager.request).mockImplementation(async (_method, params) => new Promise(resolve => {
      release = () => resolve({ created: true, job: { ...params, id: 'job-1', configRevision: 'revision-1', state: {} } });
    }));
    const confirmation = await f.service.prepare('main', intent);
    const admitted = f.service.submit('main', { operationId: confirmation.operationId, intent });
    await vi.waitFor(() => expect(release).toEqual(expect.any(Function))); vi.useFakeTimers();
    const rejected = expect(f.service.reconcile('main', confirmation.operationId)).rejects.toMatchObject({ code: 'unavailable' });
    try { await vi.advanceTimersByTimeAsync(5001); await rejected; }
    finally { release(); }
    expect((await admitted).state).toBe('confirmed'); expect(f.manager.request).toHaveBeenCalledTimes(1);
  });
});
