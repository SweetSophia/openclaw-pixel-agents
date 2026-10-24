import { CONTROL_LIMITS, controlRecord, parseControlTarget, type ControlSendRequest, type ControlTarget, type ControlTaskRequest } from '../../shared/control';

export function parseResultsTarget(agentId: string, body: unknown): ControlTarget | null {
  const row = controlRecord(body);
  if (!row || row.agentId !== agentId || Object.keys(row).some(key => !['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'branchId', 'activeLeafEntryId'].includes(key))) return null;
  return parseControlTarget(row);
}

export function parseSendRequest(agentId: string, body: unknown): ControlSendRequest | null {
  const row = controlRecord(body);
  if (!row || Object.keys(row).some(key => !['agentId', 'target', 'newConversation', 'message', 'idempotencyKey'].includes(key))
    || (row.agentId !== undefined && row.agentId !== agentId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agentId)
    || typeof row.message !== 'string' || !row.message.trim() || row.message.length > CONTROL_LIMITS.prompt
    || typeof row.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.idempotencyKey)
    || typeof row.newConversation !== 'boolean') return null;
  const target = row.target === undefined ? undefined : parseTaskRequest(agentId, row.target);
  if (row.newConversation ? row.target !== undefined : !target || 'cursor' in target) return null;
  return { agentId, newConversation: row.newConversation, message: row.message, idempotencyKey: row.idempotencyKey, ...(target ? { target } : {}) };
}

export function parseTaskRequest(agentId: string, body: unknown): ControlTaskRequest | null {
  const row = controlRecord(body);
  if (!row || Object.keys(row).some(key => !['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'branchId', 'activeLeafEntryId', 'cursor'].includes(key))
    || (row.agentId !== undefined && row.agentId !== agentId)
    || (row.cursor !== undefined && (typeof row.cursor !== 'string' || !row.cursor || row.cursor.length > 2048))) return null;
  const target = parseControlTarget({ ...row, agentId });
  return target ? { ...target, ...(row.cursor ? { cursor: row.cursor as string } : {}) } : null;
}
