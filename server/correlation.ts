import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { logger, type Logger } from "./logger";

const REQUEST_ID_HEADER = "X-Request-Id";
const REQUEST_ID_HEADER_KEY = REQUEST_ID_HEADER.toLowerCase();
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
  const raw = headers[REQUEST_ID_HEADER_KEY];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string" && SAFE_ID.test(value)) return value;
  return randomUUID();
}

declare module "express-serve-static-core" {
  interface Request {
    id?: string;
    log?: Logger;
  }
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = pickRequestId(req.headers);
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
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
 *
 * The middleware is self-sufficient: if `correlationMiddleware` was not
 * mounted first, it still assigns a request id (re-using the trusted-header
 * validation path) and echoes it on the response so the request log is never
 * correlated to `undefined`.
 *
 * Query strings are intentionally excluded from the `url` field to bound log
 * cardinality — high-entropy / sensitive values belong in their own log line,
 * not on every request completion record.
 */
export function httpRequestLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.id) {
    const id = pickRequestId(req.headers);
    req.id = id;
    res.setHeader(REQUEST_ID_HEADER, id);
  }

  const startedAt = process.hrtime.bigint();
  // Strip any query string from the req.url fallback so high-entropy /
  // sensitive values never leak into the per-request child log bindings.
  // `req.path` is set by the Express router; only fall back to `req.url`
  // when it is missing.
  const pathLike = req.path ?? (req.url ?? "").split("?")[0] ?? "";
  const pathname = (req.baseUrl ?? "") + pathLike;
  const child = logger.child({ reqId: req.id, method: req.method, url: pathname });
  req.log = child;

  res.once("close", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const status = res.statusCode;
    const fields = { status, durationMs: Number(durationMs.toFixed(2)) };
    if (!res.writableFinished) child.warn(fields, "request aborted");
    else if (status >= 500) child.error(fields, "request failed");
    else if (status >= 400) child.warn(fields, "request rejected");
    else child.info(fields, "request completed");
  });

  next();
}
