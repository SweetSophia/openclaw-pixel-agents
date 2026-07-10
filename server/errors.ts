import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { logger } from "./logger";

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>;

export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export const apiErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  // Use the per-request child logger if available, otherwise fall back to the base logger.
  const log = req.log ?? logger;
  log.error({ err, reqId: req.id }, "[api error]");
  res.status(500).json({ error: "Internal server error" });
};

/**
 * Normalize an `unhandledRejection` reason so pino's `{ err }` serializer
 * can extract type/stack/message consistently.
 *
 * - Error reasons pass through (their identity is preserved so stack traces
 *   remain intact).
 * - null/undefined fall back to a stable message.
 * - Everything else is stringified, but the original reason is retained on
 *   `Error.cause` so structured dumps can still reconstruct what came down
 *   the pipe (otherwise `new Error(String({foo: 1}))` loses to `[object Object]`).
 */
export function handleUnhandledRejection(reason: unknown): void {
  const err =
    reason instanceof Error
      ? reason
      : new Error(reason == null ? "unknown rejection" : String(reason), { cause: reason });
  logger.error({ err }, "[unhandledRejection]");
}

let processHandlersRegistered = false;

export function registerProcessErrorHandlers(): void {
  if (processHandlersRegistered) return;
  processHandlersRegistered = true;

  process.on("unhandledRejection", handleUnhandledRejection);

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "[uncaughtException]");
    logger.flush?.();
    process.exit(1);
  });
}
