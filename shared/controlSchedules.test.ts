import { describe, expect, it } from 'vitest';
import {
  parseScheduleConfirmation, parseScheduleDraft, parseScheduleIntent, parseScheduleOperation,
  parseScheduleSnapshot, parseScheduleSubmit, parseScheduleOperationsPage,
} from './controlSchedules';

const operationId = '9c17ed7a-3ed6-4e8b-bec9-f65c2636857d';
const draft = { name: 'Daily', message: 'First line\nSecond line', schedule: { kind: 'every', everyMs: 60000 } };
const intent = { kind: 'create', draft };
const row = { id: 'native-job', agentId: 'custom-id', name: 'Daily', enabled: false, revision: 'opaque:1', scheduleKind: 'every', draft, readOnlyReason: null };
const operation = { operationId, agentId: 'custom-id', action: 'create', state: 'confirmed' };
const snapshot = {
  agentId: 'custom-id', source: { state: 'current', observedAt: 1700000000000 },
  management: { configured: true, state: 'ready', canManage: true, epoch: 'connection-1', reason: null },
  jobs: [row], operations: [operation], scanned: 1, truncated: false,
};

describe('closed private scheduling contract', () => {
  it('rejects_multibyte_prompt_over_16384_bytes', () => {
    expect(parseScheduleDraft({ name: 'Daily', message: '😀'.repeat(4096), schedule: { kind: 'every', everyMs: 60000 } })).not.toBeNull();
    expect(parseScheduleDraft({ name: 'Daily', message: '😀'.repeat(4097), schedule: { kind: 'every', everyMs: 60000 } })).toBeNull();
  });
  it('accepts_60000_and_31536000000_interval_bounds', () => {
    for (const everyMs of [60000, 31536000000]) expect(parseScheduleDraft({ ...draft, schedule: { kind: 'every', everyMs } })).not.toBeNull();
    for (const everyMs of [59999, 31536000001, 60000.5, Infinity, NaN, '60000']) expect(parseScheduleDraft({ ...draft, schedule: { kind: 'every', everyMs } })).toBeNull();
  });
  it('requires_five_fields_and_explicit_IANA_zone', () => {
    for (const tz of ['UTC', 'Europe/Berlin', 'America/New_York']) {
      expect(parseScheduleDraft({ ...draft, schedule: { kind: 'cron', expr: '0 9 * * *', tz } })).not.toBeNull();
    }
    for (const schedule of [
      { kind: 'cron', expr: '0 9 * * *' }, { kind: 'cron', expr: '0 0 9 * * *', tz: 'UTC' },
      { kind: 'cron', expr: '0 9 * * *', tz: '+01:00' }, { kind: 'cron', expr: '0 9 * * *', tz: 'Not/A_Zone' },
      { kind: 'cron', expr: '*'.repeat(125) + ' * * * *', tz: 'UTC' },
      { kind: 'cron', expr: '0\n9 * * *', tz: 'UTC' },
    ]) expect(parseScheduleDraft({ ...draft, schedule })).toBeNull();
  });
  it('bounds names without altering intentional message whitespace', () => {
    expect(parseScheduleDraft({ ...draft, name: 'x'.repeat(128) })).not.toBeNull();
    expect(parseScheduleDraft({ ...draft, name: 'x'.repeat(129) })).toBeNull();
    expect(parseScheduleDraft({ ...draft, name: ' Daily ', message: '  first\nlast  ' })).toEqual({ ...draft, name: 'Daily', message: '  first\nlast  ' });
    for (const name of ['', '   ', '\ud800', 'bad\u0000name', 'bad\u0085name']) expect(parseScheduleDraft({ ...draft, name })).toBeNull();
    for (const message of ['', '\n\t ', '\udfff', 'bad\u0000message', 'bad\u007fmessage']) expect(parseScheduleDraft({ ...draft, message })).toBeNull();
  });
  it('rejects native fields, prototype keys, arrays and non-plain records at every browser boundary', () => {
    for (const extra of [{ agentId: 'other' }, { payload: { kind: 'script' } }, { enabled: true }, JSON.parse('{"__proto__":{}}'), { constructor: 'bad' }]) {
      expect(parseScheduleDraft({ ...draft, ...extra })).toBeNull();
    }
    expect(parseScheduleDraft(Object.assign(Object.create({}), draft))).toBeNull();
    expect(parseScheduleDraft([])).toBeNull();
    expect(parseScheduleDraft({ ...draft, schedule: { ...draft.schedule, anchorMs: 1 } })).toBeNull();
    expect(parseScheduleIntent({ ...intent, native: true })).toBeNull();
    expect(parseScheduleSubmit({ operationId, intent, agentId: 'other' })).toBeNull();
  });
  it('bounds opaque job identities and revisions and never normalizes them', () => {
    expect(parseScheduleIntent({ kind: 'edit', jobId: 'x'.repeat(200), revision: 'r'.repeat(128), draft })).not.toBeNull();
    for (const jobId of ['x'.repeat(201), '', ' ', 'bad\n', '\ud800']) expect(parseScheduleIntent({ kind: 'edit', jobId, revision: 'r', draft })).toBeNull();
    for (const revision of ['r'.repeat(129), '', ' ', '\ud800', 'r\u0000']) expect(parseScheduleIntent({ kind: 'enabled', jobId: 'job', revision, enabled: true })).toBeNull();
    expect(parseScheduleIntent({ kind: 'enabled', jobId: ' Job ', revision: 'revision', enabled: false })).toEqual({ kind: 'enabled', jobId: ' Job ', revision: 'revision', enabled: false });
    expect(parseScheduleIntent({ kind: 'enabled', jobId: 'job', revision: 'r', enabled: 'false' })).toBeNull();
  });
  it('requires server UUIDs, bounded epochs/timestamps and explicit confirmation enabled state', () => {
    const confirmation = { operationId, agentId: 'custom-id', intent, expiresAt: 1700000060000, epoch: 'e1', currentEnabled: null };
    expect(parseScheduleConfirmation(confirmation)).toEqual(confirmation);
    expect(parseScheduleSubmit({ operationId, intent })).toEqual({ operationId, intent });
    for (const extra of [{ operationId: 'browser-id' }, { epoch: 'e'.repeat(129) }, { expiresAt: Infinity }, { expiresAt: -1 }, { expiresAt: 1.5 }, { currentEnabled: undefined }, { native: {} }]) {
      expect(parseScheduleConfirmation({ ...confirmation, ...extra })).toBeNull();
    }
  });
  it('parses operation states without implying task completion', () => {
    for (const state of ['confirmed', 'observed', 'changed', 'unknown', 'not-sent']) expect(parseScheduleOperation({ ...operation, state, jobId: 'job' })).not.toBeNull();
    for (const extra of [{ state: 'completed' }, { action: 'delete' }, { message: 'private' }, { operationId: 'arbitrary' }]) expect(parseScheduleOperation({ ...operation, ...extra })).toBeNull();
  });
  it('separates_closed_bounded_recovery_pages_from_native_continuation', () => {
    const page = { agentId: 'custom-id', operations: [operation], nextCursor: 'opaque-recovery' };
    expect(parseScheduleOperationsPage(page)).toEqual(page);
    expect(parseScheduleOperationsPage({ ...page, operations: Array(50).fill(operation) })).not.toBeNull();
    for (const extra of [{ agentId: '' }, { operations: Array(51).fill(operation) }, { operations: [{ ...operation, agentId: 'foreign' }] },
      { operations: [] }, { nextCursor: '' }, { nextCursor: 'x'.repeat(2049) }, { cursor: 'other' }, { declarationKey: 'private' }, JSON.parse('{"__proto__":{}}')]) {
      expect(parseScheduleOperationsPage({ ...page, ...extra })).toBeNull();
    }
    expect(parseScheduleOperationsPage({ agentId: 'custom-id', operations: [] })).toEqual({ agentId: 'custom-id', operations: [] });
    expect(parseScheduleSnapshot({ ...snapshot, operationsCursor: 'opaque-recovery', nextCursor: 'opaque-native' })).not.toBeNull();
    expect(parseScheduleSnapshot({ ...snapshot, operations: Array(50).fill(operation), operationsCursor: 'opaque-recovery' })).not.toBeNull();
    for (const extra of [{ operations: Array(51).fill(operation) }, { operations: [], operationsCursor: 'opaque-recovery' }, { operationsCursor: '' }, { operationsCursor: 'x'.repeat(2049) }]) {
      expect(parseScheduleSnapshot({ ...snapshot, ...extra })).toBeNull();
    }
  });
  it('accepts absent next-run facts and projects only closed bounded DTOs', () => {
    expect(parseScheduleSnapshot(snapshot)).toEqual(snapshot);
    expect(parseScheduleSnapshot({ ...snapshot, jobs: [{ ...row, timingMetadata: { anchorMs: 0 }, lastRunStatus: 'skipped' }] })).not.toBeNull();
    for (const extra of [{ nextRunAt: -1 }, { lastRunStatus: 'success' }, { readOnlyReason: 'arbitrary' }, { payload: { message: 'native' } }, { revision: 'r'.repeat(129) }, { timingMetadata: { staggerMs: -1 } }]) {
      expect(parseScheduleSnapshot({ ...snapshot, jobs: [{ ...row, ...extra }] })).toBeNull();
    }
    for (const extra of [{ reason: 'arbitrary' }, { state: 'unavailable' }, { configured: false }, { epoch: null }, { reason: 'disabled' }, { native: true }]) {
      expect(parseScheduleSnapshot({ ...snapshot, management: { ...snapshot.management, ...extra } })).toBeNull();
    }
    expect(parseScheduleSnapshot({ ...snapshot, source: { ...snapshot.source, native: true } })).toBeNull();
    expect(parseScheduleSnapshot({ ...snapshot, jobs: [{ ...row, agentId: 'foreign' }] })).toBeNull();
    expect(parseScheduleSnapshot({ ...snapshot, operations: [{ ...operation, agentId: 'foreign' }] })).toBeNull();
  });
  it('enforces the 256 KiB ceiling, cursor and browse/operation bounds', () => {
    expect(parseScheduleSnapshot({ ...snapshot, nextCursor: 'c'.repeat(2048) })).not.toBeNull();
    expect(parseScheduleSnapshot({ ...snapshot, nextCursor: 'c'.repeat(2049) })).toBeNull();
    expect(parseScheduleSnapshot({ ...snapshot, scanned: 2001 })).toBeNull();
    expect(parseScheduleSnapshot({ ...snapshot, operations: Array(501).fill(operation) })).toBeNull();
    expect(parseScheduleSnapshot({ ...snapshot, jobs: Array(20).fill({ ...row, draft: { ...draft, message: 'x'.repeat(16384) } }) })).toBeNull();
    expect(parseScheduleSnapshot({ ...snapshot, jobs: [{ ...row, draft: null, revision: null, readOnlyReason: 'revision-unavailable' }] })).not.toBeNull();
    expect(parseScheduleSnapshot({ ...snapshot, jobs: [{ ...row, draft: null }] })).toBeNull();
  });
});
