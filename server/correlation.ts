import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";

const REQUEST_ID_HEADER = "x-request-id";
const SAFE_ID = /^[a-zA-Z0-9_.\-]{1,128}$/;

/**
 * Extract a request correlation id from the incoming `X-Request-Id` header,
 * validating that it is a safe opaque token (alphanumeric + a few separators,
 * max 128 chars) to prevent log injection. Falls back to a fresh UUID when
 * the header is absent or invalid.
 *
 * The id is stored on `req.id` and echoed on the response header so callers
 * can correlate logs across the system.
 */
export function pickRequestId(headers: NodeJS.Dict<string | string[]>): string {
  const raw = headers[REQUEST_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string" && SAFE_ID.test(value)) return value;
  return randomUUID();
}

declare module "express-serve-static-core" {
  interface Request {
    id?: string;
  }
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = pickRequestId(req.headers);
  req.id = id;
  res.setHeader("X-Request-Id", id);
  next();
}

/**
 * Minimal HTTP request logger.
 *
 * pino-http was avoided because its type declarations augment Node's
 * `http.IncomingMessage` in a way that breaks Express 4 + @types/express 5
 * overload resolution. This middleware keeps the same operational contract
 * (one structured log line per request, with `reqId`/`method`/`url`/`status`
 * and response time) without disturbing the wider middleware chain.
 */
export function httpRequestLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  const child = logger.child({ reqId: req.id, method: req.method, url: req.originalUrl ?? req.url });

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const status = res.statusCode;
    const fields = { status, durationMs: Number(durationMs.toFixed(2)) };
    if (status >= 500) child.error(fields, "request failed");
    else if (status >= 400) child.warn(fields, "request rejected");
    else child.info(fields, "request completed");
  });

  next();
}