import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ScheduleDraft } from '../../shared/controlSchedules';
import { buildScheduleCreate, buildScheduleUpdate, isCanonicalScheduleAgentId, projectScheduleJob, scheduleCreateDigest } from './scheduleProjection';

const draft: ScheduleDraft = { name: 'Daily', message: 'Synthetic private prompt\nSecond line', schedule: { kind: 'every', everyMs: 60000 } };
// Synthetic cron.get/read-view shape from the inspected 2026.10.3 native schema.
function native(overrides: Record<string, unknown> = {}) {
  return {
    id: 'native-job', declarationKey: 'pixel-agents:synthetic-uuid', agentId: 'custom-id', effectiveAgentId: 'custom-id', owner: { agentId: 'custom-id' },
    name: draft.name, enabled: false, deleteAfterRun: false, createdAtMs: 1700000000000, updatedAtMs: 1700000000000,
    configRevision: 'opaque-revision:1', schedule: { kind: 'every', everyMs: 60000, anchorMs: 1700000000000 },
    sessionTarget: 'isolated', wakeMode: 'now', payload: { kind: 'agentTurn', message: draft.message },
    delivery: { mode: 'none' }, failureAlert: false, state: {}, ...overrides,
  };
}

describe('native scheduling projection', () => {
  it('never_retargets_uppercase_roster_ids', () => {
    const roster = Object.freeze([{ id: 'Custom' }, { id: 'custom-id' }]);
    expect(isCanonicalScheduleAgentId('Custom')).toBe(false);
    expect(isCanonicalScheduleAgentId('custom-id')).toBe(true);
    for (const id of [' custom-id', 'custom-id ', '-custom', 'x'.repeat(65), '']) expect(isCanonicalScheduleAgentId(id)).toBe(false);
    expect(projectScheduleJob(native({ agentId: 'Custom', owner: { agentId: 'Custom' }, effectiveAgentId: 'Custom' }), roster[0].id)).toBeNull();
    expect(() => buildScheduleCreate('Custom', 'pixel-agents:fixture', draft)).toThrow();
    expect(roster.map(agent => agent.id)).toEqual(['Custom', 'custom-id']);
  });
  it('omits_foreign_and_contradictory_owners', () => {
    for (const extra of [
      { agentId: 'foreign' }, { agentId: undefined }, { effectiveAgentId: 'foreign' },
      { owner: { agentId: 'foreign' } }, { owner: {} }, { owner: null },
      { owner: { agentId: 'custom-id', sessionKey: 'session' } }, { owner: { agentId: 'custom-id', accountId: 'account' } },
      { sessionKey: 'session' }, { accountId: 'account' }, { owner: { agentId: 'custom-id', unknownOwner: true } },
    ]) expect(projectScheduleJob(native(extra), 'custom-id')).toBeNull();
    const withoutOwner = native(); delete (withoutOwner as Record<string, unknown>).owner;
    expect(projectScheduleJob(withoutOwner, 'custom-id')?.readOnlyReason).toBeNull();
  });
  it('keeps_reserved_and_execution_override_jobs_readonly', () => {
    for (const prefix of ['heartbeat-task:', 'heartbeat:', 'skill-collection-review:']) {
      expect(projectScheduleJob(native({ declarationKey: prefix + 'fixture' }), 'custom-id')).toMatchObject({ draft: null, readOnlyReason: 'system-owned' });
    }
    for (const extra of [
      { trigger: { script: 'secret script' } }, { pacing: { min: '1m' } }, { unknownExecution: true },
      { scheduledToolPolicy: { version: 1, mode: 'trusted' } }, { sessionTarget: 'main' }, { wakeMode: 'next-heartbeat' },
      { payload: { kind: 'agentTurn', message: 'secret', model: 'override' } },
      { payload: { kind: 'script', script: 'secret script' } }, { deleteAfterRun: true },
      { delivery: undefined }, { delivery: { mode: 'none', failureDestination: { to: 'external' } } },
      { failureAlert: undefined }, { failureAlert: { after: 1 } }, { schedule: { kind: 'at', at: '2030-01-01' } },
      { schedule: { kind: 'every', everyMs: 60000, futureOption: true } },
      { state: { unknownExecution: true } }, { state: [] },
    ]) {
      const row = projectScheduleJob(native(extra), 'custom-id');
      expect(row).toMatchObject({ draft: null, readOnlyReason: 'unsupported-definition' });
      expect(JSON.stringify(row)).not.toMatch(/secret|script|override|external/);
    }
  });
  it.each([
    [{ kind: 'every', everyMs: 60000, anchorMs: 1700000000000 }, { anchorMs: 1700000000000 }, draft.schedule],
    [{ kind: 'cron', expr: '0 9 * * *', tz: 'Europe/Berlin', staggerMs: 300000 }, { staggerMs: 300000 }, { kind: 'cron', expr: '0 9 * * *', tz: 'Europe/Berlin' }],
  ])('native_normalized_create_remains_manageable (%j)', (schedule, timingMetadata, editableSchedule) => {
    const job = native({ schedule }); const before = structuredClone(job);
    expect(projectScheduleJob(job, 'custom-id')).toEqual({
      id: 'native-job', agentId: 'custom-id', name: 'Daily', enabled: false, revision: 'opaque-revision:1',
      scheduleKind: schedule.kind, draft: { ...draft, schedule: editableSchedule }, readOnlyReason: null, timingMetadata,
    });
    expect(job).toEqual(before);
  });
  it('rejects malformed identities and keeps missing or unsupported revisions read-only', () => {
    expect(projectScheduleJob(native({ id: 'x'.repeat(200) }), 'custom-id')).not.toBeNull();
    for (const id of ['x'.repeat(201), '\ud800', 'bad\n', ' ']) expect(projectScheduleJob(native({ id }), 'custom-id')).toBeNull();
    expect(projectScheduleJob(native({ configRevision: 'r'.repeat(128) }), 'custom-id')?.readOnlyReason).toBeNull();
    for (const configRevision of [undefined, null, 1, '', 'r'.repeat(129), '\ud800']) {
      expect(projectScheduleJob(native({ configRevision }), 'custom-id')).toMatchObject({ revision: null, draft: null, readOnlyReason: 'revision-unavailable' });
    }
    expect(projectScheduleJob(native({ name: 'x'.repeat(128) }), 'custom-id')?.readOnlyReason).toBeNull();
    expect(projectScheduleJob(native({ name: 'x'.repeat(129) }), 'custom-id')?.readOnlyReason).toBe('bounds');
    expect(projectScheduleJob(native({ payload: { kind: 'agentTurn', message: '😀'.repeat(4097) } }), 'custom-id')).toMatchObject({ draft: null, readOnlyReason: 'bounds' });
  });
  it('never forwards malformed metadata, unsafe prototype keys or invented run facts', () => {
    expect(projectScheduleJob(native(), 'custom-id')).not.toHaveProperty('nextRunAt');
    const row = projectScheduleJob(native({ nextRunAtMs: 1700000060000, lastRunAtMs: 1700000000000, lastRunStatus: 'ok', lastRunError: 'secret error', state: { lastError: 'state-only-private' } }), 'custom-id');
    expect(row).toMatchObject({ nextRunAt: 1700000060000, lastRunAt: 1700000000000, lastRunStatus: 'ok' });
    expect(JSON.stringify(row)).not.toMatch(/secret error|state-only-private|"lastRunError"|"state"/);
    for (const anchorMs of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
      expect(projectScheduleJob(native({ schedule: { kind: 'every', everyMs: 60000, anchorMs } }), 'custom-id')?.readOnlyReason).toBe('unsupported-definition');
    }
    expect(projectScheduleJob(native({ ...JSON.parse('{"__proto__":{}}') }), 'custom-id')).toBeNull();
    expect(projectScheduleJob(native({ payload: JSON.parse('{"kind":"agentTurn","message":"text","constructor":{}}') }), 'custom-id')?.readOnlyReason).toBe('unsupported-definition');
  });
  it('constructs forced-disabled no-announcement requests and canonical digests', () => {
    expect(buildScheduleCreate('custom-id', 'pixel-agents:fixture', draft)).toEqual({
      name: 'Daily', agentId: 'custom-id', owner: { agentId: 'custom-id' }, declarationKey: 'pixel-agents:fixture',
      schedule: { kind: 'every', everyMs: 60000 }, sessionTarget: 'isolated', wakeMode: 'now', enabled: false,
      deleteAfterRun: false, payload: { kind: 'agentTurn', message: draft.message }, delivery: { mode: 'none' }, failureAlert: false,
    });
    const reordered: ScheduleDraft = { schedule: { everyMs: 60000, kind: 'every' }, message: draft.message, name: 'Daily' };
    expect(scheduleCreateDigest('custom-id', draft)).toBe(scheduleCreateDigest('custom-id', reordered));
    expect(scheduleCreateDigest('custom-id', draft)).toBe(createHash('sha256').update(JSON.stringify({ agentId: 'custom-id', name: 'Daily', message: draft.message, schedule: { kind: 'every', everyMs: 60000 } })).digest('hex'));
    expect(scheduleCreateDigest('other', draft)).not.toBe(scheduleCreateDigest('custom-id', draft));
    expect(() => buildScheduleCreate('custom-id', 'x'.repeat(201), draft)).toThrow();
    expect(() => buildScheduleCreate('custom-id', 'heartbeat:fixture', draft)).toThrow();
  });
  it('uses revision-guarded narrow patches preserving native normalization and metadata', () => {
    expect(buildScheduleUpdate({ kind: 'edit', jobId: 'native-job', revision: 'reviewed:1', draft })).toEqual({
      id: 'native-job', expectedConfigRevision: 'reviewed:1',
      patch: { name: 'Daily', payload: { kind: 'agentTurn', message: draft.message }, schedule: { kind: 'every', everyMs: 60000 } },
    });
    for (const enabled of [false, true]) expect(buildScheduleUpdate({ kind: 'enabled', jobId: 'native-job', revision: 'reviewed:1', enabled })).toEqual({ id: 'native-job', expectedConfigRevision: 'reviewed:1', patch: { enabled } });
    const cron: ScheduleDraft = { ...draft, schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' } };
    const patch = buildScheduleUpdate({ kind: 'edit', jobId: 'job', revision: 'r', draft: cron }).patch;
    expect(patch).toEqual({ name: 'Daily', payload: { kind: 'agentTurn', message: draft.message }, schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' } });
    // The native patch owns interval reanchoring and preservation of unchanged cron stagger.
    expect(JSON.stringify(patch)).not.toMatch(/anchorMs|staggerMs|description|enabled|owner|delivery|failureAlert/);
  });
});
