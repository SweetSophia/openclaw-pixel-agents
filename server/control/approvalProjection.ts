import { CONTROL_LIMITS, controlByteSize, controlRecord } from '../../shared/control';
import { isApprovalId, isApprovalKind, parseControlApproval, type ControlApproval } from '../../shared/controlApprovals';

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
// Validate native discriminators before stripping them from the office presentation.
function nativeState(row: Record<string, unknown>): boolean {
  if (row.status === 'pending') return row.decision === undefined && row.reason === undefined && row.resolvedAtMs === undefined;
  if (row.status === 'allowed') return (row.decision === 'allow-once' || row.decision === 'allow-always') && row.reason === 'user';
  if (row.status === 'denied') return row.decision === 'deny' && typeof row.reason === 'string'
    && ['user', 'malformed-verdict', 'no-route', 'storage-corrupt'].includes(row.reason);
  if (row.status === 'expired') return row.decision === undefined && row.reason === 'timeout';
  return row.status === 'cancelled' && row.decision === undefined && (row.reason === 'run-aborted' || row.reason === 'gateway-restart');
}
function scopeDetails(value: unknown): string[] | null {
  if (value === undefined) return [];
  const row = controlRecord(value); if (!row) return null;
  if (row.kind === 'message-send' && text(row.target, 128) && Number.isSafeInteger(row.recipientCount) && Number(row.recipientCount) >= 1 && Number(row.recipientCount) <= 1000000
    && (row.audience === undefined || row.audience === 'internal' || row.audience === 'external')
    && (row.recipients === undefined || (Array.isArray(row.recipients) && row.recipients.length <= 5 && row.recipients.every(item => text(item, 128)))))
    return [`Message target: ${row.target}`, `Recipients: ${row.recipientCount}${row.audience ? ` (${row.audience})` : ''}`, ...(Array.isArray(row.recipients) ? [`Named recipients: ${row.recipients.join(', ')}`] : [])];
  if (row.kind === 'payment' && text(row.amount, 40) && text(row.currency, 12) && text(row.target, 128)) return [`Payment: ${row.amount} ${row.currency}`, `Payment target: ${row.target}`];
  if (row.kind === 'external-post' && text(row.target, 128) && (row.visibility === 'public' || row.visibility === 'restricted')) return [`Publication target: ${row.target}`, `Visibility: ${row.visibility}`];
  if (row.kind === 'standing-grant' && text(row.automation, 128) && text(row.command, 256)
    && (row.expiresInDays === undefined || (Number.isSafeInteger(row.expiresInDays) && Number(row.expiresInDays) >= 1 && Number(row.expiresInDays) <= 3650)))
    return [`Automation: ${row.automation}`, `Command: ${row.command}`, 'This office offers one-time decisions only.'];
  return null;
}
/** Pick only the native reviewer-safe presentation, never raw request/policy envelopes. */
export function projectApproval(value: unknown): ControlApproval | null {
  const row = controlRecord(value); const presentation = controlRecord(row?.presentation);
  if (!row || !nativeState(row) || controlByteSize(row) > CONTROL_LIMITS.responseBytes || !presentation || !isApprovalId(row.id) || !isApprovalKind(presentation.kind)
    || !Array.isArray(presentation.allowedDecisions) || presentation.allowedDecisions.length > 3 || !presentation.allowedDecisions.includes('deny')
    || !presentation.allowedDecisions.every(item => typeof item === 'string' && ['allow-once', 'allow-always', 'deny'].includes(item)) || new Set(presentation.allowedDecisions).size !== presentation.allowedDecisions.length) return null;
  const details = scopeDetails(presentation.scope); if (!details) return null;
  let title: string; let body: string;
  if (presentation.kind === 'exec') {
    if (!text(presentation.commandText, 16000)) return null;
    title = 'Run command'; body = presentation.commandText;
    for (const [field, label] of [['commandPreview', 'Preview'], ['warningText', 'Warning'], ['host', 'Host'], ['nodeId', 'Node'], ['agentId', 'Agent']] as const) {
      const item = presentation[field]; if (item !== undefined && item !== null) { if (!text(item, 16000)) return null; details.push(`${label}: ${item}`); }
    }
  } else {
    if (!text(presentation.title, 80) || !text(presentation.description, 512)) return null;
    title = presentation.title; body = presentation.description;
    if (presentation.kind === 'plugin') {
      if (typeof presentation.severity !== 'string' || !['info', 'warning', 'critical'].includes(presentation.severity)) return null;
      details.push(`Severity: ${presentation.severity}`);
      if (presentation.detail !== undefined) { if (!text(presentation.detail, 16000)) return null; details.push(presentation.detail); }
      for (const [field, label] of [['pluginId', 'Plugin'], ['toolName', 'Tool'], ['agentId', 'Agent']] as const) {
        const item = presentation[field]; if (item !== undefined && item !== null) { if (!text(item, 256)) return null; details.push(`${label}: ${item}`); }
      }
      if (presentation.externalResolution !== undefined) {
        const external = controlRecord(presentation.externalResolution);
        if (!external || !text(external.label, 80) || !Array.isArray(external.decisions) || external.decisions.length < 1 || external.decisions.length > 2
          || !external.decisions.every(item => item === 'allow-once' || item === 'allow-always') || new Set(external.decisions).size !== external.decisions.length) return null;
        details.push(`External verification: ${external.label}`, `Externally verified decisions: ${external.decisions.join(', ')}`);
      }
    } else {
      if (typeof presentation.proposalHash !== 'string' || !/^[a-f0-9]{64}$/.test(presentation.proposalHash)) return null;
      details.push(`Proposal hash: ${presentation.proposalHash}`);
      if (presentation.agentId !== undefined && presentation.agentId !== null) { if (!text(presentation.agentId, 256)) return null; details.push(`Agent: ${presentation.agentId}`); }
    }
  }
  return parseControlApproval({ id: row.id, kind: presentation.kind, title, text: body, details, status: row.status,
    createdAtMs: row.createdAtMs, expiresAtMs: row.expiresAtMs,
    ...(row.resolvedAtMs === undefined ? {} : { resolvedAtMs: row.resolvedAtMs }),
    ...(row.sourceSessionKey === undefined ? {} : { sourceSessionKey: row.sourceSessionKey }),
    allowedDecisions: row.status === 'pending' ? presentation.allowedDecisions.filter(item => item === 'allow-once' || item === 'deny') : [],
  });
}
