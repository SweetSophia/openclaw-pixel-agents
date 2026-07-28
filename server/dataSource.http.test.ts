import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const TEST_INGEST_TOKEN = "data-source-http-test-token";

describe("data-source HTTP contract", () => {
  let app: Express;
  let io: SocketIOServer;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-data-source-test-"));
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("DATA_SOURCE", "cli");
    vi.stubEnv("INGEST_API_TOKEN", TEST_INGEST_TOKEN);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", "https://pixel.test");

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

  it("authenticates before applying the CLI ownership gate", async () => {
    await request(app)
      .post("/api/ingest/agents")
      .send({ sessions: [] })
      .expect(401)
      .expect({ error: "Unauthorized" });
  });

  it("rejects authenticated ingest before payload validation while CLI owns state", async () => {
    await request(app)
      .post("/api/ingest/agents")
      .set("Authorization", `Bearer ${TEST_INGEST_TOKEN}`)
      .send({ invalid: true })
      .expect(409)
      .expect({ error: "Ingest unavailable while CLI polling is active" });
  });

  it("reports configured and effective ownership separately", async () => {
    const response = await request(app)
      .get("/api/status")
      .expect(200);

    expect(response.body).toMatchObject({
      dataSource: "cli-poll",
      dataSourceConfig: "cli",
      dataSourceEffective: "cli-poll",
      dataSourceTransitioned: false,
      lastIngestAt: null,
      cliPolling: true,
    });
  });
});
