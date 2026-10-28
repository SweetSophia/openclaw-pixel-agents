import { controlRecord, parseControlTarget, type ControlTarget, type ControlTaskSnapshot } from './control';
import { isControlRunId } from './controlRunHistory';

export interface ControlStopRequest { target: ControlTarget; runId: string }
export interface ControlStopReceipt extends ControlStopRequest { phase: 'requested' | 'not-running' | 'unknown' }
export function parseControlStopRequest(value: unknown): ControlStopRequest | null {
  const row = controlRecord(value); const raw = controlRecord(row?.target);
  if (!row || Object.keys(row).some(key => !['target', 'runId'].includes(key)) || !isControlRunId(row.runId) || !raw
    || Object.keys(raw).some(key => !['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'branchId', 'activeLeafEntryId'].includes(key))) return null;
  const target = parseControlTarget(raw); return target ? { target, runId: row.runId } : null;
}
export function parseControlStopReceipt(value: unknown): ControlStopReceipt | null {
  const row = controlRecord(value);
  if (!row || Object.keys(row).some(key => !['target', 'runId', 'phase'].includes(key)) || typeof row.phase !== 'string' || !['requested', 'not-running', 'unknown'].includes(row.phase)) return null;
  const input = parseControlStopRequest({ target: row.target, runId: row.runId });
  return input ? { ...input, phase: row.phase as ControlStopReceipt['phase'] } : null;
}
export function currentDirectRun(task: ControlTaskSnapshot | null, now = Date.now()): string | undefined {
  if (!task || task.source.state !== 'current' || !Number.isFinite(task.source.observedAt) || task.source.observedAt < 0
    || now - task.source.observedAt > 15000 || task.source.observedAt - now > 5000
    || task.hasActiveRun !== true || task.runState !== 'running' || !isControlRunId(task.runId)
    || !Array.isArray(task.activeRunIds) || task.activeRunIds.length !== 1 || task.activeRunIds[0] !== task.runId) return;
  return task.runId;
}
