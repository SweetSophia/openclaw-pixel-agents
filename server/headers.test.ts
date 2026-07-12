import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import request from "supertest";

describe("security headers", () => {
  let app: Express;
  let io: SocketIOServer;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp("/tmp/pixel-agents-headers-test-"),
    );
  });

  afterAll(async () => {
    if (dataDir) {
      await import("node:fs/promises").then((fs) => fs.rm(dataDir, { recursive: true, force: true }));
    }
  });

  beforeEach(async () => {
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATA_SOURCE", "ingest");
    vi.stubEnv("INGEST_API_TOKEN", "test-secret");
    vi.resetModules();
    const serverModule = await import("./index");
    app = serverModule.app;
    io = serverModule.io;
  });

  afterEach(() => {
    io?.close();
  });

  async function headers() {
    const res = await request(app).get("/api/status");
    return res.headers;
  }

  it("sets X-Content-Type-Options: nosniff", async () => {
    const h = await headers();
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options: DENY", async () => {
    const h = await headers();
    expect(h["x-frame-options"]).toBe("DENY");
  });

  it("sets Referrer-Policy: strict-origin-when-cross-origin", async () => {
    const h = await headers();
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("sets Permissions-Policy disabling camera, microphone, geolocation", async () => {
    const h = await headers();
    const pp = h["permissions-policy"];
    expect(pp).toContain("camera=()");
    expect(pp).toContain("microphone=()");
    expect(pp).toContain("geolocation=()");
  });

  it("does not set HSTS in development mode", async () => {
    const h = await headers();
    expect(h["strict-transport-security"]).toBeUndefined();
  });

  it("sets HSTS in production mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", "https://pixel-agents.example.com");
    vi.resetModules();
    const serverModule = await import("./index");
    const prodApp = serverModule.app;
    const prodIo = serverModule.io;

    const res = await request(prodApp).get("/api/status");
    // Exact value: 2 years (63072000s) required for HSTS preload eligibility.
    expect(res.headers["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");

    prodIo?.close();
  });

  it("CSP does not allow unsafe-inline in script-src", async () => {
    const h = await headers();
    const csp = h["content-security-policy"] as string;
    const scriptSrc = csp.match(/script-src[^;]*/);
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc![0]).not.toContain("'unsafe-inline'");
  });

  it("CSP includes frame-ancestors 'none'", async () => {
    const h = await headers();
    const csp = h["content-security-policy"] as string;
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("CSP retains Google Fonts origins so index.html font loading does not break", async () => {
    const h = await headers();
    const csp = h["content-security-policy"] as string;
    // index.html loads <link href="https://fonts.googleapis.com/css2?...">
    // and font files from fonts.gstatic.com — removing these breaks fonts.
    const styleSrc = csp.match(/style-src[^;]*/);
    expect(styleSrc).toBeTruthy();
    expect(styleSrc![0]).toContain("https://fonts.googleapis.com");
    const fontSrc = csp.match(/font-src[^;]*/);
    expect(fontSrc).toBeTruthy();
    expect(fontSrc![0]).toContain("https://fonts.gstatic.com");
  });

  it("CSP allows WebSocket connections for Socket.IO", async () => {
    const h = await headers();
    const csp = h["content-security-policy"] as string;
    const connectSrc = csp.match(/connect-src[^;]*/);
    expect(connectSrc).toBeTruthy();
    expect(connectSrc![0]).toContain("ws:");
  });

  it("CSP has base-uri 'self', object-src 'none', form-action 'self' for defense-in-depth", async () => {
    const h = await headers();
    const csp = h["content-security-policy"] as string;
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
  });

  it("CSP does not allow unsafe-eval", async () => {
    const h = await headers();
    const csp = h["content-security-policy"] as string;
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("security headers apply to all response surfaces (API, static assets, SPA fallback)", async () => {
    // The headers middleware runs before static + SPA fallback. Verify a
    // sample of each surface carries the same headers, not just /api/status.
    const paths = ["/api/status", "/some-static-asset.js", "/some/unknown/spa-route"];
    for (const path of paths) {
      const res = await request(app).get(path);
      expect(res.headers["x-content-type-options"], `path=${path}`).toBe("nosniff");
      expect(res.headers["x-frame-options"], `path=${path}`).toBe("DENY");
      expect(res.headers["referrer-policy"], `path=${path}`).toBe("strict-origin-when-cross-origin");
      expect(res.headers["permissions-policy"], `path=${path}`).toContain("camera=()");
      expect(res.headers["content-security-policy"], `path=${path}`).toContain("default-src 'self'");
    }
  });
});
