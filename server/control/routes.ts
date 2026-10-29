import { Router, type Request, type Response } from 'express';
import type { ControlConfig } from './config';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';
import { createControlAccess } from './access';
import { ControlError, type TaskService } from './taskService';
import { parseResultsTarget, parseSendRequest, parseTaskRequest } from './validation';
import type { SendService } from './sendService';
import type { ConversationService } from './conversation';
import { controlRecord } from '../../shared/control';
import { CONTROL_RESULT_LIMITS, parseControlExternalFile, parseControlFileRequest } from '../../shared/controlResults';
import type { ArtifactService } from './artifactService';
import type { ArtifactContent } from './artifactTransfer';
import { createContentBudget } from './contentBudget';
import { artifactMime, safeArtifactFilename } from './previewPolicy';
import type { WorkspaceService } from './workspaceService';
import { parseWorkspaceFileRequest, parseWorkspaceListRequest } from '../../shared/controlWorkspace';
import type { UsageService } from './usageService';
import { isControlRunId, parseRunHistoryRequest } from '../../shared/controlRunHistory';
import type { RunHistoryService } from './runHistoryService';
import { parseControlStopRequest } from '../../shared/controlRun';
import type { RunControlService } from './runControlService';
import { parseApprovalReadRequest, parseApprovalInspectRequest, parseApprovalResolveRequest } from '../../shared/controlApprovals';
import { ApprovalNotDispatchedError, type ApprovalService } from './approvalService';

