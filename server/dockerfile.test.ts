import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "Dockerfile"),
  "utf8",
);

describe("Dockerfile", () => {
  it("pins both stages to the same Node 22.22.2 alpine index digest", () => {
    const fromLines = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(fromLines).toHaveLength(2);
    const digest = /@sha256:([a-f0-9]{64})/.exec(fromLines[0])?.[1];
    expect(fromLines[0]).toBe(`FROM node:22.22.2-alpine@sha256:${digest} AS builder`);
    expect(fromLines[1]).toBe(`FROM node:22.22.2-alpine@sha256:${digest}`);
  });

  it("healthchecks /api/status with Node fetch on process.env.PORT", () => {
    expect(dockerfile).toContain(
      "HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \\\n"
      + '  CMD ["node", "-e", "fetch(\'http://127.0.0.1:\'+(process.env.PORT||3001)+\'/api/status\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]',
    );
  });
});
