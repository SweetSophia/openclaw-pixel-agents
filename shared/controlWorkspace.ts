import { CONTROL_LIMITS, controlByteSize, controlRecord, type ControlSource } from './control';

export const WORKSPACE_LIMITS = { pageSize: 50, maxOffset: 10000, pathCharacters: 2048, textBytes: 256 * 1024, imageBytes: 1024 * 1024 } as const;
export interface WorkspaceEntry { path: string; name: string; kind: 'file' | 'directory'; size?: number; updatedAtMs?: number }
export interface WorkspaceListRequest { path: string; offset: number }
export interface WorkspacePage extends WorkspaceListRequest { agentId: string; entries: WorkspaceEntry[]; totalEntries: number; source: ControlSource; sourceRevision: string }
export interface WorkspaceFileRequest extends WorkspaceListRequest {
  sourceRevision: string; expected: { size: number; updatedAtMs: number }; intent: 'preview' | 'download';
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const closed = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const revision = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007f-\u009f]/.test(value);
export function isWorkspacePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= WORKSPACE_LIMITS.pathCharacters && !/[\\\u0000-\u001f\u007f-\u009f]/.test(value)
    && !/^[A-Za-z]:/.test(value) && (value === '' || value.split('/').every(part => !!part && part !== '.' && part !== '..'));
}
export function workspaceParent(path: string): string { const slash = path.lastIndexOf('/'); return slash < 0 ? '' : path.slice(0, slash); }
export function workspaceFileLimit(path: string): number {
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(path) ? WORKSPACE_LIMITS.imageBytes : WORKSPACE_LIMITS.textBytes;
}
export function parseWorkspaceListRequest(value: unknown): WorkspaceListRequest | null {
  const input = controlRecord(value); if (!input || !closed(input, ['path', 'offset'])) return null;
  const path = input.path ?? ''; const offset = input.offset ?? 0;
  return isWorkspacePath(path) && integer(offset) && offset <= WORKSPACE_LIMITS.maxOffset ? { path, offset } : null;
}
export function parseWorkspaceFileRequest(value: unknown): WorkspaceFileRequest | null {
  const input = controlRecord(value); if (!input || !closed(input, ['path', 'offset', 'sourceRevision', 'expected', 'intent'])) return null;
  const page = parseWorkspaceListRequest({ path: input.path, offset: input.offset }); const expected = controlRecord(input.expected);
  if (!page?.path || !revision(input.sourceRevision) || !expected || !closed(expected, ['size', 'updatedAtMs']) || !integer(expected.size)
    || !integer(expected.updatedAtMs) || (input.intent !== 'preview' && input.intent !== 'download')) return null;
  return { ...page, sourceRevision: input.sourceRevision, expected: { size: expected.size, updatedAtMs: expected.updatedAtMs }, intent: input.intent };
}
export function parseWorkspacePage(value: unknown): WorkspacePage | null {
  const input = controlRecord(value); if (!input || controlByteSize(input) > CONTROL_LIMITS.responseBytes
    || !closed(input, ['agentId', 'path', 'offset', 'totalEntries', 'entries', 'source', 'sourceRevision'])) return null;
  const page = parseWorkspaceListRequest({ path: input.path, offset: input.offset }); const source = controlRecord(input.source);
  if (!page || typeof input.agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.agentId) || !revision(input.sourceRevision)
    || !source || !closed(source, ['state', 'observedAt']) || !integer(source.observedAt) || !['current', 'stale'].includes(String(source.state))
    || !integer(input.totalEntries) || !Array.isArray(input.entries) || input.entries.length > WORKSPACE_LIMITS.pageSize
    || page.offset + input.entries.length > input.totalEntries) return null;
  const entries: WorkspaceEntry[] = []; const paths = new Set<string>();
  for (const raw of input.entries) {
    const row = controlRecord(raw);
    if (!row || !closed(row, ['path', 'name', 'kind', 'size', 'updatedAtMs']) || !isWorkspacePath(row.path) || !row.path || workspaceParent(row.path) !== page.path
      || typeof row.name !== 'string' || row.name !== row.path.slice(row.path.lastIndexOf('/') + 1) || (row.kind !== 'file' && row.kind !== 'directory')
      || (row.size !== undefined && !integer(row.size)) || (row.updatedAtMs !== undefined && !integer(row.updatedAtMs)) || paths.has(row.path)) return null;
    paths.add(row.path); entries.push({ path: row.path, name: row.name, kind: row.kind,
      ...(row.size === undefined ? {} : { size: row.size as number }), ...(row.updatedAtMs === undefined ? {} : { updatedAtMs: row.updatedAtMs as number }) });
  }
  return { ...page, agentId: input.agentId, entries, totalEntries: input.totalEntries,
    source: { state: source.state as ControlSource['state'], observedAt: source.observedAt }, sourceRevision: input.sourceRevision };
}
