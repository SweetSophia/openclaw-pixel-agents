import { Router, type Request, type Response } from 'express';
import type { ControlConfig } from './config';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';
import { createControlAccess } from './access';
import { ControlError, type TaskService } from './taskService';
import { parseTaskRequest } from './validation';

export function createControlRouter(options: { gateway: ControlGateway; tasks: TaskService; config: ControlConfig }): Router {
  const { gateway, tasks, config } = options; const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/status', (_req, res, next) => { if (!config.enabled) { res.json(gateway.status()); return; } next(); });
  router.use(createControlAccess(config));
  router.get('/status', (_req, res) => res.json(gateway.status()));
  function run(req: Request, res: Response, action: (signal: AbortSignal) => Promise<unknown>): void {
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', close); req.once('aborted', close);
    void Promise.resolve().then(() => action(controller.signal)).then(result => { if (!controller.signal.aborted) res.json(result); }, error => {
      if (controller.signal.aborted) return;
      const code = error instanceof ControlError || error instanceof GatewayRequestError ? error.code : 'unavailable';
      const status = code === 'scope-required' ? 403 : code === 'invalid-request' ? 400 : code === 'invalid-target' ? 404 : code === 'session-changed' ? 409 : code === 'unsupported' ? 501 : 503;
      res.status(status).json({ code, error: code === 'session-changed' ? 'This conversation changed. Select it again.' : 'Task details could not be loaded.' });
    }).finally(() => { res.off('close', close); req.off('aborted', close); });
  }
  router.get('/agents/:id/sessions', (req, res) => {
    const cursor = req.query.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2048)) { res.status(400).json({ code: 'invalid-request', error: 'Invalid conversation cursor.' }); return; }
    run(req, res, signal => tasks.listSessions(String(req.params.id), cursor, signal));
  });
  router.post('/agents/:id/task', (req, res) => {
    const input = parseTaskRequest(String(req.params.id), req.body);
    if (!input) { res.status(400).json({ code: 'invalid-request', error: 'Invalid task selection.' }); return; }
    run(req, res, signal => tasks.getTask(input, signal));
  });
  return router;
}
