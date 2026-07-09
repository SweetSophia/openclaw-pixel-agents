import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("logger", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("exports a pino logger instance with the expected interface", async () => {
    const { logger } = await import("./logger");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.child).toBe("function");
    expect(typeof logger.flush).toBe("function");
  });

  it("uses info level in production by default", async () => {
    process.env.NODE_ENV = "production";
    const { logger } = await import("./logger");
    expect(logger.level).toBe("info");
  });

  it("uses debug level outside production by default", async () => {
    delete process.env.NODE_ENV;
    const { logger } = await import("./logger");
    expect(logger.level).toBe("debug");
  });

  it("honors explicit LOG_LEVEL override", async () => {
    process.env.LOG_LEVEL = "warn";
    process.env.NODE_ENV = "production";
    const { logger } = await import("./logger");
    expect(logger.level).toBe("warn");
  });

  it("supports child loggers used by structured subsystem logging", async () => {
    const { logger } = await import("./logger");
    const child = logger.child({ subsystem: "auth" });
    expect(typeof child.info).toBe("function");
  });
});
