import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "Dockerfile"),
  "utf8",
);

describe("Dockerfile", () => {
  it("pins both stages to a Node 22.22.2 alpine index digest", () => {
    const fromLines = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(fromLines).toHaveLength(2);
    for (const line of fromLines) {
      expect(line).toMatch(/^FROM node:22\.22\.2-alpine@sha256:[a-f0-9]{64}(?: AS builder)?$/);
    }
    expect(fromLines[0]).toContain(" AS builder");
    expect(fromLines[1]).not.toContain(" AS ");
  });

  it("healthchecks /api/status with Node fetch", () => {
    expect(dockerfile).toMatch(/HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \\/);
    expect(dockerfile).toContain("/api/status");
    expect(dockerfile).toContain('CMD ["node", "-e"');
    expect(dockerfile).toContain("process.exit(r.ok?0:1)");
  });
});
