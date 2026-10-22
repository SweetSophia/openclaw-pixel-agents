import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("serves legacy Shodan seats for main without rewriting or revising the layout, then saves canonical seats", async () => {
    const legacy = {
      id: "legacy-seats", name: "Legacy seats", width: 24, height: 16,
      furniture: [], seats: { shodan: { x: 9, y: 4 }, miku: { x: 20, y: 10 } }, updatedAt: 1,
    };
    const canonicalSeats = { main: { x: 9, y: 4 }, miku: { x: 20, y: 10 } };
    const path = join(dataDir, "layouts", "legacy-seats.json");
    const original = JSON.stringify(legacy);
    mkdirSync(join(dataDir, "layouts"), { recursive: true });
    writeFileSync(path, original);

    const read = await request(app).get("/api/layouts/legacy-seats").expect(200);
    expect(read.body).toEqual({ ...legacy, seats: canonicalSeats });
    const list = await request(app).get("/api/layouts").expect(200);
    expect(list.body.layouts.find((layout: { id: string }) => layout.id === "legacy-seats")).toEqual(read.body);
    expect(readFileSync(path, "utf8")).toBe(original);
    const initialDefault = await request(app).get("/api/layouts/default").expect(200);
    expect(initialDefault.body.seats.main).toEqual({ x: 9, y: 4 });
    expect(initialDefault.body.seats).not.toHaveProperty("shodan");

    const saved = await request(app).put("/api/layouts/legacy-seats")
      .send({ name: "Updated seats", baseUpdatedAt: legacy.updatedAt }).expect(200);
    expect(saved.body.layout).toEqual({ ...legacy, name: "Updated seats", seats: canonicalSeats, updatedAt: expect.any(Number) });
    expect(saved.body.layout.updatedAt).not.toBe(legacy.updatedAt);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(saved.body.layout);
    await request(app).put("/api/layouts/legacy-seats")
      .send({ name: "Stale edit", baseUpdatedAt: legacy.updatedAt }).expect(409);
  });

  it("serves canonical legacy furniture without rewriting the file, then persists canonical edits", async () => {
    const furniture = [
      { id: "old-desk", type: "desk", x: 2, y: 2, rotation: 90 },
      { id: "old-chair", type: "chair", x: 4, y: 2, rotation: 0 },
      { id: "old-monitor", type: "Monitor", x: 6, y: 2, rotation: 0, state: "off" },
      { id: "custom", type: "vendor.Custom", x: 8, y: 2, rotation: 0 },
    ];
    const canonical = furniture.map((item, i) => ({ ...item, type: ["DESK", "CUSHIONED_CHAIR", "PC", "vendor.Custom"][i] }));
    const legacy = { id: "legacy", name: "Legacy office", width: 24, height: 16, furniture, seats: { main: { x: 2, y: 2 } }, updatedAt: 1 };
    const path = join(dataDir, "layouts", "legacy.json");
    const original = JSON.stringify(legacy);
    mkdirSync(join(dataDir, "layouts"), { recursive: true });
    writeFileSync(path, original);

    const read = await request(app).get("/api/layouts/legacy").expect(200);
    expect(read.body).toEqual({ ...legacy, furniture: canonical });
    const list = await request(app).get("/api/layouts").expect(200);
    expect(list.body.layouts.find((layout: { id: string }) => layout.id === "legacy")).toEqual(read.body);
    expect(readFileSync(path, "utf8")).toBe(original);

    const saved = await request(app).put("/api/layouts/legacy")
      .send({ furniture, baseUpdatedAt: legacy.updatedAt }).expect(200);
    expect(saved.body.layout).toEqual({ ...legacy, furniture: canonical, updatedAt: expect.any(Number) });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(saved.body.layout);
    await request(app).put("/api/layouts/legacy")
      .send({ furniture, baseUpdatedAt: legacy.updatedAt }).expect(409);
  });

  it("creates layouts with canonical furniture types advertised by the catalog", async () => {
    const created = await request(app).post("/api/layouts").send({
      name: "Legacy client", furniture: [
        { id: "a", type: "DeSk", x: 2, y: 2, rotation: 0 },
        { id: "b", type: "chair", x: 4, y: 2, rotation: 0 },
        { id: "c", type: "monitor", x: 6, y: 2, rotation: 0 },
      ],
    }).expect(200);
    const layout = created.body.layout;
    expect(layout.furniture.map((item: { type: string }) => item.type)).toEqual(["DESK", "CUSHIONED_CHAIR", "PC"]);
    const catalog = await request(app).get("/api/furniture-catalog").expect(200);
    for (const item of layout.furniture) expect(catalog.body.types).toContain(item.type);
    expect(JSON.parse(readFileSync(join(dataDir, "layouts", `${layout.id}.json`), "utf8"))).toEqual(layout);
  });
});
