import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./persistence", async () => {
  const actual = await vi.importActual<typeof import("./persistence")>("./persistence");
  return {
    ...actual,
    atomicWriteFileSync: vi.fn(actual.atomicWriteFileSync),
  };
});

import { atomicWriteFileSync } from "./persistence";

describe("atomic server persistence call paths", () => {
  let app: Express;
  let io: SocketIOServer;
  let dataDir: string;
  const appOrigin = "https://pixel.test";

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-persistence-http-"));
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

  beforeEach(() => {
    vi.mocked(atomicWriteFileSync).mockClear();
  });

  afterAll(() => {
    io.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("routes agent preference writes through the atomic replacement helper", async () => {
    await request(app)
      .post("/api/agents/main/toggle")
      .set("Origin", appOrigin)
      .send({ enabled: false })
      .expect(200);

    const target = join(dataDir, "agent-prefs.json");
    expect(atomicWriteFileSync).toHaveBeenCalledWith(
      dataDir,
      "agent-prefs.json",
      expect.any(String),
    );
    expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({
      main: { pixelEnabled: false },
    });
  });

  it("routes layout writes through the atomic replacement helper", async () => {
    await request(app)
      .put("/api/layouts/atomic-route")
      .set("Origin", appOrigin)
      .send({
        name: "Atomic Route",
        width: 24,
        height: 16,
        furniture: [],
        seats: {},
      })
      .expect(200);

    const layoutsDir = join(dataDir, "layouts");
    const target = join(layoutsDir, "atomic-route.json");
    expect(atomicWriteFileSync).toHaveBeenCalledWith(
      layoutsDir,
      "atomic-route.json",
      expect.any(String),
    );
    expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({
      id: "atomic-route",
      name: "Atomic Route",
    });
  });

  it("rejects an encoded traversal layout path before persistence", async () => {
    await request(app)
      .put("/api/layouts/%2e%2e%2fescape")
      .set("Origin", appOrigin)
      .send({
        name: "Traversal",
        width: 24,
        height: 16,
        furniture: [],
        seats: {},
      })
      .expect(400);

    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });

  it("rejects an invalid layout ID at the route boundary before persistence", async () => {
    await request(app)
      .put("/api/layouts/bad.id")
      .set("Origin", appOrigin)
      .send({
        name: "Invalid ID",
        width: 24,
        height: 16,
        furniture: [],
        seats: {},
      })
      .expect(400);

    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });
});
