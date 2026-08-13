/**
 * HTTP-level regression tests for the public GET/HEAD rate limiter
 * (issue #125, review findings).
 *
 * Pins the scope contract of publicGetRateLimiter:
 *   1. the 120/121 threshold and 429 response on static/SPA paths;
 *   2. GET and HEAD are both counted (HEAD performs the same filesystem
 *      work via express.static / SPA sendFile);
 *   3. /api/* GET reads are NOT throttled by this limiter;
 *   4. non-GET/HEAD methods bypass this limiter entirely;
 *   5. bucket reset restores a clean window (test isolation oracle).
 *
 * FRONTEND_DIR is pointed at a temp fixture so the limiter + static mount
 * are actually registered (they are skipped entirely when the directory
 * does not exist, which is why these paths were previously untestable).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const PUBLIC_GET_RATE_LIMIT_MAX = 120;

describe("public GET/HEAD rate limiter (issue #125)", () => {
  let app: Express;
  let frontendDir: string;
  let dataDir: string;
  let resetRateLimitBuckets: typeof import("./index")._resetRateLimitBuckets;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-spa-data-"));
    frontendDir = mkdtempSync(join(tmpdir(), "pixel-agents-spa-frontend-"));
    mkdirSync(join(frontendDir, "assets"), { recursive: true });
    writeFileSync(join(frontendDir, "index.html"), "<!doctype html><title>spa-fixture</title>");
    writeFileSync(join(frontendDir, "assets", "fixture.txt"), "static-fixture");

    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("DATA_SOURCE", "ingest");
    vi.stubEnv("INGEST_API_TOKEN", "test-secret");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", "https://pixel.test");
    vi.stubEnv("FRONTEND_DIR", frontendDir);
    // Deliberately NOT setting TRUST_PROXY: default no-trust contract means
    // all supertest requests share the loopback bucket unless reset.

    vi.resetModules();
    const serverModule = await import("./index");
    app = serverModule.app;
    resetRateLimitBuckets = serverModule._resetRateLimitBuckets;
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(frontendDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    resetRateLimitBuckets();
  });

  it("allows up to 120 GETs then returns 429 on the 121st (threshold pin)", async () => {
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      const res = await request(app).get("/assets/fixture.txt");
      expect(res.status).toBe(200);
    }
    const blocked = await request(app).get("/assets/fixture.txt");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "Too many requests" });
  });

  it("counts HEAD requests against the same bucket as GET", async () => {
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      const res = await request(app).head("/");
      expect(res.status).toBe(200);
    }
    // Bucket now full from HEAD alone: both HEAD and GET must be rejected.
    const blockedHead = await request(app).head("/");
    expect(blockedHead.status).toBe(429);
    const blockedGet = await request(app).get("/");
    expect(blockedGet.status).toBe(429);
  });

  it("covers the SPA fallback path (unknown non-API route)", async () => {
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      const res = await request(app).get("/some/client-side/route");
      expect(res.status).toBe(200);
      expect(res.text).toContain("spa-fixture");
    }
    const blocked = await request(app).get("/some/client-side/route");
    expect(blocked.status).toBe(429);
  });

  it("does not throttle /api GET reads (scope contract)", async () => {
    // Drive the public bucket to the limit via static traffic...
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      await request(app).get("/assets/fixture.txt");
    }
    // ...then confirm API reads are still served (404 from the /api boundary,
    // not 429 from the public limiter).
    const apiRes = await request(app).get("/api/status");
    expect(apiRes.status).not.toBe(429);
  });

  it("lets non-GET/HEAD methods bypass the public limiter", async () => {
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      await request(app).get("/assets/fixture.txt");
    }
    // Bucket is full for GET/HEAD; a POST to an unknown route must not be
    // answered 429 by THIS limiter (the /api boundary or 404 handles it).
    const postRes = await request(app).post("/assets/fixture.txt").send({});
    expect(postRes.status).not.toBe(429);
  });

  it("reset helper restores a clean window", async () => {
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      await request(app).get("/assets/fixture.txt");
    }
    const blocked = await request(app).get("/assets/fixture.txt");
    expect(blocked.status).toBe(429);

    resetRateLimitBuckets();

    const allowed = await request(app).get("/assets/fixture.txt");
    expect(allowed.status).toBe(200);
  });
});
