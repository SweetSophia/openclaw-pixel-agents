import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { RequestHandler } from 'express';
import type { ControlConfig } from './config';

export function matchesControlToken(supplied: string, configured: string): boolean {
  if (!supplied || supplied.length > 4096) return false;
  const digest = (value: string) => createHmac('sha256', value).update('pixel-control-access-v1').digest();
  return timingSafeEqual(digest(supplied), digest(configured));
}
const address = (value = '') => value.toLowerCase().replace(/^::ffff:/, '');
const loopback = (value: string) => value === '::1' || (isIP(value) === 4 && value.startsWith('127.'));
function tailnet(value: string): boolean {
  if (isIP(value) === 6) return value.startsWith('fd7a:115c:a1e0:');
  const octets = value.split('.').map(Number);
  return isIP(value) === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}
export function controlTransportAllowed(
  req: { secure?: boolean; socket: { localAddress?: string; remoteAddress?: string } }, allowTailnetHttp: boolean,
  interfaces: Record<string, { address: string }[] | undefined> = networkInterfaces(),
): boolean {
  if (req.secure) return true;
  const local = address(req.socket.localAddress); const peer = address(req.socket.remoteAddress);
  if (loopback(local) && loopback(peer)) return true;
  return allowTailnetHttp && tailnet(peer) && Boolean(interfaces.tailscale0?.some(entry => address(entry.address) === local));
}
export function createControlAccess(config: ControlConfig): RequestHandler {
  const failed = new Map<string, { start: number; count: number }>(); const reads = new Map<string, { start: number; count: number }>();
  function budget(map: typeof failed, ip: string, maximum: number, consume: boolean): boolean {
    const now = Date.now();
    for (const [key, value] of map) if (now - value.start >= 60000) map.delete(key);
    let row = map.get(ip);
    if (!row) { if (map.size >= 1000) return false; if (consume) { row = { start: now, count: 0 }; map.set(ip, row); } }
    if (!row) return true;
    if (row.count >= maximum) return false;
    if (consume) row.count++;
    return true;
  }
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!config.enabled) { res.status(503).json({ code: 'disabled', error: 'Task access is not configured.' }); return; }
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!budget(failed, ip, 60, false)) { res.status(429).json({ code: 'rate-limited', error: 'Too many access attempts.' }); return; }
    if (!controlTransportAllowed(req, config.allowTailnetHttp)) {
      budget(failed, ip, 60, true); res.status(403).json({ code: 'transport-required', error: 'Task access requires a secure connection.' }); return;
    }
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !matchesControlToken(auth.slice(7), config.controlToken!)) {
      budget(failed, ip, 60, true); res.status(401).json({ code: 'locked', error: 'Unlock task details to continue.' }); return;
    }
    if (!budget(reads, ip, 120, true)) { res.status(429).json({ code: 'rate-limited', error: 'Too many task requests.' }); return; }
    next();
  };
}
