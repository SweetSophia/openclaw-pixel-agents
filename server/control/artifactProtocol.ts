import { controlRecord, type ControlTarget, type ControlTaskSnapshot } from '../../shared/control';
import { parseControlArtifactSummary, type ControlArtifactScope, type ControlArtifactSummary } from '../../shared/controlResults';
import { ControlError } from './errors';

export const artifactScope = (task: ControlTaskSnapshot): ControlArtifactScope => task.runId ? { kind: 'run', runId: task.runId } : { kind: 'conversation' };
export const sameArtifactScope = (a: ControlArtifactScope, b: ControlArtifactScope): boolean => a.kind === b.kind && (a.kind !== 'run' || (b.kind === 'run' && a.runId === b.runId));
export const artifactTargetIdentity = (target: ControlTarget): string => JSON.stringify([target.agentId, target.sessionKey, target.sessionId, target.lifecycleRevision ?? null, target.branchId ?? null]);
export const artifactQuery = (target: ControlTarget, scope: ControlArtifactScope): Record<string, unknown> => ({
  agentId: target.agentId, sessionKey: target.sessionKey, ...(scope.kind === 'run' ? { runId: scope.runId } : {}), messageRole: 'assistant',
});

export function nativeArtifactSummary(value: unknown, target: ControlTarget, scope: ControlArtifactScope): ControlArtifactSummary {
  const row = controlRecord(value); const download = controlRecord(row?.download);
  if (!row || !download || (row.sessionKey !== undefined && row.sessionKey !== target.sessionKey)
    || (scope.kind === 'run' && row.runId !== undefined && row.runId !== scope.runId)) throw new ControlError('invalid-source');
  const mode = download.mode === 'bytes' ? 'bytes' : download.mode === 'url' ? 'link' : download.mode === 'unsupported' ? 'unavailable' : null;
  const title = typeof row.title === 'string' ? row.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 512).replace(/[\ud800-\udbff]$/, '') : row.title;
  const summary = mode && parseControlArtifactSummary({ id: row.id, type: row.type, title, download: mode,
    ...(row.mimeType === undefined ? {} : { mimeType: row.mimeType }), ...(row.sizeBytes === undefined ? {} : { sizeBytes: row.sizeBytes }),
    ...(row.runId === undefined ? {} : { runId: row.runId }), ...(row.messageSeq === undefined ? {} : { messageSeq: row.messageSeq }) });
  if (!summary) throw new ControlError('invalid-source');
  return summary;
}
