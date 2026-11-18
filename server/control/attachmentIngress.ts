import { performance } from 'node:perf_hooks';
import type { RequestHandler, Response } from 'express';
import { ATTACHMENT_LIMITS, parseAttachmentPrepareRequest } from '../../shared/controlAttachments';
import { parseAgentId } from '../../shared/agentRoster.cjs';
import type { AttachmentService } from './attachmentService';
import type { AttachmentLease } from './attachmentAdmission';
import { ControlError } from './errors';
import { GatewayRequestError } from './gatewayClient';

export function isAttachmentPreparationRequest(req: { method: string; originalUrl: string }): boolean {
  if (req.method !== 'POST') return false;
  const match = /^\/api\/control\/agents\/([A-Za-z0-9_-]{1,64})\/attachments\/prepare\/?$/.exec(req.originalUrl);
  if (!match) return false;
  try { parseAgentId(match[1]); return true; } catch { return false; }
}

export function attachmentFailure(res: Response, error: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const code = error instanceof ControlError || error instanceof GatewayRequestError ? error.code : 'unavailable';
  const status = code === 'invalid-request' || code === 'command-not-supported' ? 400
    : code === 'invalid-target' ? 404 : code === 'scope-required' || code === 'pairing-required' ? 403
      : code === 'file-too-large' ? 413 : code === 'preview-unsupported' ? 415
        : code === 'attachment-changed' || code === 'attachment-expired' ? 409
          : code === 'rate-limited' ? 429 : code === 'unsupported' ? 501 : 503;
  res.status(status).json({ code, error: 'The private image request could not be completed.' });
}

export function createAttachmentPreparationIngress(service: AttachmentService): RequestHandler {
  const budgets = new Map<string, { start: number; count: number }>();
  function admitted(ip: string): boolean {
    const now = performance.now();
    for (const [key, row] of budgets) if (now - row.start >= 60_000) budgets.delete(key);
    const row = budgets.get(ip);
    if (row) { if (row.count >= ATTACHMENT_LIMITS.preparationsPerMinute) return false; row.count++; }
    else { if (budgets.size >= 1000) return false; budgets.set(ip, { start: now, count: 1 }); }
    return true;
  }
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isAttachmentPreparationRequest(req)) { attachmentFailure(res, new ControlError('invalid-request')); return; }
    let lease: AttachmentLease;
    try { lease = service.acquirePreparation(String(req.params.id)); }
    catch (error) { attachmentFailure(res, error); return; }
    if (!admitted(req.ip || req.socket.remoteAddress || 'unknown')) { lease.release(); attachmentFailure(res, new ControlError('rate-limited')); return; }
    const encoding = req.headers['content-encoding'];
    if ((encoding !== undefined && encoding.trim().toLowerCase() !== 'identity')
      || !/^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i.test(req.headers['content-type'] ?? '')) {
      lease.release(); attachmentFailure(res, new ControlError('preview-unsupported')); return;
    }
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > ATTACHMENT_LIMITS.bodyBytes)) {
      lease.release(); attachmentFailure(res, new ControlError('file-too-large')); return;
    }
    const controller = new AbortController();
    let receiving = true, bytes = 0, chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      if (!receiving) return;
      releaseReceiving();
      res.setHeader('Connection', 'close');
      res.status(408).json({ code: 'attachment-expired', error: 'The private image request could not be completed.' });
      res.once('finish', () => req.destroy());
    }, ATTACHMENT_LIMITS.bodyTimeoutMs);
    timer.unref?.();
    function endBodyOwnership(): void {
      receiving = false; clearTimeout(timer); chunks = [];
      req.off('data', data); req.off('end', end);
    }
    function releaseReceiving(): void {
      if (receiving) { endBodyOwnership(); lease.release(); }
    }
    function cleanup(): void { req.off('aborted', abort); req.off('error', abort); res.off('close', abort); }
    function abort(): void {
      controller.abort(); releaseReceiving();
      // After handoff only the service may release preparing custody.
      cleanup();
    }
    function reject(error: ControlError): void {
      releaseReceiving(); cleanup(); res.setHeader('Connection', 'close'); attachmentFailure(res, error);
      res.once('finish', () => req.destroy());
    }
    function data(chunk: Buffer): void {
      bytes += chunk.length;
      if (bytes > ATTACHMENT_LIMITS.bodyBytes) { reject(new ControlError('file-too-large')); return; }
      chunks.push(chunk);
    }
    function end(): void {
      let input;
      try { input = parseAttachmentPrepareRequest(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))); }
      catch { reject(new ControlError('invalid-request')); return; }
      if (!input || input.target.agentId !== String(req.params.id)) { reject(new ControlError('invalid-request')); return; }
      endBodyOwnership();
      // prepare transfers the live receiving lease synchronously, before its first
      // await. Neither a body deadline nor HTTP cancellation owns it after this call.
      void service.prepare(String(req.params.id), input, lease, controller.signal)
        .then(review => { if (!controller.signal.aborted) res.json(review); })
        .catch(error => { if (!controller.signal.aborted) attachmentFailure(res, error); })
        .finally(cleanup);
    }
    req.once('aborted', abort); req.once('error', abort); res.once('close', abort);
    req.on('data', data); req.once('end', end);
  };
}
