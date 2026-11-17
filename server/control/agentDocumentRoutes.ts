import { Router, type Request, type Response } from 'express';
import { parseAgentDocumentReadRequest, parseAgentDocumentSaveRequest } from '../../shared/controlAgentDocuments';
import { ControlError } from './errors';
import { GatewayRequestError } from './gatewayClient';
import type { AgentDocumentService } from './agentDocumentService';

export function createAgentDocumentRouter(service: AgentDocumentService): Router {
  const router = Router({ mergeParams: true });
  function run(req: Request, res: Response, action: (signal: AbortSignal) => unknown | Promise<unknown>): void {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort); req.once('aborted', abort);
    void Promise.resolve().then(() => action(controller.signal)).then(value => { if (!controller.signal.aborted) res.json(value); }).catch(error => {
      if (controller.signal.aborted) return;
      const code = error instanceof ControlError || error instanceof GatewayRequestError ? error.code : 'unavailable';
      const status = code === 'invalid-request' ? 400 : code === 'invalid-target' || code === 'file-unavailable' ? 404
        : code === 'document-denied' || code === 'pairing-required' || code === 'scope-required' ? 403
          : code === 'document-changed' || code === 'document-outcome-unknown' ? 409 : code === 'rate-limited' ? 429
            : code === 'file-too-large' ? 413 : code === 'preview-unsupported' ? 415 : code === 'unsupported' ? 501 : 503;
      res.status(status).json({ code, error: 'The private agent document request could not be completed.' });
    }).finally(() => { res.off('close', abort); req.off('aborted', abort); });
  }
  const invalid = (res: Response) => res.status(400).json({ code: 'invalid-request', error: 'Invalid private agent document request.' });
  router.get<{ id: string }>('/status', (req, res) => {
    if (Object.keys(req.query).length) { invalid(res); return; }
    run(req, res, () => service.status(String(req.params.id)));
  });
  router.post<{ id: string }>('/read', (req, res) => {
    const input = parseAgentDocumentReadRequest(req.body);
    if (!input || Object.keys(req.query).length) { invalid(res); return; }
    run(req, res, signal => service.read(String(req.params.id), input, signal));
  });
  router.post<{ id: string }>('/save', (req, res) => {
    const input = parseAgentDocumentSaveRequest(req.body);
    if (!input || Object.keys(req.query).length) { invalid(res); return; }
    run(req, res, signal => service.save(String(req.params.id), input, signal));
  });
  return router;
}
