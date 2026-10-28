import { CONTROL_LIMITS, controlByteSize, controlRecord, parseControlMessage, parseControlTarget, parseControlTaskSnapshot, type ControlTarget, type ControlTaskSnapshot, type ControlSource, type ControlMessage } from './control';

export const RUN_HISTORY_LIMITS = { choices: 100, windows: 8, bytes: 2 * 1024 * 1024, expiryMs: 60000 } as const;
export interface ControlRunChoice { runId: string; at?: number }
export interface ControlRunHistoryRequest extends ControlTarget { runId?: string; cursor?: string; refresh?: boolean }
export interface ControlRunHistorySnapshot {
  target: ControlTarget; source: ControlSource; runs: ControlRunChoice[]; runsTruncated: boolean;
  loadedRecords: number; limitReached: boolean; nextCursor?: string; selectedRunId?: string; task?: ControlTaskSnapshot; messages: ControlMessage[]; messagesTruncated: boolean;
  outcome?: { state: 'recorded' | 'unavailable' | 'unsupported' | 'ambiguous'; observedAt: number };
}
export function isControlRunId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value);
}
export function parseRunHistoryRequest(agentId: string, value: unknown): ControlRunHistoryRequest | null {
  const row = controlRecord(value);
  if (!row || row.agentId !== agentId || Object.keys(row).some(key => !['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'branchId', 'activeLeafEntryId', 'runId', 'cursor', 'refresh'].includes(key))
    || (row.runId !== undefined && !isControlRunId(row.runId))
    || (row.cursor !== undefined && (typeof row.cursor !== 'string' || !row.cursor || row.cursor.length > 2048))
    || (row.refresh !== undefined && typeof row.refresh !== 'boolean') || (row.cursor !== undefined && row.refresh === true)) return null;
  const target = parseControlTarget(row);
  return target ? { ...target, ...(row.runId === undefined ? {} : { runId: row.runId as string }), ...(row.cursor === undefined ? {} : { cursor: row.cursor as string }), ...(row.refresh === undefined ? {} : { refresh: row.refresh as boolean }) } : null;
}
export function parseControlRunHistorySnapshot(value: unknown): ControlRunHistorySnapshot | null {
  const row = controlRecord(value);
  if (!row || controlByteSize(row) > CONTROL_LIMITS.responseBytes || !Array.isArray(row.runs) || row.runs.length > RUN_HISTORY_LIMITS.choices
    || typeof row.runsTruncated !== 'boolean' || typeof row.messagesTruncated !== 'boolean' || typeof row.limitReached !== 'boolean' || !Array.isArray(row.messages) || row.messages.length > CONTROL_LIMITS.historyPage || !Number.isSafeInteger(row.loadedRecords) || (row.loadedRecords as number) < 0 || (row.loadedRecords as number) > CONTROL_LIMITS.maximumHistory
    || (row.nextCursor !== undefined && (typeof row.nextCursor !== 'string' || !row.nextCursor || row.nextCursor.length > 2048))
    || (row.selectedRunId !== undefined && !isControlRunId(row.selectedRunId))) return null;
  const target = parseControlTarget(row.target); const source = controlRecord(row.source);
  if (!target || !source || !['current', 'stale'].includes(String(source.state)) || typeof source.observedAt !== 'number' || !Number.isFinite(source.observedAt) || source.observedAt < 0 || source.observedAt > Number.MAX_SAFE_INTEGER) return null;
  const runs: ControlRunChoice[] = []; const seen = new Set<string>();
  for (const value of row.runs) {
    const run = controlRecord(value);
    if (!run || !isControlRunId(run.runId) || seen.has(run.runId) || (run.at !== undefined && (typeof run.at !== 'number' || !Number.isFinite(run.at) || run.at < 0 || run.at > Number.MAX_SAFE_INTEGER))) return null;
    seen.add(run.runId); runs.push({ runId: run.runId, ...(run.at === undefined ? {} : { at: run.at as number }) });
  }
  const task = row.task === undefined ? undefined : parseControlTaskSnapshot(row.task);
  if (row.task !== undefined && (!task || task.runId !== row.selectedRunId || !seen.has(task.runId!)
    || JSON.stringify(parseControlTarget(task.target)) !== JSON.stringify(target))) return null;
  const messages: ControlMessage[] = [];
  const outcome = row.outcome === undefined ? undefined : controlRecord(row.outcome);
  if (row.outcome !== undefined && (!outcome || !task || !['recorded', 'unavailable', 'unsupported', 'ambiguous'].includes(String(outcome.state)) || typeof outcome.observedAt !== 'number' || !Number.isSafeInteger(outcome.observedAt) || outcome.observedAt < 0)) return null;
  for (const raw of row.messages) { const message = parseControlMessage(raw); if (!message || !task || !row.selectedRunId || message.runId !== row.selectedRunId || !seen.has(message.runId)) return null; messages.push(message); }
  return { target, source: { state: source.state as 'current' | 'stale', observedAt: source.observedAt }, runs, runsTruncated: row.runsTruncated, messages, messagesTruncated: row.messagesTruncated, limitReached: row.limitReached,
    loadedRecords: row.loadedRecords as number, ...(row.nextCursor === undefined ? {} : { nextCursor: row.nextCursor as string }),
    ...(row.selectedRunId === undefined ? {} : { selectedRunId: row.selectedRunId as string }), ...(task ? { task } : {}), ...(outcome ? { outcome: { state: outcome.state as NonNullable<ControlRunHistorySnapshot['outcome']>['state'], observedAt: outcome.observedAt as number } } : {}) };
}
