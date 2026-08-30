import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("layout persistence capacity", () => {
  let app: Express;
  let io: SocketIOServer;
  let dataDir: string;
  let layoutsDir: string;
  const appOrigin = "https://pixel.test";
  const body = {
    name: "Capacity boundary",
    width: 24,
    height: 16,
    furniture: [],
    seats: {},
  };

  function seedMalformedLayouts(count: number, prefix = "existing"): void {
    for (let index = 0; index < count; index += 1) {
      writeFileSync(join(layoutsDir, `${prefix}-${index}.json`), "{}");
    }
  }

  function seedValidLayouts(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const id = `legacy-${String(index).padStart(3, "0")}`;
      writeFileSync(join(layoutsDir, `${id}.json`), JSON.stringify({
        id,
        ...body,
        updatedAt: index + 1,
      }));
    }
  }

  function seedNonLayoutEntries(count: number): void {
    for (let index = 0; index < count; index += 1) {
      writeFileSync(join(layoutsDir, `operator-note-${index}.txt`), "not a layout");
    }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-layout-capacity-"));
    layoutsDir = join(dataDir, "layouts");
    mkdirSync(layoutsDir, { recursive: true });

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
    rmSync(layoutsDir, { recursive: true, force: true });
    mkdirSync(layoutsDir, { recursive: true });
  });

  afterAll(() => {
    io.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("allows the final slot and rejects further layout-file creation", async () => {
    // Every JSON file contributes to the synchronous scan cost, even when its
    // contents are malformed and skipped by listLayouts().
    seedMalformedLayouts(99);

    await request(app)
      .post("/api/layouts")
      .set("Origin", appOrigin)
      .send(body)
      .expect(200);

    expect(readdirSync(layoutsDir).filter((file) => file.endsWith(".json"))).toHaveLength(100);

    await request(app)
      .post("/api/layouts")
      .set("Origin", appOrigin)
      .send(body)
      .expect(507)
      .expect({ error: "Layout limit reached (100)" });

    await request(app)
      .put("/api/layouts/new-upsert")
      .set("Origin", appOrigin)
      .send(body)
      .expect(507)
      .expect({ error: "Layout limit reached (100)" });

    await request(app)
      .get("/api/layouts/default")
      .expect(507)
      .expect({ error: "Layout limit reached (100)" });

    // Capacity is a file-count bound, not a write freeze. Replacing an
    // existing invalid file must remain possible so operators can repair
    // persisted state without first deleting another layout.
    await request(app)
      .put("/api/layouts/existing-0")
      .set("Origin", appOrigin)
      .send(body)
      .expect(200);

    expect(readdirSync(layoutsDir).filter((file) => file.endsWith(".json"))).toHaveLength(100);
  });

  it("bounds default creation through the collection endpoint", async () => {
    seedMalformedLayouts(99);

    await request(app)
      .get("/api/layouts")
      .expect(200)
      .expect((response) => {
        expect(response.body.layouts).toEqual([
          expect.objectContaining({ id: "default" }),
        ]);
      });

    expect(readdirSync(layoutsDir).filter((file) => file.endsWith(".json"))).toHaveLength(100);

    rmSync(layoutsDir, { recursive: true, force: true });
    mkdirSync(layoutsDir, { recursive: true });
    seedMalformedLayouts(100);

    await request(app)
      .get("/api/layouts")
      .expect(507)
      .expect({ error: "Layout limit reached (100)" });

    expect(readdirSync(layoutsDir).filter((file) => file.endsWith(".json"))).toHaveLength(100);
  });

  it("lists legacy over-capacity layouts in bounded cleanup pages", async () => {
    seedValidLayouts(101);

    const overCapacityResponse = await request(app)
      .get("/api/layouts")
      .expect(200);

    expect(overCapacityResponse.body).toEqual(expect.objectContaining({
      overCapacity: true,
      layoutLimit: 100,
    }));
    expect(overCapacityResponse.body.layouts).toHaveLength(100);

    const visibleLayoutId = overCapacityResponse.body.layouts[0].id as string;
    await request(app)
      .delete(`/api/layouts/${visibleLayoutId}`)
      .set("Origin", appOrigin)
      .expect(200);

    await request(app)
      .get("/api/layouts")
      .expect(200)
      .expect((response) => {
        expect(response.body.layouts).toHaveLength(100);
        expect(response.body.overCapacity).toBeUndefined();
        expect(response.body.layoutLimit).toBeUndefined();
      });
  });

  it("bounds scans and creation capacity across non-layout entries", async () => {
    seedNonLayoutEntries(101);

    await request(app)
      .get("/api/layouts")
      .expect(200)
      .expect((response) => {
        expect(response.body.layouts).toEqual([]);
        expect(response.body.overCapacity).toBe(true);
        expect(response.body.layoutLimit).toBe(100);
      });

    expect(readdirSync(layoutsDir)).not.toContain("default.json");
    await request(app)
      .post("/api/layouts")
      .set("Origin", appOrigin)
      .send(body)
      .expect(507)
      .expect({ error: "Layout limit reached (100)" });

    rmSync(join(layoutsDir, "operator-note-0.txt"));
    rmSync(join(layoutsDir, "operator-note-1.txt"));

    await request(app)
      .get("/api/layouts")
      .expect(200)
      .expect((response) => {
        expect(response.body.layouts).toEqual([
          expect.objectContaining({ id: "default" }),
        ]);
        expect(response.body.overCapacity).toBeUndefined();
        expect(response.body.layoutLimit).toBeUndefined();
      });

    expect(readdirSync(layoutsDir)).toHaveLength(100);
  });

  it("couples the final capacity decision to the synchronous file write", async () => {
    seedMalformedLayouts(99);

    const responses = await Promise.all([
      request(app).post("/api/layouts").set("Origin", appOrigin).send(body),
      request(app).post("/api/layouts").set("Origin", appOrigin).send(body),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 507]);
    expect(readdirSync(layoutsDir).filter((file) => file.endsWith(".json"))).toHaveLength(100);
  });

  it("preserves optimistic concurrency while replacing a layout at capacity", async () => {
    seedMalformedLayouts(99);
    const existingPath = join(layoutsDir, "existing-valid.json");
    writeFileSync(existingPath, JSON.stringify({
      id: "existing-valid",
      ...body,
      updatedAt: 1000,
    }));

    await request(app)
      .put("/api/layouts/existing-valid")
      .set("Origin", appOrigin)
      .send({ ...body, name: "Stale update", baseUpdatedAt: 999 })
      .expect(409);

    expect(JSON.parse(readFileSync(existingPath, "utf-8")).name).toBe("Capacity boundary");

    await request(app)
      .put("/api/layouts/existing-valid")
      .set("Origin", appOrigin)
      .send({ ...body, name: "Current update", baseUpdatedAt: 1000 })
      .expect(200);

    expect(JSON.parse(readFileSync(existingPath, "utf-8")).name).toBe("Current update");
    expect(readdirSync(layoutsDir).filter((file) => file.endsWith(".json"))).toHaveLength(100);
  });

  it("repairs an existing malformed default file at capacity", async () => {
    seedMalformedLayouts(99);
    writeFileSync(join(layoutsDir, "default.json"), "{}");

    await request(app)
      .get("/api/layouts/default")
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(expect.objectContaining({ id: "default" }));
      });

    expect(readdirSync(layoutsDir).filter((file) => file.endsWith(".json"))).toHaveLength(100);
  });
});
