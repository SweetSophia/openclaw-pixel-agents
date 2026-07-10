import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorHandler, asyncHandler } from "./errors";
import { logger } from "./logger";

describe("Express error boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns async route rejections into 500 responses and keeps serving", async () => {
    const app = express();
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);

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
});