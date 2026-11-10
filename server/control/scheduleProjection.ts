import { createHash } from 'node:crypto';
import { CONTROL_LIMITS, controlByteSize, controlRecord } from '../../shared/control';
import { parseScheduleDraft, parseScheduleIntent, type ScheduleDraft, type ScheduleIntent, type ScheduleRow } from '../../shared/controlSchedules';
import { ControlError } from './errors';

const reservedDeclarations = ['heartbeat-task:', 'heartbeat:', 'skill-collection-review:'];
const knownJobFields = new Set([
  'id', 'declarationKey', 'displayName', 'owner', 'agentId', 'effectiveAgentId', 'name', 'description', 'enabled',
  'deleteAfterRun', 'createdAtMs', 'updatedAtMs', 'configRevision', 'schedule', 'sessionTarget', 'wakeMode',
  'payload', 'delivery', 'failureAlert', 'state', 'nextRunAtMs', 'lastRunAtMs', 'lastRunStatus', 'lastRunError',
  'lastDelivered', 'lastDeliveryStatus', 'lastDeliveryError', 'deliverySuppressionReason',
  'lastFailureNotificationDelivered', 'lastFailureNotificationDeliveryStatus', 'lastFailureNotificationDeliveryError',
  'deliveryPreview',
]);
const knownStateFields = [
  'nextRunAtMs', 'scheduleActivatedAtMs', 'runningAtMs', 'lastRunAtMs', 'lastRunStatus', 'lastStatus',
  'lastError', 'lastDiagnostics', 'lastDiagnosticSummary', 'lastErrorReason', 'lastDurationMs',
  'consecutiveErrors', 'scheduleErrorCount', 'autoDisabled', 'consecutiveSkipped', 'lastDelivered',
  'lastDeliveryStatus', 'lastDeliveryError', 'deliverySuppressionReason', 'lastFailureNotificationDelivered',
  'lastFailureNotificationDeliveryStatus', 'lastFailureNotificationDeliveryError', 'lastFailureAlertAtMs',
  'lastTriggerEvalAtMs', 'triggerEvalCount', 'lastTriggerFireAtMs', 'triggerState', 'streamStatus', 'streamError',
  'streamConsecutiveFailures', 'streamRestartExhausted', 'streamSourceIdentity', 'streamDroppedBatches',
  'streamCoalescedBatches', 'streamLastStartedAtMs', 'streamLastExitAtMs',
];
const safeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number => safeInteger(value) && value <= 8640000000000000;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && value.trim().length > 0
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && !/[\ud800-\udfff]/u.test(value);
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const input = controlRecord(value);
  return input && Reflect.ownKeys(input).every(key => typeof key === 'string' && keys.includes(key)) ? input : null;
}
export function isCanonicalScheduleAgentId(id: string): boolean { return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id); }

export function parseScheduleNativePage(value: unknown, offset: number): { jobs: Record<string, unknown>[]; snapshotRevision: string; hasMore: boolean } {
  const record = closed(value, ['jobs', 'snapshotRevision', 'total', 'offset', 'limit', 'hasMore', 'nextOffset']);
  if (!record || !Array.isArray(record.jobs) || record.jobs.length > 50 || !record.jobs.every(row => controlRecord(row) !== null)
    || !text(record.snapshotRevision, 128) || !safeInteger(record.total) || record.offset !== offset || record.limit !== 50 || offset > record.total
    || record.jobs.length !== Math.min(50, record.total - offset)
    || record.hasMore !== (offset + record.jobs.length < record.total)
    || record.nextOffset !== (record.hasMore ? offset + record.jobs.length : null)) throw new ControlError('invalid-source');
  return { jobs: record.jobs as Record<string, unknown>[], snapshotRevision: record.snapshotRevision, hasMore: record.hasMore as boolean };
}

