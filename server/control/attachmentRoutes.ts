import { Router, type Request, type Response } from 'express';
import { parseAttachmentConfirmRequest, parseAttachmentOperationRequest } from '../../shared/controlAttachments';
import { attachmentFailure, createAttachmentPreparationIngress } from './attachmentIngress';
import type { AttachmentService } from './attachmentService';
import { ControlError } from './errors';

export function createAttachmentRouter(service: AttachmentService): Router {
  const router = Router({ mergeParams: true });
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  function run(req: Request, res: Response, action: (signal: AbortSignal) => unknown | Promise<unknown>): void {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort); req.once('aborted', abort);
    void Promise.resolve().then(() => action(controller.signal)).then(value => { if (!controller.signal.aborted) res.json(value); })
      .catch(error => { if (!controller.signal.aborted) attachmentFailure(res, error); })
      .finally(() => { res.off('close', abort); req.off('aborted', abort); });
  }
  router.use((req, res, next) => {
    if (Object.keys(req.query).length) { attachmentFailure(res, new ControlError('invalid-request')); return; }
    next();
  });
  router.get<{ id: string }>('/status', (req, res) => run(req, res, () => service.status(String(req.params.id))));
  router.post('/prepare', createAttachmentPreparationIngress(service));
  router.post<{ id: string }>('/confirm', (req, res) => {
    const input = parseAttachmentConfirmRequest(req.body);
    if (!input) { attachmentFailure(res, new ControlError('invalid-request')); return; }
    // Disconnecting the HTTP observer never cancels an admitted confirmation.
    run(req, res, () => service.confirm(String(req.params.id), input));
  });
  for (const action of ['receipt', 'discard'] as const) router.post<{ id: string }>(`/${action}`, (req, res) => {
    const input = parseAttachmentOperationRequest(req.body);
    if (!input) { attachmentFailure(res, new ControlError('invalid-request')); return; }
    run(req, res, signal => {
      if (action === 'receipt') return service.receipt(String(req.params.id), input, signal);
      service.discard(String(req.params.id), input); return { ok: true };
    });
  });
  return router;
}
