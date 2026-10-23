import {
  CONTROL_LIMITS, controlByteSize, controlRecord, parseControlSession, parseControlTarget, parseControlTaskSnapshot,
  type ControlActivity, type ControlMessage, type ControlRunState, type ControlSession, type ControlTarget, type ControlTaskSnapshot,
} from '../../shared/control';

function opaque(value: unknown, max = 256): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}
function sequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function clipped(value: string, max: number): string {
  const result = value.slice(0, max);
  return /[\ud800-\udbff]$/.test(result) ? result.slice(0, -1) : result;
}
function display(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? clipped(value, max) : undefined;
}
function model(row: Record<string, unknown>): string | undefined {
  const name = display(row.model, 256);
  const provider = display(row.modelProvider, 128);
  return name ? clipped(provider && !name.includes('/') ? `${provider}/${name}` : name, 256) : undefined;
}

export function projectSession(value: unknown, agentId: string): ControlSession | null {
  const row = controlRecord(value);
  if (!row || row.agentId !== agentId) return null;
  const target = parseControlTarget({
    agentId, sessionKey: row.key, sessionId: row.sessionId,
    lifecycleRevision: opaque(row.lifecycleRevision), branchId: opaque(row.branchId),
    activeLeafEntryId: opaque(row.activeLeafEntryId),
  });
  if (!target || (target.sessionKey.startsWith('agent:') && !target.sessionKey.startsWith(`agent:${agentId}:`))) return null;
  return parseControlSession({
    ...target, name: display(row.displayName, 256) || display(row.label, 256) || 'Conversation',
    channel: display(row.channel, 128),
    isChild: Boolean(opaque(row.parentSessionKey, 512) || opaque(row.spawnedBy, 512) || row.kind === 'subagent'),
    hasActiveRun: typeof row.hasActiveRun === 'boolean' ? row.hasActiveRun : null,
    updatedAt: timestamp(row.updatedAt), snapshotAt: timestamp(row.snapshotAt), model: model(row),
    sendDisabledReason: typeof row.sendDisabledReason === 'string' && row.sendDisabledReason
      ? 'This conversation is not available for sending.' : undefined,
  });
}

interface ProjectedMessage { value: ControlMessage; stopReason?: string; hasTools: boolean }
function messageRun(row: Record<string, unknown>): string | undefined {
  return opaque(controlRecord(row.__openclaw)?.runId) ?? opaque(row.runId);
}
function messageTime(row: Record<string, unknown>): number | undefined {
  return timestamp(row.timestamp) ?? timestamp(controlRecord(row.__openclaw)?.recordTimestampMs);
}
function projectMessage(row: Record<string, unknown>, index: number): ProjectedMessage | null {
  if (row.role !== 'user' && row.role !== 'assistant') return null;
  const blocks = Array.isArray(row.content) ? row.content : [];
  const text = typeof row.content === 'string' ? row.content : blocks
    .map(controlRecord).filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block!.text as string).join('\n');
  if (!text) return null;
  const meta = controlRecord(row.__openclaw);
  const output = clipped(text, CONTROL_LIMITS.text);
  return {
    value: {
      id: opaque(meta?.id) ?? opaque(row.id) ?? `local-record-${index}`,
      role: row.role, text: output, truncated: output.length < text.length || meta?.truncated === true,
      runId: messageRun(row), at: messageTime(row), messageSeq: sequence(meta?.seq),
      submissionId: opaque(meta?.submissionId) ?? opaque(row.submissionId),
    },
    stopReason: typeof row.stopReason === 'string' ? row.stopReason : undefined,
    hasTools: blocks.some(block => controlRecord(block)?.type === 'toolCall'),
  };
}

function exactRuns(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 64 || !value.every(id => opaque(id))) return undefined;
  return [...value] as string[];
}
function projectActivities(rows: Record<string, unknown>[], runId: string | undefined): ControlActivity[] {
  const activity: ControlActivity[] = [];
  const results = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const callId = opaque(row.toolCallId);
    if (row.role === 'toolResult' && callId) results.set(JSON.stringify([messageRun(row) ?? null, callId]), row);
  }
  for (const [index, row] of rows.entries()) {
    const owner = messageRun(row);
    if (row.role !== 'assistant' || !Array.isArray(row.content) || (runId && owner !== runId)) continue;
    for (const [blockIndex, item] of row.content.entries()) {
      const block = controlRecord(item);
      if (block?.type !== 'toolCall') continue;
      const callId = opaque(block.id);
      const result = callId ? results.get(JSON.stringify([owner ?? null, callId])) : undefined;
      activity.push({
        id: clipped(`${owner ?? 'unknown'}:${callId ?? `${index}-${blockIndex}`}`, 256),
        runId: owner, toolCallId: callId, toolName: display(block.name, 128) || 'Unknown tool',
        at: messageTime(row), outcome: result ? result.isError === true ? 'error'
          : result.isError === false ? 'success' : 'unknown' : callId ? 'pending' : 'unknown',
      });
    }
  }
  return activity.slice(-CONTROL_LIMITS.activity);
}

