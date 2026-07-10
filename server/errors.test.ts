import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorHandler, asyncHandler, registerProcessErrorHandlers } from "./errors";
import { logger, type Logger } from "./logger";

describe("Express error boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns async route rejections into 500 responses and keeps serving", async () => {
    const app = express();
    // Cast through `unknown` so the spy can return Logger for callers that chain
    // method calls while still satisfying the `void`-returning target signature.
    const errorSpy = vi
      .spyOn(logger, "error")
      .mockImplementation((() => logger) as unknown as Logger["error"]);

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

  it("delegates to default Express handler when headers were already sent", () => {
    const errorSpy = vi
      .spyOn(logger, "error")
      .mockImplementation((() => logger) as unknown as Logger["error"]);

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
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "[api error]",
    );
  });

  it("normalizes non-Error rejection reasons for the unhandledRejection handler", () => {
    const errorSpy = vi
      .spyOn(logger, "error")
      .mockImplementation((() => logger) as unknown as Logger["error"]);

    // Re-register with an idempotency escape hatch: registerProcessErrorHandlers
    // uses a module-level guard, so we attach a fresh listener directly to
    // exercise the same handler body without disturbing other tests.
    const original = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    try {
      registerProcessErrorHandlers();
      process.emit("unhandledRejection", "plain string rejection", { type: "unhandledRejection" } as unknown as Promise<unknown>);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "[unhandledRejection]",
      );
      const [fields] = errorSpy.mock.calls[0]!;
      expect(fields.err).toBeInstanceOf(Error);
      expect((fields as { err: Error }).err.message).toBe("plain string rejection");
    } finally {
      // Restore previous listeners (test isolation across the suite).
      process.removeAllListeners("unhandledRejection");
      for (const listener of original) process.on("unhandledRejection", listener as NodeJS.UnhandledRejectionListener);
    }
  });
});