export function createControlRouter(options: { gateway: ControlGateway; tasks: TaskService; config: ControlConfig; sends?: SendService; conversations?: ConversationService; artifacts?: ArtifactService; workspace?: WorkspaceService; usage?: UsageService; runHistory?: RunHistoryService; runControls?: RunControlService; approvals?: ApprovalService }): Router {
  const { gateway, tasks, config, sends, conversations, artifacts, workspace, usage, runHistory, runControls, approvals } = options; const router = Router();
  const contentBudget = createContentBudget();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/status', (_req, res, next) => { if (!config.enabled) { res.json(gateway.status()); return; } next(); });
  router.use(createControlAccess(config));
  router.get('/status', (_req, res) => res.json(gateway.status()));
  function run<T>(req: Request, res: Response, action: (signal: AbortSignal) => Promise<T>, success: (result: T) => void = result => { res.json(result); }): void {
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', close); req.once('aborted', close);
    void Promise.resolve().then(() => action(controller.signal)).then(result => { if (!controller.signal.aborted) success(result); }).catch(error => {
      if (controller.signal.aborted) return;
      if (res.headersSent) { res.destroy(); return; }
      res.removeHeader('X-Pixel-Control-File'); res.removeHeader('X-Pixel-Preview-Truncated'); res.removeHeader('Content-Disposition');
      const code = error instanceof ControlError || error instanceof GatewayRequestError ? error.code : 'unavailable';
      const status = code === 'scope-required' || code === 'pairing-required' || code === 'usage-denied' || code === 'stop-denied' || code === 'approvals-denied' ? 403 : code === 'invalid-request' || code === 'command-not-supported' ? 400
        : code === 'invalid-target' || code === 'file-unavailable' || code === 'approval-unavailable' ? 404 : code === 'file-too-large' ? 413 : code === 'preview-unsupported' ? 415
          : code === 'session-changed' || code === 'outcome-unknown' || code === 'workspace-changed' || code === 'approval-changed' || code === 'approval-outcome-unknown' ? 409 : code === 'unsupported' ? 501 : code === 'rate-limited' ? 429 : 503;
      res.type('json').status(status).json({ code, error: code === 'workspace-changed' ? 'This workspace selection changed. Refresh the directory.' : code === 'session-changed' ? 'This conversation changed. Select it again.' : 'The private request could not be completed.',
        ...(error instanceof ApprovalNotDispatchedError ? { approvalDisposition: error.approvalDisposition } : {}) });
    }).finally(() => { res.off('close', close); req.off('aborted', close); });
  }
  router.get('/agents/:id/sessions', (req, res) => {
    const cursor = req.query.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2048)) { res.status(400).json({ code: 'invalid-request', error: 'Invalid conversation cursor.' }); return; }
    run(req, res, signal => tasks.listSessions(String(req.params.id), cursor, signal));
  });
  for (const action of ['list', 'inspect', 'resolve'] as const) router.post(`/agents/:id/approvals/${action}`, (req, res) => {
    const input = action === 'list' ? parseApprovalReadRequest(req.body) : action === 'inspect' ? parseApprovalInspectRequest(req.body) : parseApprovalResolveRequest(req.body);
    if (!input || input.target.agentId !== String(req.params.id)) { res.status(400).json({ code: 'invalid-request', error: 'Invalid approval selection.' }); return; }
    run<unknown>(req, res, signal => {
      if (!config.approvalsEnabled) throw new ControlError('approvals-denied');
      if (!approvals) throw new ControlError('unsupported');
      if (action === 'list') return approvals.read(input.target, signal);
      if (action === 'inspect') return approvals.inspect(parseApprovalInspectRequest(req.body)!, signal);
      return approvals.resolve(parseApprovalResolveRequest(req.body)!, signal);
    });
  });
  router.post('/agents/:id/selection', (req, res) => {
    const body = controlRecord(req.body);
    if (!body || Object.keys(body).some(key => key !== 'sessionKey') || typeof body.sessionKey !== 'string'
      || !body.sessionKey || body.sessionKey.length > 512 || /[\u0000-\u001f\u007f]/.test(body.sessionKey)) {
      res.status(400).json({ code: 'invalid-request', error: 'Invalid conversation selection.' }); return;
    }
    run(req, res, async signal => ({ session: await tasks.resolveSession(String(req.params.id), body.sessionKey as string, signal) }));
  });
  router.post('/agents/:id/task', (req, res) => {
    const input = parseTaskRequest(String(req.params.id), req.body);
    if (!input) { res.status(400).json({ code: 'invalid-request', error: 'Invalid task selection.' }); return; }
    run(req, res, signal => tasks.getTask(input, signal));
  });
  router.post('/agents/:id/results', (req, res) => {
    const body = controlRecord(req.body); const selectedRunId = body?.runId;
    const target = body && (selectedRunId === undefined || isControlRunId(selectedRunId)) ? parseResultsTarget(String(req.params.id), Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'runId'))) : null;
    if (!target) { res.status(400).json({ code: 'invalid-request', error: 'Invalid result selection.' }); return; }
    run(req, res, signal => { if (!artifacts) throw new ControlError('unsupported'); return artifacts.read({ ...target, ...(selectedRunId ? { runId: selectedRunId as string } : {}) }, signal); });
  });
  router.post('/agents/:id/runs', (req, res) => {
    const input = parseRunHistoryRequest(String(req.params.id), req.body);
    if (!input) { res.status(400).json({ code: 'invalid-request', error: 'Invalid run history selection.' }); return; }
    run(req, res, signal => { if (!runHistory) throw new ControlError('unsupported'); return runHistory.read(input, signal); });
  });
  router.post('/agents/:id/usage', (req, res) => {
    const target = parseResultsTarget(String(req.params.id), req.body);
    if (!target) { res.status(400).json({ code: 'invalid-request', error: 'Invalid usage selection.' }); return; }
    run(req, res, signal => { if (!usage) throw new ControlError('unsupported'); return usage.read(target, signal); });
  });
  router.post('/agents/:id/results/file', contentBudget, (req, res) => {
    const input = parseControlFileRequest(req.body);
    if (!input || input.target.agentId !== String(req.params.id)) { res.status(400).json({ code: 'invalid-request', error: 'Invalid file selection.' }); return; }
    run(req, res, signal => { if (!artifacts) throw new ControlError('unsupported'); return artifacts.file(input, signal); }, content => sendFile(res, content, input.intent));
  });
  router.post('/agents/:id/workspace', (req, res) => {
    const input = parseWorkspaceListRequest(req.body);
    if (!input) { res.status(400).json({ code: 'invalid-request', error: 'Invalid workspace directory.' }); return; }
    run(req, res, signal => { if (!workspace) throw new ControlError('unsupported'); return workspace.list(String(req.params.id), input, signal); });
  });
  router.post('/agents/:id/workspace/file', contentBudget, (req, res) => {
    const input = parseWorkspaceFileRequest(req.body);
    if (!input) { res.status(400).json({ code: 'invalid-request', error: 'Invalid workspace file.' }); return; }
    run(req, res, signal => { if (!workspace) throw new ControlError('unsupported'); return workspace.file(String(req.params.id), input, signal); }, content => sendFile(res, content, input.intent));
  });
  function sendFile(res: Response, content: ArtifactContent, intent: 'preview' | 'download'): void {
    if (content.kind === 'external') {
      const link = parseControlExternalFile(content); if (!link) throw new ControlError('invalid-source');
      res.setHeader('X-Pixel-Control-File', 'link'); res.json(link); return;
    }
    if (!(content.data instanceof Uint8Array)) throw new ControlError('invalid-source');
    if (content.data.byteLength > CONTROL_RESULT_LIMITS.transferBytes) throw new ControlError('file-too-large');
    const filename = safeArtifactFilename(content.filename);
    const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    const fallback = filename.replace(/[^\x20-\x7e]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Content-Type', intent === 'preview' && content.mimeType.startsWith('text/plain') ? 'text/plain; charset=utf-8' : artifactMime(content.mimeType));
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Pixel-Control-File', 'bytes');
    if (intent === 'preview' && content.truncated) res.setHeader('X-Pixel-Preview-Truncated', 'true');
    res.send(Buffer.from(content.data.buffer, content.data.byteOffset, content.data.byteLength));
  }
  router.post('/agents/:id/send', (req, res) => {
    const input = parseSendRequest(String(req.params.id), req.body);
    if (!input) { res.status(400).json({ code: 'invalid-request', error: 'Invalid submission.' }); return; }
    run(req, res, signal => { if (!config.sendEnabled || !sends) throw new ControlError('scope-required'); return sends.send(input, signal); });
  });
  router.post('/agents/:id/stop', (req, res) => {
    const input = parseControlStopRequest(req.body);
    if (!input || input.target.agentId !== String(req.params.id)) { res.status(400).json({ code: 'invalid-request', error: 'Invalid Stop selection.' }); return; }
    run(req, res, signal => {
      if (!config.sendEnabled) throw new ControlError('scope-required');
      if (!runControls) throw new ControlError('unsupported');
      return runControls.stop(input, signal);
    });
  });
  router.post('/agents/:id/history', (req, res) => {
    const input = parseTaskRequest(String(req.params.id), req.body);
    if (!input) { res.status(400).json({ code: 'invalid-request', error: 'Invalid conversation selection.' }); return; }
    run(req, res, signal => { if (!conversations) throw new ControlError('unsupported'); return conversations.history(input, input.cursor, signal); });
  });
  return router;
}