export interface ProjectTaskInput {
  target: ControlTarget; session: unknown; history: unknown; children: unknown[]; childrenComplete: boolean;
  loadedRecords: number; nextCursor?: string; observedAt: number;
}
export function projectTask(input: ProjectTaskInput): ControlTaskSnapshot {
  const target = parseControlTarget(input.target);
  const session = controlRecord(input.session);
  const history = controlRecord(input.history);
  if (!target || !session || !history || session.sessionId !== target.sessionId
    || session.key !== target.sessionKey || session.agentId !== target.agentId
    || history.sessionId !== target.sessionId || history.sessionKey !== target.sessionKey
    || !Array.isArray(history.messages) || sequence(input.loadedRecords) === undefined
    || input.loadedRecords > CONTROL_LIMITS.maximumHistory || timestamp(input.observedAt) === undefined) {
    throw new Error('Invalid task source');
  }
  for (const key of ['lifecycleRevision', 'branchId'] as const) {
    if (target[key] !== undefined && session[key] !== undefined && target[key] !== session[key]) throw new Error('Task generation changed');
  }
  const hasActiveRun = typeof session.hasActiveRun === 'boolean' ? session.hasActiveRun : null;
  const inFlight = controlRecord(history.inFlightRun);
  const runId = hasActiveRun === true ? opaque(inFlight?.runId) : hasActiveRun === false ? opaque(session.lastRunId) : undefined;
  let runState: ControlRunState = hasActiveRun === true ? 'running' : runId ? 'not-running' : 'unknown';
  if (runId && hasActiveRun === false) {
    if (session.abortedLastRun === true || session.status === 'aborted' || session.status === 'cancelled') runState = 'aborted';
    else if (session.status === 'completed') runState = 'completed';
    else if (session.status === 'failed' || session.status === 'error') runState = 'failed';
  }
  const rows = history.messages.slice(-CONTROL_LIMITS.maximumHistory).map(controlRecord)
    .filter((row): row is Record<string, unknown> => row !== null);
  const messages = rows.map(projectMessage).filter((item): item is ProjectedMessage => item !== null);
  const reversed = [...messages].reverse();
  const matchedRequest = runId ? reversed.find(item => item.value.role === 'user' && item.value.runId === runId) : undefined;
  const request = matchedRequest ?? reversed.find(item => item.value.role === 'user');
  const response = reversed.find(item => item.value.role === 'assistant' && (!runId || item.value.runId === runId));
  const childSessions = input.children.map(value => {
    const child = controlRecord(value);
    if (!child || typeof child.agentId !== 'string' || (child.spawnedBy !== target.sessionKey && child.parentSessionKey !== target.sessionKey)) return null;
    return projectSession(child, child.agentId);
  }).filter((row): row is ControlSession => row !== null);
  const projected: ControlTaskSnapshot = {
    target, source: { state: 'current', observedAt: input.observedAt }, hasActiveRun,
    activeRunIds: exactRuns(session.activeRunIds), runId, runState,
    request: request?.value, requestAssociation: matchedRequest ? 'run' : request ? 'latest-recorded' : 'unknown',
    requestState: matchedRequest || (!runId && request) ? 'found' : input.loadedRecords >= CONTROL_LIMITS.maximumHistory ? 'limit-reached'
      : history.hasMore === false ? 'unavailable' : 'not-loaded',
    startedAt: runId ? timestamp(hasActiveRun === true ? inFlight?.startedAt : session.startedAt) : undefined,
    endedAt: runId && hasActiveRun === false ? timestamp(session.endedAt) : undefined,
    latestResponse: response?.value,
    result: runState === 'completed' && response && !response.hasTools && response.stopReason !== 'toolUse' ? response.value : undefined,
    activity: projectActivities(rows, runId), children: childSessions.slice(0, CONTROL_LIMITS.sessions),
    childrenComplete: input.childrenComplete && childSessions.length === input.children.length && childSessions.length <= CONTROL_LIMITS.sessions,
    loadedRecords: input.loadedRecords, nextCursor: input.nextCursor, model: model(session),
  };
  while (controlByteSize(projected) > CONTROL_LIMITS.responseBytes) {
    const text = [projected.request, projected.latestResponse, projected.result].find(item => item && item.text.length > 128);
    if (!text) throw new Error('Task source exceeds display limit');
    text.text = clipped(text.text, Math.floor(text.text.length / 2));
    text.truncated = true;
  }
  const checked = parseControlTaskSnapshot(projected);
  if (!checked) throw new Error('Invalid projected task');
  return checked;
}
