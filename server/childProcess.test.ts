import type { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("CLI child-process environment", () => {
  let io: typeof import("./index").io | undefined;
  let pollSessions: typeof import("./index").pollSessions;

  beforeAll(async () => {
    vi.stubEnv("DATA_SOURCE", "ingest");
    vi.stubEnv("INGEST_API_TOKEN", "must-not-reach-child");
    vi.stubEnv("PIXEL_CHILD_ENV_SENTINEL", "preserved");
    vi.resetModules();
    const serverModule = await import("./index");
    io = serverModule.io;
    pollSessions = serverModule.pollSessions;
  });

  afterAll(() => {
    io?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does not pass INGEST_API_TOKEN to the OpenClaw CLI while preserving unrelated variables", async () => {
    const execFileStub = vi.fn((...args: unknown[]) => {
      const options = args[2] as { env?: NodeJS.ProcessEnv };
      const callback = args[3] as (error: null, stdout: string, stderr: string) => void;

      expect(options.env).not.toHaveProperty("INGEST_API_TOKEN");
      expect(options.env).toMatchObject({ PIXEL_CHILD_ENV_SENTINEL: "preserved" });
      callback(null, JSON.stringify({ sessions: [], count: 0 }), "");
      return {};
    });

    await expect(pollSessions(execFileStub as unknown as typeof execFile))
      .resolves.toEqual({ sessions: [], count: 0 });
    expect(execFileStub).toHaveBeenCalledOnce();
    expect(process.env.INGEST_API_TOKEN).toBe("must-not-reach-child");
  });

  it("removes differently-cased ingest token keys from the CLI environment", async () => {
    vi.stubEnv("Ingest_Api_Token", "mixed-case-secret");
    const execFileStub = vi.fn((...args: unknown[]) => {
      const options = args[2] as { env: NodeJS.ProcessEnv };
      expect(
        Object.keys(options.env).some(
          key => key.toUpperCase() === "INGEST_API_TOKEN",
        ),
      ).toBe(false);
      const callback = args[3] as (error: null, stdout: string, stderr: string) => void;
      callback(null, '{"sessions":[],"count":0}', "");
    });

    await expect(pollSessions(execFileStub as unknown as typeof execFile))
      .resolves.toMatchObject({ sessions: [], count: 0 });
  });
});
