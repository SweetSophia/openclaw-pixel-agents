import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("API auth boundaries", () => {
  let app: Express;
  let io: SocketIOServer;
  let dataDir: string;
  let authenticateIngest: (req: Express.Request, res: Express.Response) => boolean;
  const appOrigin = "https://pixel.test";

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-auth-test-"));
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("DATA_SOURCE", "ingest");
    vi.stubEnv("INGEST_API_TOKEN", "test-secret");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", appOrigin);

    vi.resetModules();
    const serverModule = await import("./index");
    app = serverModule.app;
    io = serverModule.io;
    authenticateIngest = serverModule.authenticateIngest;
  });

  afterAll(() => {
    io.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps collector ingest token-protected", async () => {
    await request(app)
      .post("/api/ingest/agents")
      .send({ sessions: [] })
      .expect(401)
      .expect({ error: "Unauthorized" });
  });

  it("rejects collector ingest when the bearer token is wrong", async () => {
    await request(app)
      .post("/api/ingest/agents")
      .set("Authorization", "Bearer not-the-secret")
      .send({ sessions: [] })
      .expect(401)
      .expect({ error: "Unauthorized" });
  });

  it("authenticateIngest does not leak token length via timing", () => {
    // Regression test for CWE-208: the old implementation had an early-return
    // branch on length mismatch that let an attacker detect the configured
    // token length. The SHA-256 digest approach uses a single code path for
    // all inputs — only the hash of the attacker-controlled input varies in
    // time, never the secret comparison.
    const authenticate = authenticateIngest;
    expect(authenticate).toBeDefined();

    const makeReq = (token: string): Express.Request =>
      ({ headers: { authorization: `Bearer ${token}` } }) as unknown as Express.Request;

    const correctToken = "test-secret"; // matches INGEST_API_TOKEN from beforeAll
    const wrongSameLen = "not-the-xxx"; // same length (11 chars), wrong content
    const wrongShort = "X";
    const wrongLong = "X".repeat(200);

    // Functional: only the correct token authenticates
    expect(authenticate(makeReq(correctToken), {} as Express.Response)).toBe(true);
    expect(authenticate(makeReq(wrongSameLen), {} as Express.Response)).toBe(false);
    expect(authenticate(makeReq(wrongShort), {} as Express.Response)).toBe(false);
    expect(authenticate(makeReq(wrongLong), {} as Express.Response)).toBe(false);

    // Timing: all paths should take comparable wall-clock time.
    // The old length-branch created a >10x divergence; the digest approach
    // has a single path. Allow 2x for CI runner noise.
    const ITERATIONS = 20_000;

    // Warm up JIT and caches
    for (let i = 0; i < 2000; i++) {
      authenticate(makeReq(correctToken), {} as Express.Response);
      authenticate(makeReq(wrongShort), {} as Express.Response);
    }

    const measure = (token: string): number => {
      const req = makeReq(token);
      const start = process.hrtime.bigint();
      for (let i = 0; i < ITERATIONS; i++) {
        authenticate(req, {} as Express.Response);
      }
      return Number(process.hrtime.bigint() - start);
    };

    const correctTime = measure(correctToken);
    const shortTime = measure(wrongShort);
    const longTime = measure(wrongLong);
    const sameLenTime = measure(wrongSameLen);

    const max = Math.max(correctTime, shortTime, longTime, sameLenTime);
    const min = Math.min(correctTime, shortTime, longTime, sameLenTime);
    // Assert no path is dramatically faster — that would indicate a
    // length-based early return has been reintroduced.
    expect(max / min).toBeLessThan(2);
  });

  it("accepts collector ingest when the token is valid", async () => {
    await request(app)
      .post("/api/ingest/agents")
      .set("Authorization", "Bearer test-secret")
      .send({ sessions: [] })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ ok: true, received: 0 });
        expect(response.body.agents).toBeGreaterThanOrEqual(0);
      });
  });

  it("does not require the collector token for same-origin UI mutation endpoints", async () => {
    const responses = [
      await request(app).post("/api/agents/main/toggle").set("Origin", appOrigin).send({ enabled: false }).expect(200),
      await request(app).post("/api/agents/main/sprite").set("Origin", appOrigin).send({ spriteId: "char_1" }).expect(200),
      await request(app).put("/api/agents/main/recipe").set("Origin", appOrigin).send({ bodyIndex: 0, hairIndex: 0, outfitIndex: 0 }).expect(200),
      await request(app).put("/api/agents/main/tags").set("Origin", appOrigin).send({ tags: ["coding"] }).expect(200),
      await request(app).put("/api/layouts/auth-regression").set("Origin", appOrigin).send({
        name: "Auth Regression",
        width: 24,
        height: 16,
        furniture: [],
        seats: {},
      }).expect(200),
      await request(app).post("/api/layouts").set("Origin", appOrigin).send({
        name: "Auth Regression Created",
        width: 24,
        height: 16,
        furniture: [],
        seats: {},
      }).expect(200),
      await request(app).delete("/api/layouts/auth-regression").set("Origin", appOrigin).expect(200),
    ];

    expect(responses.map((response) => response.status)).not.toContain(401);
  });

  it("rejects malformed agent mutation bodies", async () => {
    await request(app)
      .post("/api/agents/main/toggle")
      .set("Origin", appOrigin)
      .send({ enabled: "false" })
      .expect(400)
      .expect({ error: "enabled must be a boolean" });

    await request(app)
      .post("/api/agents/main/sprite")
      .set("Origin", appOrigin)
      .send({ spriteId: "../char_1" })
      .expect(400)
      .expect({ error: "spriteId must be a safe string" });

    await request(app)
      .put("/api/agents/main/tags")
      .set("Origin", appOrigin)
      .send({ tags: ["coding"], extra: true })
      .expect(400);
  });

  it("rejects malformed layout mutation bodies", async () => {
    await request(app)
      .put("/api/layouts/validation-regression")
      .set("Origin", appOrigin)
      .send({ width: "wide" })
      .expect(400);

    await request(app)
      .put("/api/layouts/validation-regression")
      .set("Origin", appOrigin)
      .send({ baseUpdatedAt: "stale" })
      .expect(400)
      .expect({ error: "baseUpdatedAt must be a non-negative integer" });

    await request(app)
      .put("/api/layouts/validation-regression")
      .set("Origin", appOrigin)
      .send({ furniture: [{}] })
      .expect(400);

    await request(app)
      .post("/api/layouts")
      .set("Origin", appOrigin)
      .send({ width: -1 })
      .expect(400);

    await request(app)
      .post("/api/layouts")
      .set("Origin", appOrigin)
      .send({ furniture: "nope" })
      .expect(400);
  });

  it("skips malformed persisted layout files", async () => {
    const layoutsDir = join(dataDir, "layouts");
    mkdirSync(layoutsDir, { recursive: true });
    writeFileSync(join(layoutsDir, "bad.json"), JSON.stringify({ id: "bad", name: "Bad", width: "wide" }));

    await request(app)
      .get("/api/layouts")
      .expect(200)
      .expect((response) => {
        expect(response.body.layouts.every((layout: { id: string }) => layout.id !== "bad")).toBe(true);
      });
  });

  it("rejects UI mutations from origins outside the configured app allow-list", async () => {
    await request(app)
      .post("/api/agents/main/toggle")
      .set("Origin", "https://attacker.test")
      .send({ enabled: true })
      .expect(403)
      .expect({ error: "Forbidden origin" });
  });

  it("rejects UI mutations that omit the Origin header in production", async () => {
    // A non-browser caller without an Origin header must not bypass the
    // production Origin allow-list for state-mutating routes.
    await request(app)
      .post("/api/agents/main/toggle")
      .send({ enabled: true })
      .expect(403)
      .expect({ error: "Forbidden origin" });
  });
});
