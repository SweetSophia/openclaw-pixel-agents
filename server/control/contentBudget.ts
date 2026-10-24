import type { Request, RequestHandler } from 'express';

export const isResultContentRequest = (req: Pick<Request, 'method' | 'path'>): boolean => req.method === 'POST' && /^\/agents\/[^/]+\/results\/file\/?$/i.test(req.path);
export function createContentBudget(): RequestHandler {
  const clients = new Map<string, { start: number; count: number; active: number }>();
  return (req, res, next) => {
    const now = Date.now(); const ip = req.ip || req.socket.remoteAddress || 'unknown';
    for (const [key, entry] of clients) if (!entry.active && now - entry.start >= 60000) clients.delete(key);
    let row = clients.get(ip);
    if (row && now - row.start >= 60000) { row.start = now; row.count = 0; }
    if (!row && clients.size < 1000) { row = { start: now, count: 0, active: 0 }; clients.set(ip, row); }
    if (!row || row.active >= 2 || row.count >= 6) {
      res.setHeader('Retry-After', row && row.count >= 6 ? Math.max(1, Math.ceil((60000 - (now - row.start)) / 1000)) : 1);
      res.status(429).json({ code: 'rate-limited', error: 'Too many file requests. Wait before retrying.' }); return;
    }
    const admitted = row; admitted.count++; admitted.active++; let released = false;
    const release = () => {
      if (released) return; released = true; admitted.active--;
      res.off('finish', release); res.off('close', release); res.off('error', release); req.off('aborted', release); req.off('error', release);
    };
    res.once('finish', release); res.once('close', release); res.once('error', release); req.once('aborted', release); req.once('error', release);
    next();
  };
}
