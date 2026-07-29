import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Regression: the SPA fallback catch-all survived the Express 4→5 migration.
 *
 * Express 5 (path-to-regexp v8) rejects a bare "*" wildcard at route
 * registration time, so the fallback was migrated to the named "*splat"
 * form. This pins that the catch-all still MATCHES unmatched GET paths:
 * the response must come from our handler (index.html served, or the
 * explicit "Not found" text when no build artifact exists) and must NOT be
 * Express's default "Cannot GET …" 404, which would indicate the wildcard
 * failed to register/match.
 */
describe("SPA fallback catch-all (Express 5 *splat)", () => {
  let app: Express;
  let io: SocketIOServer;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-spa-test-"));
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("DATA_SOURCE", "cli");
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

  it("handles a deep non-API GET via the catch-all, not Express's default 404", async () => {
    const response = await request(app).get("/some/deep/spa/route");

    // Our handler either serves index.html (200, html) or returns the
    // explicit "Not found" text (404) when the client build is absent.
    expect([200, 404]).toContain(response.status);
    if (response.status === 404) {
      expect(response.text).toBe("Not found");
    } else {
      expect(response.headers["content-type"]).toMatch(/text\/html/);
    }
  });

  it("serves the SPA at the root path '/' (documented contract)", async () => {
    const response = await request(app).get("/");

    // Same contract as the deep route: the catch-all must match "/", serving
    // index.html (200) or the explicit "Not found" text (404) when no build
    // artifact exists — never Express's default "Cannot GET /" 404.
    expect([200, 404]).toContain(response.status);
    if (response.status === 404) {
      expect(response.text).toBe("Not found");
    } else {
      expect(response.headers["content-type"]).toMatch(/text\/html/);
    }
  });
});
