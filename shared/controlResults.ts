import { CONTROL_LIMITS, controlByteSize, controlRecord, parseControlMessage, parseControlTarget,
  type ControlMessage, type ControlRunState, type ControlSource, type ControlTarget } from './control';

export const CONTROL_RESULT_LIMITS = {
  artifacts: 100, metadataSelections: 32, metadataExpiryMs: 60000, metadataReuseMs: 2000,
  previewBytes: 256 * 1024, transferBytes: 16 * 1024 * 1024,
  imageBytes: 8 * 1024 * 1024, imagePixels: 16000000, contentDeadlineMs: 30000,
} as const;
export type ControlArtifactScope = { kind: 'run'; runId: string } | { kind: 'conversation' };
export interface ControlArtifactSummary {
  id: string; type: string; title: string; mimeType?: string; sizeBytes?: number;
  runId?: string; messageSeq?: number; download: 'bytes' | 'link' | 'unavailable';
}
export interface ControlResultsSnapshot {
  target: ControlTarget; scope: ControlArtifactScope; source: ControlSource; sourceRevision: string; runState: ControlRunState;
  responseKind: 'result' | 'latest' | 'none'; response?: ControlMessage;
  artifactState: 'ready' | 'unsupported' | 'unavailable'; artifacts: ControlArtifactSummary[]; artifactsTruncated: boolean;
}
export interface ControlFileRequest {
  target: ControlTarget; scope: ControlArtifactScope; artifactId: string; intent: 'preview' | 'download';
}
export interface ControlExternalFile { kind: 'external'; url: string; host: string; title: string }

export function controlPreviewKind(mimeType = ''): 'text' | 'image' | null {
  const mime = mimeType.split(';')[0].trim().toLowerCase();
  if (['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return 'image';
  if (['text/html', 'application/xhtml+xml', 'image/svg+xml'].includes(mime)) return null;
  return mime.startsWith('text/') || /^application\/(json|[^/]+\+json|javascript|x-javascript|typescript|xml|[^/]+\+xml|toml|yaml|x-yaml)$/.test(mime) ? 'text' : null;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const record = controlRecord(value);
  return record && Object.keys(record).every(key => keys.includes(key)) ? record : null;
}
function opaque(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.includes(value as T);
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const targetKeys = ['agentId', 'sessionKey', 'sessionId', 'lifecycleRevision', 'branchId', 'activeLeafEntryId'];
const target = (value: unknown) => exact(value, targetKeys) && parseControlTarget(value);
function scope(value: unknown): ControlArtifactScope | null {
  const record = controlRecord(value);
  if (record?.kind === 'conversation' && exact(record, ['kind'])) return { kind: 'conversation' };
  if (record?.kind === 'run' && exact(record, ['kind', 'runId']) && opaque(record.runId, 256)) return { kind: 'run', runId: record.runId };
  return null;
}
function source(value: unknown): ControlSource | null {
  const record = exact(value, ['state', 'observedAt']);
  return record && oneOf(record.state, ['current', 'stale']) && typeof record.observedAt === 'number'
    && Number.isFinite(record.observedAt) && record.observedAt >= 0 && record.observedAt <= Number.MAX_SAFE_INTEGER
    ? { state: record.state, observedAt: record.observedAt } : null;
}
export function parseControlArtifactSummary(value: unknown): ControlArtifactSummary | null {
  const record = exact(value, ['id', 'type', 'title', 'mimeType', 'sizeBytes', 'runId', 'messageSeq', 'download']);
  if (!record || !opaque(record.id, 512) || !opaque(record.type, 64) || !opaque(record.title, 512)
    || !oneOf(record.download, ['bytes', 'link', 'unavailable'])
    || (record.mimeType !== undefined && !opaque(record.mimeType, 128))
    || (record.sizeBytes !== undefined && !integer(record.sizeBytes))
    || (record.runId !== undefined && !opaque(record.runId, 256))
    || (record.messageSeq !== undefined && !integer(record.messageSeq))) return null;
  return { id: record.id, type: record.type, title: record.title, download: record.download,
    ...(record.mimeType === undefined ? {} : { mimeType: record.mimeType as string }),
    ...(record.sizeBytes === undefined ? {} : { sizeBytes: record.sizeBytes as number }),
    ...(record.runId === undefined ? {} : { runId: record.runId as string }),
    ...(record.messageSeq === undefined ? {} : { messageSeq: record.messageSeq as number }) };
}
export function parseControlResultsSnapshot(value: unknown): ControlResultsSnapshot | null {
  if (controlByteSize(value) > CONTROL_LIMITS.responseBytes) return null;
  const record = exact(value, ['target', 'scope', 'source', 'sourceRevision', 'runState', 'responseKind', 'response', 'artifactState', 'artifacts', 'artifactsTruncated']);
  if (!record) return null;
  const parsedTarget = target(record.target); const parsedScope = scope(record.scope); const parsedSource = source(record.source);
  if (!parsedTarget || !parsedScope || !parsedSource || !opaque(record.sourceRevision, 128) || !oneOf(record.runState, ['running', 'completed', 'failed', 'aborted', 'not-running', 'unknown'])
    || !oneOf(record.responseKind, ['result', 'latest', 'none']) || !oneOf(record.artifactState, ['ready', 'unsupported', 'unavailable'])
    || typeof record.artifactsTruncated !== 'boolean' || !Array.isArray(record.artifacts) || record.artifacts.length > CONTROL_RESULT_LIMITS.artifacts) return null;
  const parsedResponse = record.response === undefined ? undefined : exact(record.response, ['id', 'role', 'text', 'truncated', 'at', 'runId', 'messageSeq', 'submissionId']) && parseControlMessage(record.response);
  if ((record.response !== undefined && (!parsedResponse || parsedResponse.role !== 'assistant'))
    || (record.responseKind === 'none' ? record.response !== undefined : !parsedResponse)
    || (record.responseKind === 'result' && record.runState !== 'completed')) return null;
  const artifacts: ControlArtifactSummary[] = [];
  for (const item of record.artifacts) {
    const parsed = parseControlArtifactSummary(item);
    if (!parsed || (parsedScope.kind === 'run' && parsed.runId !== undefined && parsed.runId !== parsedScope.runId)) return null;
    artifacts.push(parsed);
  }
  return { target: parsedTarget, scope: parsedScope, source: parsedSource, sourceRevision: record.sourceRevision, runState: record.runState,
    responseKind: record.responseKind, ...(parsedResponse ? { response: parsedResponse } : {}),
    artifactState: record.artifactState, artifacts, artifactsTruncated: record.artifactsTruncated };
}
export function parseControlFileRequest(value: unknown): ControlFileRequest | null {
  if (controlByteSize(value) > CONTROL_LIMITS.responseBytes) return null;
  const record = exact(value, ['target', 'scope', 'artifactId', 'intent']); if (!record) return null;
  const parsedTarget = target(record.target); const parsedScope = scope(record.scope);
  return parsedTarget && parsedScope && opaque(record.artifactId, 512) && oneOf(record.intent, ['preview', 'download'])
    ? { target: parsedTarget, scope: parsedScope, artifactId: record.artifactId, intent: record.intent } : null;
}
export function parseControlExternalFile(value: unknown): ControlExternalFile | null {
  const record = exact(value, ['kind', 'url', 'host', 'title']);
  if (!record || record.kind !== 'external' || !opaque(record.url, 4096) || !opaque(record.title, 512)) return null;
  try {
    const url = new URL(record.url);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.host && record.host === url.host
      ? { kind: 'external', url: url.href, host: url.host, title: record.title } : null;
  } catch { return null; }
}
