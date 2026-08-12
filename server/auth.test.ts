import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import type { Server as SocketIOServer } from "socket.io";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("API auth boundaries", () => {
  let app: Express;
  let io: SocketIOServer;
  let dataDir: string;
  let authenticateIngest: (req: Request, res: Response) => boolean;
  let createIngestAuthenticator: typeof import("./index").createIngestAuthenticator;
  let defaultIngestTokenCrypto: typeof import("./index").defaultIngestTokenCrypto;
  let ingestTokenDigestContext: typeof import("./index").INGEST_TOKEN_DIGEST_CONTEXT;
  let tailTranscript: typeof import("./index").tailTranscript;
  let resetIngestRateBuckets: typeof import("./index")._resetIngestRateBuckets;
  let outsideTranscriptPath: string;
  const appOrigin = "https://pixel.test";

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-auth-test-"));
    const agentsDir = join(dataDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    outsideTranscriptPath = join(dataDir, "outside.jsonl");
    writeFileSync(
      outsideTranscriptPath,
      `${JSON.stringify({
        role: "assistant",
        content: "outside transcript secret",
        timestamp: Date.now(),
      })}\n`,
    );
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("DATA_SOURCE", "ingest");
    vi.stubEnv("INGEST_API_TOKEN", "test-secret");
    vi.stubEnv("OPENCLAW_AGENTS_DIR", agentsDir);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", appOrigin);

    vi.resetModules();
    const serverModule = await import("./index");
    app = serverModule.app;
    io = serverModule.io;
    authenticateIngest = serverModule.authenticateIngest;
    createIngestAuthenticator = serverModule.createIngestAuthenticator;
    defaultIngestTokenCrypto = serverModule.defaultIngestTokenCrypto;
    ingestTokenDigestContext = serverModule.INGEST_TOKEN_DIGEST_CONTEXT;
    tailTranscript = serverModule.tailTranscript;
    resetIngestRateBuckets = serverModule._resetIngestRateBuckets;
  });

  beforeEach(() => {
    // Reset rate-limit buckets between tests so the pre-auth limiter
    // doesn't throttle sequential test requests from 127.0.0.1.
    resetIngestRateBuckets();
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

  it.each([
    "../outside",
    "/tmp/outside",
  ])("rejects unsafe collector sessionId %s", async (sessionId) => {
    await request(app)
      .post("/api/ingest/agents")
      .set("Authorization", "Bearer test-secret")
      .send({
        sessions: [{
          key: "agent:main:test",
          agentId: "main",
          sessionId,
        }],
      })
      .expect(400)
      .expect({ error: "Invalid sessions payload" });
  });

  it("rejects malformed sub-agent keys with 400 instead of throwing", async () => {
    await request(app)
      .post("/api/ingest/agents")
      .set("Authorization", "Bearer test-secret")
      .send({
        sessions: [{
          key: 123,
          agentId: "main",
          kind: "subagent",
        }],
      })
      .expect(400)
      .expect({ error: "Invalid sessions payload" });
  });

  it("rejects a missing collector body with 400 instead of throwing", async () => {
    await request(app)
      .post("/api/ingest/agents")
      .set("Authorization", "Bearer test-secret")
      .expect(400)
      .expect({ error: "Missing or invalid 'sessions' array" });
  });

  it("maps malformed JSON to 400 before ingest authentication", async () => {
    await request(app)
      .post("/api/ingest/agents")
      .set("Content-Type", "application/json")
      .send('{"sessions":[')
      .expect(400)
      .expect({ error: "Malformed JSON body" });
  });

  it("maps oversized JSON to 413 before ingest authentication", async () => {
    await request(app)
      .post("/api/ingest/agents")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ payload: "x".repeat(101 * 1024) }))
      .expect(413)
      .expect({ error: "Request body too large" });
  });

  it("rejects unknown agents and oversized known values", async () => {
    const invalidSessions = [
      { key: "agent:unknown:test", agentId: "unknown" },
      { key: "agent:main:test", agentId: "main", model: "x".repeat(257) },
    ];

    for (const session of invalidSessions) {
      await request(app)
        .post("/api/ingest/agents")
        .set("Authorization", "Bearer test-secret")
        .send({ sessions: [session] })
        .expect(400)
        .expect({ error: "Invalid sessions payload" });
    }
  });

  it("maps and broadcasts a valid collector session", async () => {
    const emitSpy = vi.spyOn(io, "emit");

    await request(app)
      .post("/api/ingest/agents")
      .set("Authorization", "Bearer test-secret")
      .send({
        sessions: [{
          key: "agent:main:test",
          agentId: "main",
          model: "gpt-5",
          modelProvider: "openai",
          sessionId: "123e4567-e89b-12d3-a456-426614174000",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:fixture-parent",
        }],
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ ok: true, received: 1 });
        expect(response.body.agents).toBeGreaterThan(0);
      });

    expect(emitSpy).toHaveBeenCalledWith(
      "agents:update",
      expect.arrayContaining([
        expect.objectContaining({
          id: "main",
          sessionKey: "agent:main:test",
        }),
      ]),
    );
    emitSpy.mockRestore();
  });

  it("refuses to read a transcript outside the registered agent's sessions directory", async () => {
    await expect(
      tailTranscript("main", "Shodan", outsideTranscriptPath),
    ).resolves.toEqual([]);
  });

  it("authenticateIngest is functionally correct across token shapes", () => {
    // Functional regression coverage for authenticateIngest in isolation.
    // The HTTP-level happy/sad paths are covered above; this catches
    // edge cases (empty body after "Bearer ", Unicode tokens, long tokens)
    // that the HTTP layer does not exercise.
    const authenticate = authenticateIngest;
    expect(authenticate).toBeDefined();

    const makeReq = (token: string): Request =>
      ({ headers: { authorization: `Bearer ${token}` } }) as unknown as Request;

    // Correct token (matches INGEST_API_TOKEN="test-secret" from beforeAll)
    expect(authenticate(makeReq("test-secret"), {} as Response)).toBe(true);

    // Wrong content, same length — the comparison must still reject
    expect(authenticate(makeReq("not-a-secr"), {} as Response)).toBe(false);

    // Shorter, longer, much longer
    expect(authenticate(makeReq("X"), {} as Response)).toBe(false);
    expect(authenticate(makeReq("X".repeat(100)), {} as Response)).toBe(false);
    expect(authenticate(makeReq("X".repeat(1000)), {} as Response)).toBe(false);

    // Unicode token (UTF-8 must be handled consistently between env var
    // and Bearer header — both are normalized through HMAC-SHA-256, whose
    // string inputs default to UTF-8 in Node).
    vi.stubEnv("INGEST_API_TOKEN", "café-secret");
    vi.resetModules();
    return import("./index").then((mod) => {
      const unicodeAuth = mod.authenticateIngest;
      expect(unicodeAuth(makeReq("café-secret"), {} as Response)).toBe(true);
      expect(unicodeAuth(makeReq("cafe-secret"), {} as Response)).toBe(false);

      // Restore the test secret for the deterministic crypto-path test below.
      vi.stubEnv("INGEST_API_TOKEN", "test-secret");
      vi.resetModules();
      return import("./index").then((mod2) => {
        // Re-bind the describe-scoped binding to the re-imported function
        // so the crypto-path test sees the restored token.
        authenticateIngest = mod2.authenticateIngest;
        expect(authenticateIngest(makeReq("test-secret"), {} as Response)).toBe(true);
        expect(authenticateIngest(makeReq("not-a-secr"), {} as Response)).toBe(false);
        expect(authenticateIngest(makeReq("X"), {} as Response)).toBe(false);
      });
    });
  });

  it("hashes every Bearer token and compares fixed-length digests", () => {
    // Deterministic regression coverage for CWE-208: every syntactically
    // valid Bearer token must reach the same hash-and-compare path regardless
    // of its length or content. Wall-clock ratios are too sensitive to runner
    // contention to serve as a reliable correctness oracle.
    const makeReq = (token: string): Request =>
      ({ headers: { authorization: `Bearer ${token}` } }) as unknown as Request;

    const digestToken = vi.fn((token: string) =>
      createHmac("sha256", token)
        .update("openclaw-pixel-agents:ingest-token:v1")
        .digest(),
    );
    const compareDigests = vi.fn((configured: Buffer, provided: Buffer) =>
      timingSafeEqual(configured, provided),
    );
    const authenticate = createIngestAuthenticator("test-secret", {
      digestToken,
      compareDigests,
    });
    digestToken.mockClear();
    compareDigests.mockClear();

    const tokens = ["", "X", "not-a-secr", "test-secret", "café-secret", "X".repeat(1000)];
    const results = tokens.map((token) =>
      authenticate(makeReq(token), {} as Response),
    );

    expect(results).toEqual([false, false, false, true, false, false]);
    expect(digestToken).toHaveBeenCalledTimes(tokens.length);
    expect(compareDigests).toHaveBeenCalledTimes(tokens.length);

    for (const [configuredDigest, providedDigest] of compareDigests.mock.calls) {
      expect(configuredDigest).toBeInstanceOf(Buffer);
      expect(providedDigest).toBeInstanceOf(Buffer);
      expect(configuredDigest).toHaveLength(32);
      expect(providedDigest).toHaveLength(32);
    }
  });

  it("pins the production ingest crypto policy to HMAC-SHA-256 and timingSafeEqual", () => {
    const token = "production-policy-regression";
    const expectedDigest = createHmac("sha256", token)
      .update(ingestTokenDigestContext)
      .digest();
    const actualDigest = defaultIngestTokenCrypto.digestToken(token);

    expect(Object.isFrozen(defaultIngestTokenCrypto)).toBe(true);
    expect(actualDigest).toEqual(expectedDigest);
    expect(actualDigest).toHaveLength(32);
    expect(defaultIngestTokenCrypto.compareDigests).toBe(timingSafeEqual);
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
