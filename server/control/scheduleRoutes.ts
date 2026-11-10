import { Router, type Request, type Response } from 'express';
import { ControlError } from './errors';
import { GatewayRequestError } from './gatewayClient';
import type { ScheduleService } from './scheduleService';
import { controlRecord } from '../../shared/control';
import { parseScheduleIntent, parseScheduleSubmit } from '../../shared/controlSchedules';

export function createScheduleRouter(service: ScheduleService): Router {
  const router = Router({ mergeParams: true });
  function run(req: Request, res: Response, action: (signal: AbortSignal) => Promise<unknown>): void {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort); req.once('aborted', abort);
    void Promise.resolve().then(() => action(controller.signal)).then(value => { if (!controller.signal.aborted) res.json(value); }).catch(error => {
      if (controller.signal.aborted) return;
      const code = error instanceof ControlError || error instanceof GatewayRequestError ? error.code : 'unavailable';
      const status = code === 'invalid-target' ? 404 : code === 'invalid-request' ? 400 : code === 'schedule-changed' || code === 'schedule-outcome-unknown' ? 409
        : code === 'schedule-denied' || code === 'scope-required' || code === 'pairing-required' ? 403 : code === 'unsupported' ? 501 : 503;
      res.status(code === 'rate-limited' ? 429 : status).json({ code, error: code === 'schedule-changed' ? 'Schedules or this review changed. Inspect schedules and review again.'
        : code === 'schedule-outcome-unknown' ? 'The schedule outcome is unknown. Inspect native schedules; do not repeat creation.'
        : code === 'schedule-storage-unavailable' ? 'Schedule recovery storage is unavailable. Creation is disabled; inspect native schedules.' : 'The private schedule request could not be completed.' });
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
  const invalid = (res: Response) => res.status(400).json({ code: 'invalid-request', error: 'Invalid private schedule request.' });
  router.post<{ id: string }>('/prepare', (req, res) => {
    const body = controlRecord(req.body); const intent = body && Object.keys(body).length === 1 ? parseScheduleIntent(body.intent) : null;
    if (!intent || Object.keys(req.query).length) { invalid(res); return; }
    run(req, res, signal => service.prepare(String(req.params.id), intent, signal));
  });
  router.post<{ id: string }>('/submit', (req, res) => {
    const input = parseScheduleSubmit(req.body);
    if (!input || Object.keys(req.query).length) { invalid(res); return; }
    // Disconnect suppresses the HTTP response, never the admitted mutation or its durable recovery.
    run(req, res, () => service.submit(String(req.params.id), input));
  });
  router.post<{ id: string; operationId: string }>('/operations/:operationId/reconcile', (req, res) => {
    const body = controlRecord(req.body); const cursor = body?.cursor;
    if (!body || Object.keys(body).some(key => key !== 'cursor') || Object.keys(req.query).length
      || (cursor !== undefined && (typeof cursor !== 'string' || !cursor.trim() || cursor.length > 2048))
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.operationId)) { invalid(res); return; }
    run(req, res, signal => service.reconcile(String(req.params.id), req.params.operationId, cursor as string | undefined, signal));
  });
  return router;
}
