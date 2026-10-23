import { controlRecord, parseControlTarget, type ControlTaskRequest } from '../../shared/control';

export function parseTaskRequest(agentId: string, body: unknown): ControlTaskRequest | null {
  const row = controlRecord(body);
  if (!row || Object.keys(row).some(key => !['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'branchId', 'activeLeafEntryId', 'cursor'].includes(key))
    || (row.agentId !== undefined && row.agentId !== agentId)
    || (row.cursor !== undefined && (typeof row.cursor !== 'string' || !row.cursor || row.cursor.length > 2048))) return null;
  const target = parseControlTarget({ ...row, agentId });
  return target ? { ...target, ...(row.cursor ? { cursor: row.cursor as string } : {}) } : null;
}
