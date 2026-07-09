import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { correlationMiddleware, pickRequestId } from "./correlation";

describe("correlation middleware", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a safe incoming X-Request-Id header and echoes it on the response", async () => {
    const app = express();
    app.use(correlationMiddleware);
    app.get("/probe", (req, res) => {
      res.json({ id: req.id });
    });

    const response = await request(app)
      .get("/probe")
      .set("X-Request-Id", "req-abc-123")
      .expect(200);

    expect(response.headers["x-request-id"]).toBe("req-abc-123");
    expect(response.body.id).toBe("req-abc-123");
  });

  it("generates a fresh id when no header is provided", async () => {
    const app = express();
    app.use(correlationMiddleware);
    app.get("/probe", (req, res) => {
      res.json({ id: req.id });
    });

    const response = await request(app).get("/probe").expect(200);
    expect(response.body.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers["x-request-id"]).toBe(response.body.id);
  });

  it("rejects unsafe incoming X-Request-Id headers and falls back to a UUID", async () => {
    const app = express();
    app.use(correlationMiddleware);
    app.get("/probe", (req, res) => {
      res.json({ id: req.id });
    });

    const response = await request(app)
      .get("/probe")
      .set("X-Request-Id", "<script>alert(1)</script>")
      .expect(200);

    expect(response.body.id).not.toBe("<script>alert(1)</script>");
    expect(response.body.id).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("rejects excessively long X-Request-Id headers", async () => {
    const tooLong = "a".repeat(200);
    const generated = pickRequestId({ "x-request-id": tooLong });
    expect(generated).not.toBe(tooLong);
    expect(generated).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("handles array-valued headers by inspecting the first element", () => {
    const generated = pickRequestId({ "x-request-id": ["req-array-1", "req-array-2"] });
    expect(generated).toBe("req-array-1");
  });
});