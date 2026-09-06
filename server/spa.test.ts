/**
 * HTTP-level regression tests for the public GET/HEAD rate limiter
 * (issue #125, review findings).
 *
 * Pins the scope contract of publicGetRateLimiter:
 *   1. the 120/121 threshold and 429 response on static/SPA paths;
 *   2. GET and HEAD are both counted (HEAD performs the same filesystem
 *      work via express.static / SPA sendFile);
 *   3. the /api exemption uses an exact namespace boundary: "/api" and
 *      "/api/*" are exempt, sibling prefixes ("/apiary", "/api-v2", "/apis")
 *      are NOT — they fall through to the SPA filesystem path and must
 *      stay rate-limited;
 *   4. non-GET/HEAD methods bypass this limiter entirely (explicit 404);
 *   5. unknown /api routes keep the JSON 404 boundary contract (issue #103);
 *   6. bucket reset restores a clean window (test isolation oracle);
 *   7. the TRUST_PROXY parser accepts only documented forms and fails fast
 *      with a descriptive error on malformed/unrestricted values;
 *   8. with TRUST_PROXY=1, distinct X-Forwarded-For clients get distinct
 *      buckets (no proxy-collapse), while the exemption still holds;
 *   9. the Engine.IO path prefix /socket.io/ is exempt; bare /socket.io and
 *      sibling public paths stay in the SPA/static bucket;
 *  10. the limiter remains mounted when FRONTEND_DIR is absent at boot.
 *
 * The main suite points FRONTEND_DIR at a temp fixture so static and SPA
 * responses are observable; a separate suite pins limiter availability when
 * the directory is absent at module load.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server as HttpServer } from "node:http";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const PUBLIC_GET_RATE_LIMIT_MAX = 120;

function makeFrontendFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "pixel-agents-spa-frontend-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>spa-fixture</title>");
  writeFileSync(join(dir, "assets", "fixture.txt"), "static-fixture");
  return dir;
}

describe("public GET/HEAD rate limiter (issue #125)", () => {
  let app: Express;
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let frontendDir: string;
  let dataDir: string;
  let resetRateLimitBuckets: typeof import("./index")._resetRateLimitBuckets;
  let parseTrustProxy: typeof import("./index").parseTrustProxy;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-spa-data-"));
    frontendDir = makeFrontendFixture();

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
    httpServer = serverModule.server;
    io = serverModule.io;
    resetRateLimitBuckets = serverModule._resetRateLimitBuckets;
    parseTrustProxy = serverModule.parseTrustProxy;
  });

  afterAll(() => {
    io.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(frontendDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
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

  it("rate-limits /api-prefixed siblings while exempting the /api namespace exactly", async () => {
    // Fill the bucket for this IP with ordinary static traffic.
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      await request(app).get("/assets/fixture.txt");
    }

    // Sibling prefixes merely sharing the characters "api" are NOT part of
    // the API namespace: they fall through to the SPA sendFile path and
    // must remain rate-limited (review finding: /apiary, /api-v2 bypass).
    for (const sibling of ["/apiary", "/api-v2", "/apis"]) {
      const blocked = await request(app).get(sibling);
      expect(blocked.status).toBe(429);
    }

    // The exact namespace boundary stays exempt: /api itself hits the API
    // JSON 404 boundary (not the limiter), and /api/status keeps serving.
    const apiRoot = await request(app).get("/api");
    expect(apiRoot.status).toBe(404);
    expect(apiRoot.body).toEqual({ error: "Not found" });

    const apiStatus = await request(app).get("/api/status");
    expect(apiStatus.status).toBe(200);
  });

  it("does not charge Engine.IO polling against the public GET bucket", async () => {
    // Hit the HTTP server so Engine.IO can intercept before Express.
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      const polling = await request(httpServer)
        .get(`/socket.io/?EIO=4&transport=polling&t=${i}`);
      expect(polling.status).not.toBe(429);
      expect(polling.text).not.toContain("spa-fixture");
    }

    const publicRequest = await request(app).get("/assets/fixture.txt");
    expect(publicRequest.status).toBe(200);
  });

  it("keeps Engine.IO handshake available after the public GET bucket is full", async () => {
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      await request(app).get("/assets/fixture.txt");
    }
    const blocked = await request(app).get("/assets/fixture.txt");
    expect(blocked.status).toBe(429);

    const handshake = await request(httpServer)
      .get("/socket.io/?EIO=4&transport=polling")
      .set("Origin", "https://pixel.test");
    expect(handshake.status).toBe(200);
    expect(handshake.text).not.toContain("spa-fixture");
    expect(handshake.text).toMatch(/^0\{/);
  });

  it("exempts /socket.io/ on Express without exempting the bare path or siblings", async () => {
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      await request(app).get("/assets/fixture.txt");
    }

    const polling = await request(app).get("/socket.io/?EIO=4&transport=polling");
    expect(polling.status).toBe(200);
    expect(polling.text).toContain("spa-fixture");

    const bare = await request(app).get("/socket.io");
    expect(bare.status).toBe(429);

    for (const sibling of ["/socket.io-client", "/socket.iox"]) {
      const blocked = await request(app).get(sibling);
      expect(blocked.status).toBe(429);
    }

    for (const path of ["/socket.io", "/socket.io?n=1"]) {
      const httpBare = await request(httpServer).get(path);
      expect(httpBare.status).toBe(429);
    }
  });

  it("returns JSON 404s for unknown API GET routes (issue #103 boundary pin)", async () => {
    const response = await request(app).get("/api/definitely-missing");
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: "Not found" });
  });

  it("lets non-GET/HEAD methods bypass the public limiter (explicit 404)", async () => {
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      await request(app).get("/assets/fixture.txt");
    }
    // Bucket is full for GET/HEAD; a POST to a static path is outside this
    // limiter's scope and lands in Express's ordinary 404 path.
    const postRes = await request(app).post("/assets/fixture.txt").send({});
    expect(postRes.status).toBe(404);
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

  describe("parseTrustProxy contract (unit)", () => {
    it.each([
      [undefined, undefined],
      ["", undefined],
      ["false", undefined],
      ["0", undefined],
      ["1", 1],
      ["2", 2],
      ["loopback", ["loopback"]],
      ["uniquelocal", ["uniquelocal"]],
      ["10.0.0.0/8,127.0.0.1", ["10.0.0.0/8", "127.0.0.1"]],
      ["::1", ["::1"]],
      ["2001:db8::/32", ["2001:db8::/32"]],
    ])("accepts %j -> %j", (raw, expected) => {
      expect(parseTrustProxy(raw as string | undefined)).toEqual(expected);
    });

    it.each([
      ["true"],
      ["yes"],
      ["-1"],
      ["01"],
      ["1e2"],
      ["10.0.0.0/33"],
      ["::1/129"],
      ["0.0.0.0/0"],
      ["::/0"],
      ["10.0.0.0/0"],
      ["300.300.300.300"],
      ["example.com"],
      ["10.0.0.0/8,not-an-ip"],
      [",,"],
    ])("rejects malformed value %j with a descriptive error", (raw) => {
      expect(() => parseTrustProxy(raw)).toThrow(/Invalid TRUST_PROXY value/);
      expect(() => parseTrustProxy(raw)).toThrow(/Accepted forms/);
    });
  });
});

describe("public GET limiter without frontend at boot (issue #156)", () => {
  let app: Express;
  let io: SocketIOServer;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-spa-missing-data-"));

    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("DATA_SOURCE", "ingest");
    vi.stubEnv("INGEST_API_TOKEN", "test-secret");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", "https://pixel.test");
    vi.stubEnv("FRONTEND_DIR", join(dataDir, "missing-frontend"));

    vi.resetModules();
    const serverModule = await import("./index");
    app = serverModule.app;
    io = serverModule.io;
  });

  afterAll(() => {
    io.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("still rate-limits the SPA fallback 404 path", async () => {
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      const response = await request(app).get("/missing-client-route");
      expect(response.status).toBe(404);
    }

    const blocked = await request(app).get("/missing-client-route");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "Too many requests" });
  });
});

describe("TRUST_PROXY malformed startup (fail fast)", () => {
  it("rejects unrestricted 'true' at module load with a descriptive error", async () => {
    vi.stubEnv("TRUST_PROXY", "true");
    vi.resetModules();
    await expect(import("./index")).rejects.toThrow(/Invalid TRUST_PROXY value/);
    vi.unstubAllEnvs();
  });

  it("rejects a malformed CIDR at module load with a descriptive error", async () => {
    vi.stubEnv("TRUST_PROXY", "10.0.0.0/33");
    vi.resetModules();
    await expect(import("./index")).rejects.toThrow(/Invalid TRUST_PROXY value/);
    vi.unstubAllEnvs();
  });

  it("rejects /0 CIDRs (unrestricted range) at module load with a descriptive error", async () => {
    // proxy-addr's compile() would throw an opaque "invalid range on
    // address" TypeError; the project validator must fail first with a
    // TRUST_PROXY-named error (review repro on 98504fc).
    vi.stubEnv("TRUST_PROXY", "0.0.0.0/0");
    vi.resetModules();
    await expect(import("./index")).rejects.toThrow(/Invalid TRUST_PROXY value/);
    vi.unstubAllEnvs();
  });
});

describe("TRUST_PROXY=1 per-client buckets (proxy separation)", () => {
  let app: Express;
  let io: SocketIOServer;
  let frontendDir: string;
  let dataDir: string;
  let resetRateLimitBuckets: typeof import("./index")._resetRateLimitBuckets;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-spa-trust-data-"));
    frontendDir = makeFrontendFixture();

    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("DATA_SOURCE", "ingest");
    vi.stubEnv("INGEST_API_TOKEN", "test-secret");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", "https://pixel.test");
    vi.stubEnv("FRONTEND_DIR", frontendDir);
    vi.stubEnv("TRUST_PROXY", "1");

    vi.resetModules();
    const serverModule = await import("./index");
    app = serverModule.app;
    io = serverModule.io;
    resetRateLimitBuckets = serverModule._resetRateLimitBuckets;
  });

  afterAll(() => {
    io.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(frontendDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  beforeEach(() => {
    resetRateLimitBuckets();
  });

  it("gives distinct X-Forwarded-For clients distinct buckets", async () => {
    // Client A exhausts its own bucket.
    for (let i = 0; i < PUBLIC_GET_RATE_LIMIT_MAX; i++) {
      const res = await request(app)
        .get("/assets/fixture.txt")
        .set("X-Forwarded-For", "203.0.113.1");
      expect(res.status).toBe(200);
    }
    const blockedA = await request(app)
      .get("/assets/fixture.txt")
      .set("X-Forwarded-For", "203.0.113.1");
    expect(blockedA.status).toBe(429);

    // Client B still has a full bucket of its own — no shared-bucket collapse.
    const servedB = await request(app)
      .get("/assets/fixture.txt")
      .set("X-Forwarded-For", "203.0.113.2");
    expect(servedB.status).toBe(200);

    // The /api namespace exemption keeps working under trusted proxy mode.
    const apiStatus = await request(app)
      .get("/api/status")
      .set("X-Forwarded-For", "203.0.113.1");
    expect(apiStatus.status).toBe(200);
  });
});
