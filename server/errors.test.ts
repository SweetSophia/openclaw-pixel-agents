import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { apiErrorHandler, asyncHandler, handleUnhandledRejection } from "./errors";
import { logger, type Logger } from "./logger";

// Spy on `logger.error` and return the mock so callers can introspect calls.
// The implementation returns `logger` so chained calls (e.g. `.child().error()`)
// remain type-safe; the cast bridges that into the void-returning stub.
function spyOnLoggerError(): MockInstance<Logger["error"]> {
  return vi
    .spyOn(logger, "error")
    .mockImplementation((() => logger) as unknown as Logger["error"]);
}

describe("Express error boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns async route rejections into 500 responses and keeps serving", async () => {
    const errorSpy = spyOnLoggerError();

    const app = express();
    app.get(
      "/reject",
      asyncHandler(async () => {
        throw new Error("boom");
      }),
    );
    app.get("/health", (_req, res) => res.json({ ok: true }));
    app.use(apiErrorHandler);

    await request(app)
      .get("/reject")
      .expect(500)
      .expect("Content-Type", /json/)
      .expect({ error: "Internal server error" });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "[api error]",
    );

    await request(app)
      .get("/health")
      .expect(200)
      .expect({ ok: true });
  });

  it("normalizes async string rejections so the logged err is an Error preserving the original on cause", async () => {
    const errorSpy = spyOnLoggerError();

    const app = express();
    app.get(
      "/reject-string",
      asyncHandler(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "string boom";
      }),
    );
    app.use(apiErrorHandler);

    await request(app).get("/reject-string").expect(500).expect({ error: "Internal server error" });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "[api error]",
    );
    const [fields] = errorSpy.mock.calls[0]!;
    const err = (fields as { err: Error & { cause?: unknown } }).err;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("string boom");
    expect(err.cause).toBe("string boom");
  });

  it("normalizes async object rejections so the logged err is an Error preserving the original on cause", async () => {
    const errorSpy = spyOnLoggerError();
    const reason = { code: "ECONNRESET", target: "upstream" };

    const app = express();
    app.get(
      "/reject-object",
      asyncHandler(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw reason;
      }),
    );
    app.use(apiErrorHandler);

    await request(app).get("/reject-object").expect(500).expect({ error: "Internal server error" });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "[api error]",
    );
    const [fields] = errorSpy.mock.calls[0]!;
    const err = (fields as { err: Error & { cause?: unknown } }).err;
    expect(err).toBeInstanceOf(Error);
    // Default String(reason) collapses objects — that's fine: `cause` retains the original.
    expect(err.cause).toBe(reason);
  });

  it("delegates to default Express handler when headers were already sent", () => {
    const errorSpy = spyOnLoggerError();

    // Simulate the late-rejection scenario without a real socket: res.headersSent
    // is true so apiErrorHandler must call next(err) and bail out, leaving the
    // next middleware (here: the default Express handler) to terminate the
    // response.
    const req = { id: "late-1", log: undefined } as unknown as express.Request;
    const res = {
      headersSent: true,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as express.Response;
    const next = vi.fn();
    const err = new Error("late boom");

    apiErrorHandler(err, req, res, next as unknown as express.NextFunction);

    expect(next).toHaveBeenCalledWith(err);
    expect((res.status as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((res.json as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // The headersSent branch must not log at all — earlier versions only
    // asserted absence of one call shape, which a buggy future refactor could
    // still satisfy by adding a different log call. Zero calls proves intent.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  describe("handleUnhandledRejection normalization", () => {
    it("passes Error reasons through unchanged (identity preserved)", () => {
      const errorSpy = spyOnLoggerError();
      const original = new Error("real boom");

      handleUnhandledRejection(original);

      const [fields] = errorSpy.mock.calls[0]!;
      expect((fields as { err: Error }).err).toBe(original);
    });

    it("normalizes string rejection reasons to Error instances", () => {
      const errorSpy = spyOnLoggerError();

      handleUnhandledRejection("plain string rejection");

      const [fields] = errorSpy.mock.calls[0]!;
      const err = (fields as { err: Error }).err;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("plain string rejection");
    });

    it("preserves object rejection reasons via Error.cause", () => {
      const errorSpy = spyOnLoggerError();
      const reason = { code: "ECONNRESET", target: "upstream" };

      handleUnhandledRejection(reason);

      const [fields] = errorSpy.mock.calls[0]!;
      const err = (fields as { err: Error & { cause?: unknown } }).err;
      expect(err).toBeInstanceOf(Error);
      // Stable message when the reason does not stringify usefully.
      expect(err.message).toBe("[object Object]");
      // Original reason retained for structured dumps.
      expect(err.cause).toBe(reason);
    });

    it("falls back to a stable message for nullish reasons", () => {
      const errorSpy = spyOnLoggerError();

      handleUnhandledRejection(undefined);

      const [fields] = errorSpy.mock.calls[0]!;
      const err = (fields as { err: Error }).err;
      expect(err.message).toBe("unknown rejection");
      expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
    });
  });
});