import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

function expectRateLimitHeaders(response: request.Response, limit: number): void {
  expect(response.headers["x-ratelimit-limit"]).toBe(String(limit));
  expect(response.headers["x-ratelimit-remaining"]).toBe("0");
  expect(Number(response.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  expect(Number(response.headers["retry-after"])).toBeLessThanOrEqual(60);
}

describe("API write rate limiting (issue #154)", () => {
  let app: Express;
  let io: SocketIOServer;
  let dataDir: string;
  let frontendDir: string;
  let resetRateLimitBuckets: typeof import("./index")._resetRateLimitBuckets;
  const appOrigin = "https://pixel.test";

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-write-limit-data-"));
    frontendDir = mkdtempSync(join(tmpdir(), "pixel-agents-write-limit-frontend-"));
    mkdirSync(join(frontendDir, "assets"), { recursive: true });
    writeFileSync(join(frontendDir, "index.html"), "<!doctype html><title>fixture</title>");
    writeFileSync(join(frontendDir, "assets", "fixture.txt"), "fixture");

    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("DATA_SOURCE", "ingest");
    vi.stubEnv("INGEST_API_TOKEN", "test-secret");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", appOrigin);
    vi.stubEnv("FRONTEND_DIR", frontendDir);
    vi.stubEnv("PREFS_WRITE_RATE_LIMIT_MAX", "1");
    vi.stubEnv("LAYOUT_WRITE_RATE_LIMIT_MAX", "2");
    vi.stubEnv("PRE_AUTH_RATE_LIMIT_MAX", "3");
    vi.stubEnv("RATE_LIMIT_MAX", "1");
    vi.stubEnv("PUBLIC_GET_RATE_LIMIT_MAX", "1");

    vi.resetModules();
    const serverModule = await import("./index");
    app = serverModule.app;
    io = serverModule.io;
    resetRateLimitBuckets = serverModule._resetRateLimitBuckets;
  });

  beforeEach(() => {
    resetRateLimitBuckets();
  });

  afterAll(() => {
    io.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(frontendDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const preferenceMutations = [
    ["toggle", () => request(app).post("/api/agents/main/toggle").set("Origin", appOrigin).send({ enabled: false })],
    ["sprite", () => request(app).post("/api/agents/main/sprite").set("Origin", appOrigin).send({ spriteId: "char_1" })],
    ["recipe", () => request(app).put("/api/agents/main/recipe").set("Origin", appOrigin).send({ bodyIndex: 0, hairIndex: 0, outfitIndex: 0 })],
    ["tags", () => request(app).put("/api/agents/main/tags").set("Origin", appOrigin).send({ tags: ["coding"] })],
  ] as const;

  it.each(preferenceMutations)("bounds the %s persistence/broadcast path", async (_name, mutate) => {
    await mutate().expect(200);
    const blocked = await mutate().expect(429);

    expect(blocked.body).toEqual({ error: "Too many requests" });
    expectRateLimitHeaders(blocked, 1);

    // Read-only API polling is outside the write bucket.
    await request(app).get("/api/status").expect(200);
  });

  it("shares the layout budget across PUT, POST creation, and DELETE", async () => {
    await request(app)
      .put("/api/layouts/write-limit")
      .set("Origin", appOrigin)
      .send({ name: "Write Limit", width: 24, height: 16, furniture: [], seats: {} })
      .expect(200);

    await request(app)
      .post("/api/layouts")
      .set("Origin", appOrigin)
      .send({ name: "Counted Create", width: 24, height: 16, furniture: [], seats: {} })
      .expect(200);
    const blockedDelete = await request(app)
      .delete("/api/layouts/write-limit")
      .set("Origin", appOrigin)
      .expect(429);
    expectRateLimitHeaders(blockedDelete, 2);

    resetRateLimitBuckets();
    await request(app)
      .delete("/api/layouts/write-limit")
      .set("Origin", appOrigin)
      .expect(200);
    await request(app)
      .put("/api/layouts/write-limit-2")
      .set("Origin", appOrigin)
      .send({ name: "Counted Put", width: 24, height: 16, furniture: [], seats: {} })
      .expect(200);
    const blockedCreate = await request(app)
      .post("/api/layouts")
      .set("Origin", appOrigin)
      .send({ name: "Blocked Create", width: 24, height: 16, furniture: [], seats: {} })
      .expect(429);
    expectRateLimitHeaders(blockedCreate, 2);
  });

  it("keeps preference and layout write budgets independent", async () => {
    await request(app)
      .post("/api/agents/main/toggle")
      .set("Origin", appOrigin)
      .send({ enabled: false })
      .expect(200);
    await request(app)
      .post("/api/agents/main/toggle")
      .set("Origin", appOrigin)
      .send({ enabled: true })
      .expect(429);

    await request(app)
      .post("/api/layouts")
      .set("Origin", appOrigin)
      .send({ name: "Independent Budget", width: 24, height: 16, furniture: [], seats: {} })
      .expect(200);
    await request(app)
      .post("/api/layouts")
      .set("Origin", appOrigin)
      .send({ name: "Independent Budget 2", width: 24, height: 16, furniture: [], seats: {} })
      .expect(200);
  });

  it("rejects over-budget malformed JSON before parsing another large body", async () => {
    const malformed = `{"enabled":"${"x".repeat(99 * 1024)}`;
    await request(app)
      .post("/api/agents/main/toggle")
      .set("Origin", appOrigin)
      .set("Content-Type", "application/json")
      .send(malformed)
      .expect(400);

    const blocked = await request(app)
      .post("/api/agents/main/toggle")
      .set("Origin", appOrigin)
      .set("Content-Type", "application/json")
      .send(malformed)
      .expect(429);
    expectRateLimitHeaders(blocked, 1);
  });

  it("preserves the production Origin rejection without consuming the write budget", async () => {
    await request(app)
      .post("/api/agents/main/toggle")
      .set("Origin", "https://attacker.test")
      .send({ enabled: true })
      .expect(403)
      .expect({ error: "Forbidden origin" });

    await request(app)
      .post("/api/agents/main/toggle")
      .set("Origin", appOrigin)
      .send({ enabled: true })
      .expect(200);
  });

  it("sets backoff headers on public GET, ingest pre-auth, and ingest post-auth 429s", async () => {
    await request(app).get("/assets/fixture.txt").expect(200);
    const publicBlocked = await request(app).get("/assets/fixture.txt").expect(429);
    expectRateLimitHeaders(publicBlocked, 1);

    for (let attempt = 0; attempt < 3; attempt++) {
      await request(app)
        .post("/api/ingest/agents")
        .set("Authorization", "Bearer wrong-secret")
        .send({ sessions: [] })
        .expect(401);
    }
    const preAuthBlocked = await request(app)
      .post("/api/ingest/agents")
      .set("Authorization", "Bearer wrong-secret")
      .send({ sessions: [] })
      .expect(429);
    expectRateLimitHeaders(preAuthBlocked, 3);

    resetRateLimitBuckets();
    await request(app)
      .post("/api/ingest/agents")
      .set("Authorization", "Bearer test-secret")
      .send({ sessions: [] })
      .expect(200);
    const postAuthBlocked = await request(app)
      .post("/api/ingest/agents")
      .set("Authorization", "Bearer test-secret")
      .send({ sessions: [] })
      .expect(429);
    expectRateLimitHeaders(postAuthBlocked, 1);
  });

  it("applies ingest pre-auth limiting before JSON parsing", async () => {
    const malformed = `{"sessions":"${"x".repeat(99 * 1024)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      await request(app)
        .post("/api/ingest/agents")
        .set("Content-Type", "application/json")
        .send(malformed)
        .expect(400);
    }

    const blocked = await request(app)
      .post("/api/ingest/agents")
      .set("Content-Type", "application/json")
      .send(malformed)
      .expect(429);
    expectRateLimitHeaders(blocked, 3);
  });

  it("does not let failed bearer attempts throttle a valid ingest push", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await request(app)
        .post("/api/ingest/agents")
        .set("Authorization", "Bearer wrong-secret")
        .send({ sessions: [] })
        .expect(401);
    }

    await request(app)
      .post("/api/ingest/agents")
      .set("Authorization", "Bearer test-secret")
      .send({ sessions: [] })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ ok: true, received: 0 });
      });
  });
});

describe("disabled ingest pre-parser boundary", () => {
  it("returns the existing 501 response without parsing a malformed body", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-disabled-ingest-"));
    let io: SocketIOServer | undefined;
    try {
      vi.stubEnv("DATA_DIR", dataDir);
      vi.stubEnv("DATA_SOURCE", "ingest");
      vi.stubEnv("INGEST_API_TOKEN", "");
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CORS_ORIGIN", "https://pixel.test");
      vi.resetModules();

      const serverModule = await import("./index");
      io = serverModule.io;
      await request(serverModule.app)
        .post("/api/ingest/agents")
        .set("Content-Type", "application/json")
        .send('{"sessions":[')
        .expect(501)
        .expect({ error: "Ingest not configured (no INGEST_API_TOKEN)" });
    } finally {
      io?.close();
      rmSync(dataDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("default layout write headroom", () => {
  it("allows more than the theoretical 30/minute autosave ceiling", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-layout-headroom-"));
    let io: SocketIOServer | undefined;
    try {
      vi.stubEnv("DATA_DIR", dataDir);
      vi.stubEnv("DATA_SOURCE", "ingest");
      vi.stubEnv("INGEST_API_TOKEN", "test-secret");
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CORS_ORIGIN", "https://pixel.test");
      vi.stubEnv("LAYOUT_WRITE_RATE_LIMIT_MAX", undefined);
      vi.resetModules();

      const serverModule = await import("./index");
      io = serverModule.io;
      for (let attempt = 0; attempt < 31; attempt++) {
        await request(serverModule.app)
          .put("/api/layouts/headroom")
          .set("Origin", "https://pixel.test")
          .send({ width: "wide" })
          .expect(400);
      }
    } finally {
      io?.close();
      rmSync(dataDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("rate-limit environment validation", () => {
  it.each([
    ["RATE_LIMIT_MAX", "0"],
    ["PRE_AUTH_RATE_LIMIT_MAX", "nope"],
    ["PUBLIC_GET_RATE_LIMIT_MAX", "1.5"],
    ["PREFS_WRITE_RATE_LIMIT_MAX", "-1"],
    ["LAYOUT_WRITE_RATE_LIMIT_MAX", ""],
  ])("fails startup for invalid %s=%j", async (name, value) => {
    vi.stubEnv(name, value);
    vi.resetModules();
    await expect(import("./index")).rejects.toThrow(new RegExp(`Invalid ${name}`));
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
