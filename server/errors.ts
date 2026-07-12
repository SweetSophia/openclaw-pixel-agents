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
  // Normalize non-Error rejections (string/object) so pino's { err } serializer
  // produces a real Error — stringification alone drops stacks and loses the
  // original reason.
  const normalized = toError(err, "api error");
  log.error({ err: normalized, reqId: req.id }, "[api error]");
  res.status(500).json({ error: "Internal server error" });
};

/**
 * Normalize an unknown rejection/error value into an `Error`.
 *
 * - `Error` instances pass through unchanged so identity (and therefore the
 *   original stack trace) is preserved for pino's `{ err }` serializer.
 * - `null`/`undefined` fall back to a stable, caller-provided message.
 * - Anything else is stringified into `Error.message`, but the original value
 *   is retained on `Error.cause` so structured dumps can still reconstruct it
 *   (otherwise `new Error(String({foo: 1}))` collapses to `[object Object]`).
 */
export function toError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) return value;
  return new Error(value == null ? fallbackMessage : String(value), { cause: value });
}

/**
 * Normalize an `unhandledRejection` reason so pino's `{ err }` serializer can
 * extract type/stack/message consistently. See {@link toError} for the rules.
 */
export function handleUnhandledRejection(reason: unknown): void {
  logger.error({ err: toError(reason, "unknown rejection") }, "[unhandledRejection]");
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
