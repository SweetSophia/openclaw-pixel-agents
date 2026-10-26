import { controlByteSize, controlRecord, type ControlRunState, type ControlTarget } from '../../shared/control';
import { isControlRunId } from '../../shared/controlRunHistory';

export interface RecordedRunOutcome {
  state: 'recorded' | 'unavailable' | 'unsupported' | 'ambiguous'; observedAt: number;
  runState: ControlRunState; startedAt?: number; endedAt?: number;
}
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
// Native audit.activity.list V1 is metadata-only and best effort, with optional session provenance.
// Only a complete, unambiguous exact-instance result can establish a historical terminal fact.
export function projectRecordedRunOutcome(raw: unknown, target: ControlTarget, runId: string, observedAt: number): RecordedRunOutcome {
  const unknown: RecordedRunOutcome = { state: 'unavailable', observedAt, runState: 'unknown' };
  const report = controlRecord(raw);
  if (!report || controlByteSize(raw) > 256 * 1024 || !Array.isArray(report.events) || report.events.length > 50 || report.nextCursor !== undefined) return unknown;
  const starts: number[] = []; const ends: { at: number; state: ControlRunState }[] = []; const ids = new Set<string>();
  for (const value of report.events) {
    const row = controlRecord(value); const actor = controlRecord(row?.actor);
    if (!row || row.schemaVersion !== 1 || row.eventType !== 'agent_run' || row.kind !== 'agent_run' || row.redaction !== 'metadata_only'
      || row.agentId !== target.agentId || row.sessionKey !== target.sessionKey || row.sessionId !== target.sessionId || row.runId !== runId
      || !isControlRunId(row.eventId) || !integer(row.sequence, 1) || !integer(row.sourceSequence, 1) || !integer(row.occurredAt)
      || !actor || !['agent', 'system'].includes(String(actor.type)) || !isControlRunId(actor.id)) return unknown;
    if (ids.has(row.eventId)) return { ...unknown, state: 'ambiguous' }; ids.add(row.eventId);
    if (row.action === 'agent.run.started' && row.status === 'started' && row.errorCode === undefined) starts.push(row.occurredAt);
    else if (row.action === 'agent.run.finished') {
      const statuses: Record<string, [ControlRunState, string | undefined]> = { succeeded: ['completed', undefined], failed: ['failed', 'run_failed'], cancelled: ['aborted', 'run_cancelled'], timed_out: ['failed', 'run_timed_out'], blocked: ['failed', 'run_blocked'] };
      const status = typeof row.status === 'string' && Object.prototype.hasOwnProperty.call(statuses, row.status) ? statuses[row.status] : undefined;
      if (!status || row.errorCode !== status[1]) return unknown;
      ends.push({ at: row.occurredAt, state: status[0] });
    } else return unknown;
  }
  if (starts.length > 1 || ends.length > 1 || (starts.length === 1 && ends.length === 1 && ends[0].at < starts[0])) return { ...unknown, state: 'ambiguous' };
  if (!ends.length && !starts.length) return unknown;
  return { state: 'recorded', observedAt, runState: ends[0]?.state ?? 'unknown', ...(starts.length ? { startedAt: starts[0] } : {}), ...(ends.length ? { endedAt: ends[0].at } : {}) };
}
