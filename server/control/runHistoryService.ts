import { randomUUID } from 'node:crypto';
import { CONTROL_LIMITS, controlByteSize, controlRecord, parseControlTarget, type ControlTarget, type ControlTaskSnapshot } from '../../shared/control';
import { RUN_HISTORY_LIMITS, isControlRunId, parseControlRunHistorySnapshot, parseRunHistoryRequest, type ControlRunChoice, type ControlRunHistoryRequest, type ControlRunHistorySnapshot } from '../../shared/controlRunHistory';
import { ControlError } from './errors';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';
import { projectConversationMessages, projectTask } from './projection';
import type { TaskService } from './taskService';
import { projectRecordedRunOutcome, type RecordedRunOutcome } from './runOutcome';

export interface RunHistoryService {
  read(input: ControlRunHistoryRequest, signal?: AbortSignal): Promise<ControlRunHistorySnapshot>;
  task(target: ControlTarget, runId: string, signal?: AbortSignal): Promise<ControlTaskSnapshot>;
  close(): void;
}
interface Window {
  id: string; target: ControlTarget; rows: unknown[]; offset: number; loaded: number; more: boolean;
  leaf: unknown; total: unknown; observedAt: number; limitReached: boolean; stale: boolean;
  outcomes: Map<string, RecordedRunOutcome>;
}
const identity = (target: ControlTarget) => JSON.stringify([target.agentId, target.sessionKey, target.sessionId, target.lifecycleRevision ?? null, target.branchId ?? null]);
const runId = (value: unknown) => { const row = controlRecord(value); const id = controlRecord(row?.__openclaw)?.runId ?? row?.runId; return isControlRunId(id) ? id : undefined; };
export function createRunHistoryService(gateway: ControlGateway, tasks: TaskService): RunHistoryService {
  const windows = new Map<string, Window>(); const cursors = new Map<string, { window: string; key: string; runId?: string; expires: number }>();
  const reads = new Set<AbortController>(); let closed = false; let epoch = 0; let destructiveEpoch = 0;
  function trim(): void {
    for (const [key, window] of windows) if (Date.now() - window.observedAt >= RUN_HISTORY_LIMITS.expiryMs) windows.delete(key);
    while (windows.size > RUN_HISTORY_LIMITS.windows) windows.delete(windows.keys().next().value!);
    for (const [id, cursor] of cursors) if (cursor.expires <= Date.now()) cursors.delete(id);
    while (cursors.size > 100) cursors.delete(cursors.keys().next().value!);
  }
  function denied(): void {
    if (!gateway.status().canRead) throw new ControlError(gateway.status().state === 'auth-error' ? 'scope-required' : gateway.status().state === 'pairing-required' ? 'pairing-required' : 'unavailable');
  }
  function project(window: Window, row: Record<string, unknown>, selectedRunId?: string): ControlRunHistorySnapshot {
    const choices = new Map<string, ControlRunChoice>();
    for (const value of [...window.rows].reverse()) {
      const id = runId(value); if (!id || choices.has(id)) continue;
      const source = controlRecord(value); if (!source || !['user', 'assistant', 'toolResult'].includes(String(source.role))) continue;
      const at = typeof source.timestamp === 'number' && Number.isFinite(source.timestamp) && source.timestamp >= 0 && source.timestamp <= Number.MAX_SAFE_INTEGER ? source.timestamp : undefined;
      choices.set(id, { runId: id, ...(at === undefined ? {} : { at }) });
    }
    const all = [...choices.values()]; const runs = all.slice(0, RUN_HISTORY_LIMITS.choices);
    // A selected, source-verified run remains selectable even when the choice list is capped.
    if (selectedRunId && choices.has(selectedRunId) && !runs.some(run => run.runId === selectedRunId)) runs[runs.length - 1] = choices.get(selectedRunId)!;
    const result: ControlRunHistorySnapshot = { target: window.target, source: { state: window.stale ? 'stale' : 'current', observedAt: window.observedAt }, runs,
      runsTruncated: all.length > runs.length, loadedRecords: window.loaded, limitReached: window.limitReached, messages: [], messagesTruncated: false, ...(selectedRunId ? { selectedRunId } : {}) };
    if (selectedRunId && choices.has(selectedRunId)) {
      const selectedRows = window.rows.filter(value => runId(value) === selectedRunId);
      // The native transcript supplies run IDs, but no historical terminal ledger.
      // Current session status/model/timing must never stand in for this selected run.
      result.task = projectTask({ target: window.target, session: { ...row, ...window.target, key: window.target.sessionKey, hasActiveRun: null, model: undefined, modelProvider: undefined },
        history: { sessionKey: window.target.sessionKey, sessionId: window.target.sessionId, messages: selectedRows, hasMore: window.more }, children: [], childrenComplete: false,
        loadedRecords: window.loaded, observedAt: window.observedAt, selectedRunId });
      result.task.source = result.source;
      const outcome = window.outcomes.get(selectedRunId);
      if (outcome) {
        result.outcome = { state: outcome.state, observedAt: outcome.observedAt };
        if (outcome.state === 'recorded') {
          const finished = ['completed', 'failed', 'aborted'].includes(outcome.runState);
          result.task = projectTask({ target: window.target,
            session: { ...window.target, key: window.target.sessionKey, hasActiveRun: finished ? false : null, lastRunId: finished ? selectedRunId : undefined,
              status: outcome.runState, startedAt: outcome.startedAt, endedAt: outcome.endedAt },
            history: { sessionKey: window.target.sessionKey, sessionId: window.target.sessionId, messages: selectedRows, hasMore: window.more },
            children: [], childrenComplete: false, loadedRecords: window.loaded, observedAt: window.observedAt, selectedRunId });
          if (!finished && outcome.startedAt !== undefined) result.task.startedAt = outcome.startedAt;
          result.task.source = result.source;
        }
      }
      const messages = projectConversationMessages(selectedRows); result.messages = messages.slice(-CONTROL_LIMITS.historyPage); result.messagesTruncated = result.messages.length !== messages.length;
    }
    if (window.more && !window.limitReached && window.loaded < CONTROL_LIMITS.maximumHistory) {
      const token = randomUUID(); cursors.set(token, { key: identity(window.target), window: window.id, runId: selectedRunId, expires: window.observedAt + RUN_HISTORY_LIMITS.expiryMs }); result.nextCursor = token;
    }
    while (controlByteSize(result) > CONTROL_LIMITS.responseBytes && result.messages.length) { result.messages.shift(); result.messagesTruncated = true; }
    while (controlByteSize(result) > CONTROL_LIMITS.responseBytes) {
      const message = [result.task?.request, result.task?.latestResponse, result.task?.result].find(item => item && item.text.length > 128);
      if (!message) throw new ControlError('invalid-source'); message.text = message.text.slice(0, Math.floor(message.text.length / 2)).replace(/[\ud800-\udbff]$/, ''); message.truncated = true;
    }
    const checked = parseControlRunHistorySnapshot(result); if (!checked) throw new ControlError('invalid-source'); trim(); return checked;
  }
  async function read(value: ControlRunHistoryRequest, signal?: AbortSignal): Promise<ControlRunHistorySnapshot> {
    const input = parseRunHistoryRequest(value.agentId, value); if (!input) throw new ControlError('invalid-request');
    if (closed || signal?.aborted) throw new ControlError('unavailable'); if (reads.size >= 8) throw new ControlError('rate-limited');
    const controller = new AbortController(); reads.add(controller); const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const generation = epoch; const destructive = destructiveEpoch; const key = identity(input); trim(); const existing = windows.get(key);
    const cursor = input.cursor ? cursors.get(input.cursor) : undefined;
    if (input.cursor && (!cursor || !existing || cursor.window !== existing.id || cursor.key !== key || cursor.runId !== input.runId || cursor.expires <= Date.now())) { reads.delete(controller); throw new ControlError('invalid-request'); }
    try {
      denied(); const row = await tasks.verifyTarget(input, combined); denied();
      if (cursor && row.activeLeafEntryId !== existing!.leaf) throw new ControlError('session-changed');
      let window = existing;
      if (!window || input.refresh || cursor) {
        if (cursor) window = { ...existing!, rows: [...existing!.rows], outcomes: new Map(existing!.outcomes), id: randomUUID() };
        else {
          const selected = parseControlTarget({ ...input, activeLeafEntryId: row.activeLeafEntryId });
          if (!selected) throw new ControlError('invalid-source');
          window = { id: randomUUID(), target: selected, rows: [], offset: 0, loaded: 0, more: true, leaf: row.activeLeafEntryId, total: undefined, observedAt: Date.now(), limitReached: false, stale: false, outcomes: new Map() };
        }
        const budget = cursor ? CONTROL_LIMITS.historyPage : CONTROL_LIMITS.automaticHistory;
        for (let used = 0; used < budget && window.more && window.loaded < CONTROL_LIMITS.maximumHistory; used += CONTROL_LIMITS.historyPage) {
          const limit = Math.min(CONTROL_LIMITS.historyPage, CONTROL_LIMITS.maximumHistory - window.loaded);
          const page = controlRecord(await gateway.request('chat.history', { agentId: input.agentId, sessionKey: input.sessionKey, limit, maxBytes: CONTROL_LIMITS.responseBytes, offset: window.offset }, combined));
          if (!page || page.sessionKey !== input.sessionKey || page.sessionId !== input.sessionId || !Array.isArray(page.messages) || page.messages.length > limit
            || controlByteSize(page) > CONTROL_LIMITS.responseBytes || page.windowReset === true || (window.total !== undefined && window.total !== page.totalMessages)) throw new ControlError('invalid-source');
          const info = controlRecord(page.sessionInfo);
          if (info) tasks.verifyHistoryInfo(input, info);
          if (info?.activeLeafEntryId !== undefined && info.activeLeafEntryId !== window.leaf) throw new ControlError('session-changed');
          if (controlByteSize([...page.messages, ...window.rows]) > RUN_HISTORY_LIMITS.bytes) { window.limitReached = true; break; }
          window.total = page.totalMessages; window.rows = [...page.messages, ...window.rows]; window.loaded += page.messages.length; window.more = page.hasMore === true;
          if (window.more && (!Number.isSafeInteger(page.nextOffset) || (page.nextOffset as number) <= window.offset)) throw new ControlError('invalid-source');
          if (window.more) window.offset = page.nextOffset as number;
        }
        window.limitReached ||= window.loaded >= CONTROL_LIMITS.maximumHistory; window.stale = false;
      }
      if (input.runId && window.rows.some(value => { const row = controlRecord(value); return row && ['user', 'assistant', 'toolResult'].includes(String(row.role)) && runId(row) === input.runId; })) {
        try {
          const raw = await gateway.request('audit.activity.list', { agentId: input.agentId, sessionKey: input.sessionKey, runId: input.runId, kind: 'agent_run', limit: 50 }, combined);
          const next = projectRecordedRunOutcome(raw, input, input.runId, Date.now());
          if (window.outcomes.get(input.runId)?.state !== 'recorded' || next.state === 'recorded') window.outcomes.set(input.runId, next);
        } catch (error) {
          if (window.outcomes.get(input.runId)?.state !== 'recorded') window.outcomes.set(input.runId, { state: error instanceof GatewayRequestError && error.code === 'unsupported' ? 'unsupported' : 'unavailable', observedAt: Date.now(), runState: 'unknown' });
        }
        while (window.outcomes.size > RUN_HISTORY_LIMITS.choices) window.outcomes.delete(window.outcomes.keys().next().value!);
      }
      const after = await tasks.verifyTarget(input, combined); denied();
      if (after.activeLeafEntryId !== row.activeLeafEntryId) throw new ControlError('session-changed');
      if (closed || combined.aborted || generation !== epoch) throw new ControlError(destructive !== destructiveEpoch ? 'session-changed' : 'unavailable');
      windows.delete(key); windows.set(key, window); return project(window, after, input.runId);
    } catch (error) {
      if (destructive !== destructiveEpoch) throw new ControlError('session-changed');
      if (existing && !combined.aborted && ((error instanceof ControlError || error instanceof GatewayRequestError) && error.code === 'unavailable')) {
        existing.stale = true;
        // Source loss retains the original observation time and cannot add new run proof.
        return project(existing, {}, input.runId);
      }
      throw error;
    } finally { reads.delete(controller); }
  }
  const off = gateway.onEvent(event => {
    const reason = controlRecord(event.payload)?.reason;
    if (event.event === 'source.invalidated' || (event.event === 'sessions.changed' && ['reset', 'delete', 'branch', 'branch-switch', 'rewind'].includes(String(reason)))) {
      epoch++; for (const read of reads) read.abort();
      if (event.event === 'sessions.changed' || ['auth-error', 'pairing-required'].includes(gateway.status().state)) { destructiveEpoch++; windows.clear(); cursors.clear(); }
      else for (const window of windows.values()) window.stale = true;
    }
  });
  return { read, async task(target, run, signal) { if (!isControlRunId(run)) throw new ControlError('invalid-request'); const snapshot = await read({ ...target, runId: run }, signal); if (!snapshot.task) throw new ControlError('invalid-target'); return snapshot.task; },
    close() { closed = true; epoch++; off(); for (const read of reads) read.abort(); windows.clear(); cursors.clear(); } };
}
