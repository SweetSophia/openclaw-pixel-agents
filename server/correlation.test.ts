import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger";
import { correlationMiddleware, httpRequestLogMiddleware, pickRequestId } from "./correlation";

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

  it("attaches a request-scoped child logger", async () => {
    const app = express();
    app.use(correlationMiddleware);
    app.use(httpRequestLogMiddleware);
    app.get("/probe", (req, res) => {
      res.json({ hasLog: typeof req.log?.info === "function" });
    });

    await request(app)
      .get("/probe")
      .set("X-Request-Id", "req-with-log")
      .expect(200)
      .expect({ hasLog: true });
  });

  it("can correlate JSON parse errors because it runs before express.json", async () => {
    const app = express();
    app.use(correlationMiddleware);
    app.use(httpRequestLogMiddleware);
    app.use(express.json());
    app.post("/probe", (_req, res) => res.json({ ok: true }));
    app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      expect(err).toBeDefined();
      res.status(400).json({ id: req.id, hasLog: typeof req.log?.warn === "function" });
    });

    const response = await request(app)
      .post("/probe")
      .set("X-Request-Id", "parse-error-1")
      .set("Content-Type", "application/json")
      .send('{"bad"')
      .expect(400);

    expect(response.headers["x-request-id"]).toBe("parse-error-1");
    expect(response.body).toEqual({ id: "parse-error-1", hasLog: true });
  });

  it("httpRequestLogMiddleware is self-sufficient when correlation middleware is absent", async () => {
    const app = express();
    // Intentionally skip correlationMiddleware — the log middleware must still
    // attach a usable request id and a per-request child logger.
    app.use(httpRequestLogMiddleware);
    app.get("/probe", (req, res) => {
      res.json({ id: req.id, hasLog: typeof req.log?.info === "function" });
    });

    const response = await request(app).get("/probe").expect(200);

    expect(response.headers["x-request-id"]).toBeDefined();
    expect(response.body.id).toBe(response.headers["x-request-id"]);
    expect(response.body.hasLog).toBe(true);
    expect(response.body.id).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("httpRequestLogMiddleware honors a safe X-Request-Id without correlation middleware", async () => {
    const app = express();
    app.use(httpRequestLogMiddleware);
    app.get("/probe", (req, res) => {
      res.json({ id: req.id });
    });

    const response = await request(app)
      .get("/probe")
      .set("X-Request-Id", "req-only-log")
      .expect(200);

    expect(response.headers["x-request-id"]).toBe("req-only-log");
    expect(response.body.id).toBe("req-only-log");
  });

  it("accepts the SAFE_ID boundary at 128 characters and rejects 129", () => {
    const max = "a".repeat(128);
    expect(pickRequestId({ "x-request-id": max })).toBe(max);

    const tooLong = "a".repeat(129);
    const result = pickRequestId({ "x-request-id": tooLong });
    expect(result).not.toBe(tooLong);
    expect(result).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("strips query strings from the fallback url so secrets/token bounds are preserved", () => {
    const childSpy = vi.spyOn(logger, "child");
    const fakeChild = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      bindings: () => ({}),
    };
    childSpy.mockReturnValue(fakeChild as unknown as ReturnType<typeof logger.child>);

    // Drive the middleware with a minimal req/res pair. `req.path` is
    // intentionally missing to exercise the req.url fallback path.
    const req = {
      method: "GET",
      headers: {},
      url: "/probe?token=secret&session=abc",
      baseUrl: "",
    } as unknown as express.Request;
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      once: () => undefined,
      statusCode: 200,
      writableFinished: true,
    } as unknown as express.Response;
    const next = vi.fn();

    httpRequestLogMiddleware(req, res, next);

    const bindings = childSpy.mock.calls[0]?.[0] as { url?: string } | undefined;
    expect(bindings?.url).toBe("/probe");
    expect(bindings?.url).not.toContain("token=secret");
    expect(bindings?.url).not.toContain("session=abc");
  });

  it("preserves req.baseUrl when the log middleware is mounted on a sub-router", async () => {
    const router = express.Router();
    router.get("/v1/users", (req, res) => {
      const log = req.log as unknown as { bindings?: () => { url?: string } };
      res.json({ url: log?.bindings?.().url });
    });
    const app = express();
    app.use(correlationMiddleware);
    app.use(httpRequestLogMiddleware);
    app.use("/api", router);

    const response = await request(app).get("/api/v1/users").expect(200);
    expect(response.body.url).toBe("/api/v1/users");
  });
});
