import { pino, type Logger, type LoggerOptions } from "pino";

/**
 * Build a default log level based on NODE_ENV:
 *   production → info, otherwise → debug.
 * Always overridable via LOG_LEVEL.
 */
function defaultLevel(): string {
  const explicit = process.env.LOG_LEVEL;
  if (explicit && explicit.trim()) return explicit.trim();
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function buildOptions(): LoggerOptions {
  return {
    level: defaultLevel(),
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers['set-cookie']",
      ],
      remove: true,
    },
    base: {
      service: "openclaw-pixel-agents",
      pid: process.pid,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

export const logger: Logger = pino(buildOptions());

export type { Logger };
