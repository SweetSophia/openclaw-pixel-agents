import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Mirrors server/dockerfile.test.ts: a static-parse assertion over the
// checked-in unit so a future edit cannot silently drop the hardening
// the reviewer added for issue #167.
const unitPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "collector",
  "systemd",
  "openclaw-pixel-collector.service",
);
const unit = readFileSync(unitPath, "utf8");

// Helper: extract an `active` (uncommented) directive from the [Service]
// section. The unit may contain a trailing commented template block
// listing opt-in directives; those must NOT be counted as enabled.
function activeDirectives(text: string): Map<string, string> {
  const directives = new Map<string, string>();
  let inService = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inService = line === "[Service]";
      continue;
    }
    if (!inService) continue;
    if (line.startsWith("#") || line === "") continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    directives.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return directives;
}

const ACTIVE = activeDirectives(unit);

describe("openclaw-pixel-collector.service hardening (issue #167)", () => {
  // Baseline directives — host-independent, always-on layer. Each boolean
  // directive is asserted with its exact "true" value rather than just
  // `has(...)`, so a future edit flipping one to "false" (or a typo) fails
  // the test rather than silently passing.
  it.each([
    "NoNewPrivileges",
    "PrivateDevices",
    "PrivateTmp",
    "ProtectClock",
    "ProtectControlGroups",
    "ProtectHostname",
    "ProtectKernelLogs",
    "ProtectKernelModules",
    "ProtectKernelTunables",
    "RestrictNamespaces",
    "RestrictRealtime",
    "RestrictSUIDSGID",
    "LockPersonality",
    "RemoveIPC",
  ])("enables %s=true", (directive) => {
    expect(ACTIVE.get(directive)).toBe("true");
  });

  it('RestrictAddressFamilies is locked to "AF_UNIX AF_INET AF_INET6"', () => {
    expect(ACTIVE.get("RestrictAddressFamilies")).toBe(
      "AF_UNIX AF_INET AF_INET6",
    );
  });

  it("drops all ambient capabilities (CapabilityBoundingSet is empty)", () => {
    expect(ACTIVE.get("CapabilityBoundingSet")).toBe("");
  });

  it("locks syscall arch to native only", () => {
    expect(ACTIVE.get("SystemCallArchitectures")).toBe("native");
  });

  it("tightens /proc to current-pid only", () => {
    expect(ACTIVE.get("ProtectProc")).toBe("invisible");
    expect(ACTIVE.get("ProcSubset")).toBe("pid");
  });

  // Host-dependent directives — must NOT be enabled by default but
  // must appear in the commented template so operators can opt in.
  it.each([
    "ProtectSystem",
    "ProtectHome",
    "PrivateUsers",
    // MemoryDenyWriteExecute is host-dependent too: it SIGTRAPs Node's
    // V8 JIT and any spawned V8-based binary (including possibly the
    // OpenClaw CLI). Operators must pair it with `--jitless` in ExecStart
    // for the collector and verify the OpenClaw CLI is not V8-based
    // before enabling. (Sourcery + Kody + Kilo all flagged MDWE in the
    // original PR #249 baseline.)
    "MemoryDenyWriteExecute",
  ])("leaves %s as a documented opt-in (commented)", (directive) => {
    expect(ACTIVE.has(directive)).toBe(false);
    // Must appear commented so operators can find the template.
    expect(unit).toMatch(new RegExp(`^\\s*#.*\\b${directive}\\b`, "m"));
  });

  it("ReadWritePaths appears in the opt-in template (commented)", () => {
    expect(ACTIVE.has("ReadWritePaths")).toBe(false);
    expect(unit).toMatch(/^\s*#.*\bReadWritePaths\b/m);
  });

  it("the opt-in block carries a guard for the home-directory contract", () => {
    // The original README contract was: preserve the OpenClaw CLI's
    // access to its owning account's home directory. The opt-in block
    // must warn operators that ProtectHome/PrivateUsers break that
    // contract and require explicit verification.
    //
    // Scope the assertion to the opt-in block so unrelated comments
    // elsewhere in the file (e.g. the ExecStart PATH comment) don't
    // accidentally satisfy it.
    const optInStart = unit.indexOf("Layered sandboxing beyond this line");
    const optInEnd = unit.indexOf("systemd-analyze security", optInStart);
    expect(optInStart).toBeGreaterThan(-1);
    expect(optInEnd).toBeGreaterThan(optInStart);
    const optInBlock = unit.slice(optInStart, optInEnd);
    expect(optInBlock).toMatch(/OpenClaw CLI/i);
    expect(optInBlock).toMatch(/verify|verification/i);
  });
});
