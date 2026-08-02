import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  fetchOpenClawSessions,
  getIngestEndpoint,
  postSnapshot,
  runCollector,
} from "./push-pixel-agents.mjs";

describe("collector URL policy (issue #99)", () => {
  it.each([
    ["https://agents.example.com", "https://agents.example.com/api/ingest/agents"],
    ["https://agents.example.com/base/", "https://agents.example.com/base/api/ingest/agents"],
    ["http://localhost:3000", "http://localhost:3000/api/ingest/agents"],
    ["http://127.42.0.7:3000", "http://127.42.0.7:3000/api/ingest/agents"],
    ["http://[::1]:3000", "http://[::1]:3000/api/ingest/agents"],
  ])("accepts secure or explicit loopback endpoint %s", (input, expected) => {
    expect(getIngestEndpoint(input).href).toBe(expected);
  });

  it.each([
    "http://agents.example.com",
    "http://10.0.0.5:3000",
    "http://127.0.0.1.example.com",
    "ftp://agents.example.com",
  ])("rejects unsafe endpoint %s", (input) => {
    expect(() => getIngestEndpoint(input)).toThrow(/must use HTTPS/);
  });

  it("rejects credentials embedded in the collector URL", () => {
    expect(() => getIngestEndpoint("https://user:secret@agents.example.com"))
      .toThrow(/must not contain credentials/);
  });
});

describe("collector execution bounds (issue #99)", () => {
  it("terminates a sleeping OpenClaw executable at the child timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pixel-collector-"));
    const executable = join(directory, "openclaw-sleep");

    try {
      await writeFile(executable, "#!/usr/bin/env node\nsetTimeout(() => {}, 1_000);\n");
      await chmod(executable, 0o755);

      let failure;
      try {
        fetchOpenClawSessions({
          openclawBin: executable,
          activeMinutes: "30",
          timeoutMs: 50,
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: "ETIMEDOUT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("aborts a non-responsive ingest endpoint at the HTTP timeout", async () => {
    const server = createServer(() => {});
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let watchdogTimer;

    try {
      const address = server.address();
      const endpoint = new URL(`http://127.0.0.1:${address.port}/api/ingest/agents`);

      const request = postSnapshot({
        endpoint,
        ingestToken: "test-token",
        payload: { sessions: [], generatedAt: "2026-08-02T00:00:00.000Z" },
        timeoutMs: 50,
      });
      const watchdog = new Promise((_, reject) => {
        watchdogTimer = setTimeout(
          () => reject(new Error("HTTP timeout regression watchdog fired")),
          2_000,
        );
      });

      await expect(Promise.race([request, watchdog]))
        .rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      clearTimeout(watchdogTimer);
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("passes the reviewed absolute CLI path and timeout to execFileSync", async () => {
    const calls = [];
    await runCollector({
      argv: ["--dry-run"],
      env: {
        PIXEL_AGENTS_URL: "http://localhost:3000",
        PIXEL_INGEST_TOKEN: "test-token",
        OPENCLAW_BIN: "/opt/openclaw/bin/openclaw",
      },
      execFile: (...args) => {
        calls.push(args);
        return JSON.stringify({ sessions: [] });
      },
      stdout: () => {},
      stderr: () => {},
    });

    expect(calls).toEqual([[
      "/opt/openclaw/bin/openclaw",
      ["sessions", "--all-agents", "--json", "--active", "30"],
      expect.objectContaining({ timeout: 10_000, killSignal: "SIGKILL" }),
    ]]);
  });

  it("keeps session metadata out of dry-run output", async () => {
    const output = [];
    await runCollector({
      argv: ["--dry-run"],
      env: {
        PIXEL_AGENTS_URL: "http://localhost:3000",
        PIXEL_INGEST_TOKEN: "test-token",
        OPENCLAW_BIN: "/opt/openclaw/bin/openclaw",
      },
      execFile: () => JSON.stringify({
        sessions: [{ sessionId: "private-session-metadata" }],
      }),
      fetchImpl: () => {
        throw new Error("dry-run must not send an HTTP request");
      },
      stdout: (...parts) => output.push(parts.join(" ")),
      stderr: () => {},
    });

    expect(output).toEqual([
      "[dry-run] Would POST to: http://localhost:3000/api/ingest/agents",
      "[dry-run] Payload sessions: 1",
    ]);
    expect(JSON.stringify(output)).not.toContain("private-session-metadata");
  });

  it("rejects a PATH-resolved OpenClaw executable", async () => {
    await expect(runCollector({
      argv: ["--dry-run"],
      env: {
        PIXEL_AGENTS_URL: "http://localhost:3000",
        PIXEL_INGEST_TOKEN: "test-token",
        OPENCLAW_BIN: "openclaw",
      },
    })).rejects.toThrow(/must be an absolute path/);
  });
});

describe("collector systemd boundary (issue #99)", () => {
  it("bounds startup and full-control-group termination to 30 seconds", async () => {
    const unit = await readFile(
      resolve(process.cwd(), "collector/systemd/openclaw-pixel-collector.service"),
      "utf8",
    );

    expect(unit).toContain("TimeoutStartSec=25s");
    expect(unit).toContain("TimeoutStopSec=5s");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("SendSIGKILL=true");
  });

  it("provides a minimal reviewed PATH for env-based Node launchers", async () => {
    const unit = await readFile(
      resolve(process.cwd(), "collector/systemd/openclaw-pixel-collector.service"),
      "utf8",
    );

    expect(unit).toContain("Environment=PATH=/usr/local/bin:/usr/bin:/bin");
    expect(unit).not.toContain(".npm-global");
  });
});
