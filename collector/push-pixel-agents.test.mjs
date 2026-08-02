import { execFileSync as runProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

  it("rejects redirects without replaying the snapshot to the target", async () => {
    let targetRequests = 0;
    const target = createServer((_request, response) => {
      targetRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ agents: 1, received: 1 }));
    });
    await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();

    const redirector = createServer((_request, response) => {
      response.writeHead(307, {
        location: `http://127.0.0.1:${targetAddress.port}/outside-policy`,
      });
      response.end();
    });
    await new Promise((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const redirectorAddress = redirector.address();

    try {
      await expect(postSnapshot({
        endpoint: new URL(`http://127.0.0.1:${redirectorAddress.port}/api/ingest/agents`),
        ingestToken: "test-token",
        payload: { sessions: [{ sessionId: "sensitive-session" }] },
        timeoutMs: 500,
      })).rejects.toThrow();
      expect(targetRequests).toBe(0);
    } finally {
      redirector.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise((resolve, reject) => redirector.close((error) => error ? reject(error) : resolve())),
        new Promise((resolve, reject) => target.close((error) => error ? reject(error) : resolve())),
      ]);
    }
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

  it("propagates a timeout while reading a successful response body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"agents":');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let watchdogTimer;

    try {
      const address = server.address();
      const request = postSnapshot({
        endpoint: new URL(`http://127.0.0.1:${address.port}/api/ingest/agents`),
        ingestToken: "test-token",
        payload: { sessions: [] },
        timeoutMs: 50,
      });
      const watchdog = new Promise((_, reject) => {
        watchdogTimer = setTimeout(
          () => reject(new Error("response-body timeout regression watchdog fired")),
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

  it("rejects malformed JSON from a successful response", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not-json");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      await expect(postSnapshot({
        endpoint: new URL(`http://127.0.0.1:${address.port}/api/ingest/agents`),
        ingestToken: "test-token",
        payload: { sessions: [] },
        timeoutMs: 500,
      })).rejects.toBeInstanceOf(SyntaxError);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("passes the reviewed absolute CLI path and timeout to execFileSync", async () => {
    const calls = [];
    const collectorEnv = {
      PIXEL_AGENTS_URL: "http://localhost:3000",
      PIXEL_INGEST_TOKEN: "test-token",
      OPENCLAW_BIN: "/opt/openclaw/bin/openclaw",
      PATH: "/usr/bin:/bin",
    };
    await runCollector({
      argv: ["--dry-run"],
      env: collectorEnv,
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
    expect(calls[0][2].env).toEqual({
      PIXEL_AGENTS_URL: "http://localhost:3000",
      OPENCLAW_BIN: "/opt/openclaw/bin/openclaw",
      PATH: "/usr/bin:/bin",
    });
  });

  it("runs through a symlinked entrypoint instead of exiting successfully as a no-op", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pixel-collector-entrypoint-"));
    const linkedCollector = join(directory, "collector-link.mjs");
    const fakeOpenClaw = join(directory, "openclaw-fixture");

    try {
      await symlink(resolve(process.cwd(), "collector/push-pixel-agents.mjs"), linkedCollector);
      await writeFile(
        fakeOpenClaw,
        "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ sessions: [] }));\n",
      );
      await chmod(fakeOpenClaw, 0o755);
      const env = {
        ...process.env,
        PIXEL_AGENTS_URL: "http://localhost:3000",
        PIXEL_INGEST_TOKEN: "test-token",
        OPENCLAW_BIN: fakeOpenClaw,
      };

      const directOutput = runProcess(
        process.execPath,
        [resolve(process.cwd(), "collector/push-pixel-agents.mjs"), "--dry-run"],
        { encoding: "utf8", env },
      );
      const symlinkOutput = runProcess(
        process.execPath,
        [linkedCollector, "--dry-run"],
        { encoding: "utf8", env },
      );

      expect(directOutput).toContain("[dry-run] Payload sessions: 0");
      expect(symlinkOutput).toBe(directOutput);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it.each([
    ["an object without sessions", "{}"],
    ["a top-level array", "[]"],
  ])("rejects %s instead of clearing the current snapshot", (_label, raw) => {
    expect(() => fetchOpenClawSessions({
      openclawBin: "/opt/openclaw/bin/openclaw",
      activeMinutes: "30",
      execFile: () => raw,
    })).toThrow(/sessions array/);
  });

  it("accepts an explicitly empty sessions array", () => {
    expect(fetchOpenClawSessions({
      openclawBin: "/opt/openclaw/bin/openclaw",
      activeMinutes: "30",
      execFile: () => JSON.stringify({ sessions: [] }),
    })).toEqual([]);
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

  it("aligns the first PATH directory with the reviewed ExecStart Node", async () => {
    const unit = await readFile(
      resolve(process.cwd(), "collector/systemd/openclaw-pixel-collector.service"),
      "utf8",
    );

    const execStartNode = unit.match(/^ExecStart=(\S+)/m)?.[1];
    const servicePath = unit.match(/^Environment=PATH=(.+)$/m)?.[1];

    expect(execStartNode).toBeTruthy();
    expect(servicePath).toBeTruthy();
    expect(servicePath.split(":")[0]).toBe(dirname(execStartNode));
    expect(unit).not.toContain(".npm-global");
  });
});
