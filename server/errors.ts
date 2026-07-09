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

let processHandlersRegistered = false;

export function registerProcessErrorHandlers(): void {
  if (processHandlersRegistered) return;
  processHandlersRegistered = true;

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "[unhandledRejection]");
  });

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "[uncaughtException]");
    logger.flush?.();
    process.exit(1);
  });
}
