import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("layout mutation lifecycle", () => {
  let app: Express;
  let io: SocketIOServer;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-layout-test-"));
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("DATA_SOURCE", "ingest");
    vi.stubEnv("NODE_ENV", "test");

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

  it("does not let a stale PUT recreate a layout deleted by another client", async () => {
    const created = await request(app)
      .post("/api/layouts")
      .send({ name: "Ephemeral", width: 24, height: 16, furniture: [], seats: {} })
      .expect(200);
    const layout = created.body.layout;

    await request(app).delete(`/api/layouts/${layout.id}`).expect(200);
    expect(existsSync(join(dataDir, "layouts", `${layout.id}.json`))).toBe(false);

    await request(app)
      .put(`/api/layouts/${layout.id}`)
      .send({ ...layout, baseUpdatedAt: layout.updatedAt })
      .expect(404)
      .expect({ error: "Layout not found" });

    expect(existsSync(join(dataDir, "layouts", `${layout.id}.json`))).toBe(false);
  });
});
