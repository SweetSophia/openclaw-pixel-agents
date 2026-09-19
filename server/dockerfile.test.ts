import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "Dockerfile"),
  "utf8",
);

describe("Dockerfile", () => {
  it("pins both stages to the same alpine index digest", () => {
    const fromLines = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(fromLines).toHaveLength(2);
    // Extract the version tag from the first FROM line so the assertion tracks
    // upstream Node bumps (Dependabot) without a per-bump test rewrite.
    const versionMatch = /^FROM node:([\d.]+-alpine)@sha256:([a-f0-9]{64})/.exec(fromLines[0]);
    expect(versionMatch).not.toBeNull();
    const [, version, digest] = versionMatch!;
    expect(fromLines[0]).toBe(`FROM node:${version}@sha256:${digest} AS builder`);
    expect(fromLines[1]).toBe(`FROM node:${version}@sha256:${digest}`);
  });

  it("healthchecks /api/status with Node fetch on process.env.PORT", () => {
    expect(dockerfile).toContain(
      "HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \\\n"
      + '  CMD ["node", "-e", "fetch(\'http://127.0.0.1:\'+(process.env.PORT||3001)+\'/api/status\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]',
    );
  });
});
