import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorHandler, asyncHandler } from "./errors";

describe("Express error boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns async route rejections into 500 responses and keeps serving", async () => {
    const app = express();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

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

    expect(errorSpy).toHaveBeenCalledWith("[api error]", expect.any(Error));

    await request(app)
      .get("/health")
      .expect(200)
      .expect({ ok: true });
  });
});
