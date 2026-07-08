import { mkdtempSync, rmSync } from "node:fs";
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
