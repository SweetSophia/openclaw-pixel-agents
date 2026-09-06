import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const PROCESS_EVENTS = [
  "unhandledRejection",
  "uncaughtException",
  "SIGTERM",
  "SIGINT",
] as const;

function withDeadline<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

describe("auto data-source startup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("hands ownership to ingest after a real ENOENT from the immediate CLI poll", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-data-source-"));
    const listenersBeforeStart = new Map(
      PROCESS_EVENTS.map((event) => [event, process.listeners(event)]),
    );
    const intervalEvents = new EventEmitter();
    const originalClearInterval = globalThis.clearInterval;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi
      .spyOn(globalThis, "clearInterval")
      .mockImplementation((handle) => {
        originalClearInterval(handle);
        intervalEvents.emit("cleared", handle);
      });

    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("DATA_SOURCE", "auto");
    vi.stubEnv("INGEST_API_TOKEN", "integration-secret");
    vi.stubEnv("OPENCLAW_BIN", join(dataDir, "guaranteed-not-to-exist"));
    vi.stubEnv("PORT", "0");
    vi.stubEnv("CORS_ORIGIN", "https://pixel.test");
    vi.stubEnv("FRONTEND_DIR", join(dataDir, "missing-frontend"));

    vi.resetModules();
    const serverModule = await import("./index");
    const { app, io, server, startServer } = serverModule;
    const intervalCountBeforeStart = setIntervalSpy.mock.results.length;
    const pollTimerCleared = once(intervalEvents, "cleared");

    const payload = {
      sessions: [{
        key: "agent:main:integration",
        agentId: "main",
        updatedAt: Date.now(),
      }],
    };
    const authorization = "Bearer integration-secret";

    try {
      const beforeStart = await request(app)
        .post("/api/ingest/agents")
        .set("Authorization", authorization)
        .send(payload);
      expect(beforeStart.status).toBe(409);

      const listening = once(server, "listening");
      startServer();
      await withDeadline(listening);

      expect(setIntervalSpy.mock.results.length).toBe(intervalCountBeforeStart + 1);
      const pollTimer = setIntervalSpy.mock.results[intervalCountBeforeStart]?.value;
      const [clearedTimer] = await withDeadline(pollTimerCleared);
      expect(clearedTimer).toBe(pollTimer);
      expect(clearIntervalSpy).toHaveBeenCalledWith(pollTimer);

      const status = await request(server).get("/api/status");
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        dataSourceConfig: "auto",
        dataSourceEffective: "ingest-only",
        dataSourceTransitioned: true,
        cliPolling: false,
      });

      const accepted = await request(server)
        .post("/api/ingest/agents")
        .set("Authorization", authorization)
        .send(payload);
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ ok: true, received: 1 });
      expect(accepted.body.agents).toBeGreaterThan(0);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
      await io.close();

      for (const result of setIntervalSpy.mock.results) {
        if (result.type === "return") originalClearInterval(result.value);
      }
      for (const event of PROCESS_EVENTS) {
        const existingListeners = listenersBeforeStart.get(event) ?? [];
        for (const listener of process.listeners(event)) {
          if (!existingListeners.includes(listener)) {
            EventEmitter.prototype.removeListener.call(process, event, listener);
          }
        }
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10_000);
});