export function projectScheduleJob(value: unknown, agentId: string): ScheduleRow | null {
  const job = controlRecord(value);
  if (!job || !isCanonicalScheduleAgentId(agentId) || controlByteSize(job) > CONTROL_LIMITS.responseBytes
    || job.agentId !== agentId || ('effectiveAgentId' in job && job.effectiveAgentId !== agentId)
    || 'sessionKey' in job || 'accountId' in job) return null;
  if ('owner' in job) {
    const owner = closed(job.owner, ['agentId']);
    if (!owner || owner.agentId !== agentId) return null;
  }
  if (!text(job.id, 200) || !text(job.name, 200) || typeof job.enabled !== 'boolean') return null;
  const revision = text(job.configRevision, 128) ? job.configRevision : null;
  const schedule = controlRecord(job.schedule);
  const scheduleKind = text(schedule?.kind, 128) ? schedule.kind : 'unsupported';
  const row: ScheduleRow = {
    id: job.id, agentId, name: job.name.length <= 128 ? job.name : 'Unsupported schedule', enabled: job.enabled,
    revision, scheduleKind, draft: null, readOnlyReason: null,
  };
  // Runtime/error objects are never forwarded; only documented source facts cross the private DTO boundary.
  if (timestamp(job.nextRunAtMs)) row.nextRunAt = job.nextRunAtMs;
  if (timestamp(job.lastRunAtMs)) row.lastRunAt = job.lastRunAtMs;
  if (['ok', 'error', 'skipped'].includes(job.lastRunStatus as string)) row.lastRunStatus = job.lastRunStatus as string;
  const timingMetadata: NonNullable<ScheduleRow['timingMetadata']> = {};
  if (scheduleKind === 'every' && safeInteger(schedule?.anchorMs)) timingMetadata.anchorMs = schedule.anchorMs;
  if (scheduleKind === 'cron' && safeInteger(schedule?.staggerMs)) timingMetadata.staggerMs = schedule.staggerMs;
  if (Object.keys(timingMetadata).length) row.timingMetadata = timingMetadata;

  const payload = closed(job.payload, ['kind', 'message']);
  const delivery = closed(job.delivery, ['mode']);
  const timing = scheduleKind === 'every' ? closed(schedule, ['kind', 'everyMs', 'anchorMs'])
    : scheduleKind === 'cron' ? closed(schedule, ['kind', 'expr', 'tz', 'staggerMs']) : null;
  const knownTiming = timing && (scheduleKind === 'every' ? !('anchorMs' in timing) || safeInteger(timing.anchorMs)
    : !('staggerMs' in timing) || safeInteger(timing.staggerMs));
  const compatible = Reflect.ownKeys(job).every(key => typeof key === 'string' && knownJobFields.has(key))
    && closed(job.state, knownStateFields) !== null
    && job.sessionTarget === 'isolated' && job.wakeMode === 'now' && (job.deleteAfterRun === undefined || job.deleteAfterRun === false)
    && payload?.kind === 'agentTurn' && delivery?.mode === 'none' && job.failureAlert === false && knownTiming
    && (job.declarationKey === undefined || text(job.declarationKey, 200));
  const draft = compatible ? parseScheduleDraft({ name: job.name, message: payload.message,
    schedule: scheduleKind === 'every' ? { kind: 'every', everyMs: timing.everyMs } : { kind: 'cron', expr: timing.expr, tz: timing.tz },
  }) : null;
  const declarationKey = job.declarationKey;
  if (typeof declarationKey === 'string' && reservedDeclarations.some(prefix => declarationKey.startsWith(prefix))) row.readOnlyReason = 'system-owned';
  else if (!compatible) row.readOnlyReason = 'unsupported-definition';
  else if (!draft) row.readOnlyReason = 'bounds';
  else if (!revision) row.readOnlyReason = 'revision-unavailable';
  else row.draft = draft;
  return row;
}

function canonicalDraft(draft: ScheduleDraft): ScheduleDraft {
  const parsed = parseScheduleDraft(draft);
  if (!parsed) throw new TypeError('Invalid schedule draft');
  return parsed;
}
export function scheduleCreateDigest(agentId: string, draft: ScheduleDraft): string {
  if (!isCanonicalScheduleAgentId(agentId)) throw new TypeError('Noncanonical schedule agent');
  const parsed = canonicalDraft(draft);
  return createHash('sha256').update(JSON.stringify({ agentId, name: parsed.name, message: parsed.message, schedule: parsed.schedule })).digest('hex');
}
export function buildScheduleCreate(agentId: string, declarationKey: string, draft: ScheduleDraft): Record<string, unknown> {
  if (!isCanonicalScheduleAgentId(agentId) || !text(declarationKey, 200) || reservedDeclarations.some(prefix => declarationKey.startsWith(prefix))) throw new TypeError('Invalid schedule identity');
  const parsed = canonicalDraft(draft);
  return {
    name: parsed.name, agentId, owner: { agentId }, declarationKey, schedule: parsed.schedule,
    sessionTarget: 'isolated', wakeMode: 'now', enabled: false, deleteAfterRun: false,
    payload: { kind: 'agentTurn', message: parsed.message }, delivery: { mode: 'none' }, failureAlert: false,
  };
}
export function buildScheduleUpdate(intent: Exclude<ScheduleIntent, { kind: 'create' }>): Record<string, unknown> {
  const parsed = parseScheduleIntent(intent);
  if (!parsed || parsed.kind === 'create') throw new TypeError('Invalid schedule update');
  return { id: parsed.jobId, expectedConfigRevision: parsed.revision, patch: parsed.kind === 'enabled' ? { enabled: parsed.enabled }
    : { name: parsed.draft.name, payload: { kind: 'agentTurn', message: parsed.draft.message }, schedule: parsed.draft.schedule } };
}
