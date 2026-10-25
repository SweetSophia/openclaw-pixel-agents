import { randomUUID } from 'node:crypto';
import { controlRecord } from '../../shared/control';
import { WORKSPACE_LIMITS, parseWorkspaceFileRequest, parseWorkspaceListRequest, parseWorkspacePage, workspaceFileLimit, workspaceParent,
  type WorkspaceFileRequest, type WorkspaceListRequest, type WorkspacePage } from '../../shared/controlWorkspace';
import type { ArtifactContent } from './artifactTransfer';
import { ControlError } from './errors';
import type { ControlGateway } from './gatewayClient';
import { previewContent, safeArtifactFilename } from './previewPolicy';

export interface WorkspaceService {
  list(agentId: string, input: WorkspaceListRequest, signal?: AbortSignal): Promise<WorkspacePage>;
  file(agentId: string, input: WorkspaceFileRequest, signal?: AbortSignal): Promise<ArtifactContent>;
  close(): void;
}
export function createWorkspaceService(gateway: ControlGateway, registeredAgentIds: () => ReadonlySet<string>): WorkspaceService {
  let revision = randomUUID(); let closed = false;
  const unsubscribe = gateway.onEvent(event => { if (['source.invalidated', 'source.ready', 'agents.changed', 'config.changed'].includes(event.event)) revision = randomUUID(); });
  function guard(agentId: string, expected: string, signal?: AbortSignal): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agentId) || !registeredAgentIds().has(agentId)) throw new ControlError('invalid-target');
    if (closed || signal?.aborted) throw new ControlError('unavailable');
    const status = gateway.status();
    if (status.state === 'pairing-required') throw new ControlError('pairing-required');
    if (status.state === 'auth-error') throw new ControlError('scope-required');
    if (!status.canRead) throw new ControlError('unavailable');
    if (expected !== revision) throw new ControlError('workspace-changed');
  }
  async function list(agentId: string, input: WorkspaceListRequest, signal?: AbortSignal): Promise<WorkspacePage> {
    const selection = parseWorkspaceListRequest(input); if (!selection) throw new ControlError('invalid-request');
    const current = revision; guard(agentId, current, signal);
    const raw = controlRecord(await gateway.request('agents.workspace.list', { agentId, ...selection, limit: WORKSPACE_LIMITS.pageSize }, signal));
    guard(agentId, current, signal);
    if (!raw || raw.agentId !== agentId || raw.path !== selection.path) throw new ControlError('invalid-source');
    if (raw.offset !== selection.offset) throw new ControlError('workspace-changed');
    const page = parseWorkspacePage({ agentId: raw.agentId, path: raw.path, offset: raw.offset, totalEntries: raw.totalEntries,
      entries: Array.isArray(raw.entries) ? raw.entries.map(value => {
        const row = controlRecord(value); return row ? { path: row.path, name: row.name, kind: row.kind, size: row.size, updatedAtMs: row.updatedAtMs } : null;
      }) : raw.entries, source: { state: 'current', observedAt: Date.now() }, sourceRevision: current });
    if (!page) throw new ControlError('invalid-source'); return page;
  }
  return {
    list,
    async file(agentId, input, signal) {
      const selected = parseWorkspaceFileRequest(input); if (!selected) throw new ControlError('invalid-request');
      guard(agentId, selected.sourceRevision, signal);
      const page = await list(agentId, { path: workspaceParent(selected.path), offset: selected.offset }, signal);
      guard(agentId, selected.sourceRevision, signal);
      const entry = page.entries.find(row => row.path === selected.path && row.kind === 'file');
      if (!entry || entry.size === undefined || entry.updatedAtMs === undefined || entry.size !== selected.expected.size || entry.updatedAtMs !== selected.expected.updatedAtMs) throw new ControlError('workspace-changed');
      const limit = workspaceFileLimit(entry.path); if (entry.size > limit) throw new ControlError('file-too-large');
      const raw = controlRecord(await gateway.request('agents.workspace.get', { agentId, path: selected.path }, signal));
      guard(agentId, selected.sourceRevision, signal);
      const file = controlRecord(raw?.file);
      if (!raw || raw.agentId !== agentId || !file || file.path !== entry.path || file.name !== entry.name) throw new ControlError('invalid-source');
      if (file.size !== entry.size || file.updatedAtMs !== entry.updatedAtMs) throw new ControlError('workspace-changed');
      if (typeof file.content !== 'string' || typeof file.mimeType !== 'string') throw new ControlError('invalid-source');
      let data: Buffer;
      if (file.encoding === 'utf8' && file.mimeType === 'text/plain') {
        data = Buffer.from(file.content, 'utf8'); if (data.toString('utf8') !== file.content) throw new ControlError('invalid-source');
      } else if (file.encoding === 'base64' && /^image\/(png|jpeg|webp|gif|avif|bmp|heic|heif)$/.test(file.mimeType)) {
        if (file.content.length > Math.ceil(limit / 3) * 4) throw new ControlError('file-too-large');
        data = Buffer.from(file.content, 'base64'); if (data.toString('base64') !== file.content) throw new ControlError('invalid-source');
      } else throw new ControlError('preview-unsupported');
      if (data.byteLength > limit || (file.encoding === 'utf8' && data.byteLength > WORKSPACE_LIMITS.textBytes)) throw new ControlError('file-too-large');
      if (data.byteLength !== entry.size) throw new ControlError('workspace-changed');
      const content = selected.intent === 'preview' ? previewContent(data, file.mimeType) : { data, mimeType: file.mimeType, truncated: false };
      guard(agentId, selected.sourceRevision, signal);
      return { kind: 'bytes', ...content, filename: safeArtifactFilename(entry.name) };
    },
    close() { closed = true; revision = randomUUID(); unsubscribe(); },
  };
}
