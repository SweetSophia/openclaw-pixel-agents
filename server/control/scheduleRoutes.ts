import { Router, type Request, type Response } from 'express';
import { ControlError } from './errors';
import { GatewayRequestError } from './gatewayClient';
import type { ScheduleService } from './scheduleService';

export function createScheduleRouter(service: ScheduleService): Router {
  const router = Router({ mergeParams: true });
  function run(req: Request, res: Response, action: (signal: AbortSignal) => Promise<unknown>): void {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort); req.once('aborted', abort);
    void Promise.resolve().then(() => action(controller.signal)).then(value => { if (!controller.signal.aborted) res.json(value); }).catch(error => {
      if (controller.signal.aborted) return;
      const code = error instanceof ControlError || error instanceof GatewayRequestError ? error.code : 'unavailable';
      const status = code === 'invalid-target' ? 404 : code === 'invalid-request' ? 400 : code === 'schedule-changed' ? 409
        : code === 'schedule-denied' || code === 'scope-required' || code === 'pairing-required' ? 403 : code === 'unsupported' ? 501 : 503;
      res.status(status).json({ code, error: code === 'schedule-changed' ? 'Schedules changed or this browse expired. Refresh the schedules.' : 'The private schedule request could not be completed.' });
    }).finally(() => { res.off('close', abort); req.off('aborted', abort); });
  }
  router.get<{ id: string }>('/', (req, res) => {
    const cursor = req.query.cursor;
    if (Object.keys(req.query).some(key => key !== 'cursor') || (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2048))) {
      res.status(400).json({ code: 'invalid-request', error: 'Invalid schedule cursor.' }); return;
    }
    run(req, res, signal => service.read(String(req.params.id), cursor as string | undefined, signal));
  });
  router.get<{ id: string }>('/operations', (req, res) => {
    const cursor = req.query.cursor;
    if (Object.keys(req.query).some(key => key !== 'cursor') || (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2048))) {
      res.status(400).json({ code: 'invalid-request', error: 'Invalid recovery cursor.' }); return;
    }
    run(req, res, () => service.operations(String(req.params.id), cursor as string | undefined));
  });
  return router;
}
