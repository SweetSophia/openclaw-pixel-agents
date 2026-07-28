import { describe, expect, it } from "vitest";
import {
  applyCliFailure,
  classifyCliExecError,
  createInitialDataSourceState,
  isCliPollingActive,
  isIngestWritesActive,
  type CliFailureKind,
  type ConfiguredDataSource,
} from "./dataSource";

describe("data-source policy", () => {
  it.each([
    ["auto", false, "cli-poll"],
    ["auto", true, "cli-poll"],
    ["cli", false, "cli-poll"],
    ["cli", true, "cli-poll"],
    ["ingest", false, "ingest-only"],
    ["ingest", true, "ingest-only"],
  ] as const)(
    "initializes %s with token=%s as %s",
    (configured, hasIngestToken, effective) => {
      const state = createInitialDataSourceState(configured, hasIngestToken);

      expect(state).toEqual({
        configured,
        effective,
        hasIngestToken,
        transitioned: false,
      });
      expect(Object.isFrozen(state)).toBe(true);
    },
  );

  it.each([
    ["auto", false, "missing-executable", "cli-poll", false],
    ["auto", false, "transient", "cli-poll", false],
    ["auto", true, "missing-executable", "ingest-only", true],
    ["auto", true, "transient", "cli-poll", false],
    ["cli", false, "missing-executable", "cli-poll", false],
    ["cli", true, "missing-executable", "cli-poll", false],
    ["cli", true, "transient", "cli-poll", false],
    ["ingest", false, "missing-executable", "ingest-only", false],
    ["ingest", true, "missing-executable", "ingest-only", false],
    ["ingest", true, "transient", "ingest-only", false],
  ] as const)(
    "%s with token=%s and %s remains/transitions to %s",
    (configured, hasIngestToken, failure, effective, transitioned) => {
      const initial = createInitialDataSourceState(configured, hasIngestToken);
      const next = applyCliFailure(initial, failure);

      expect(next.effective).toBe(effective);
      expect(next.transitioned).toBe(transitioned);
      expect(Object.isFrozen(next)).toBe(true);
    },
  );

  it("makes the fallback transition sticky and idempotent", () => {
    const initial = createInitialDataSourceState("auto", true);
    const transitioned = applyCliFailure(initial, "missing-executable");

    expect(applyCliFailure(transitioned, "missing-executable")).toBe(transitioned);
    expect(applyCliFailure(transitioned, "transient")).toBe(transitioned);
    expect(transitioned.effective).toBe("ingest-only");
  });

  it.each([
    [{ code: "ENOENT" }, "missing-executable"],
    [{ code: "ENOTDIR" }, "missing-executable"],
    [{ code: 1 }, "transient"],
    [{ code: "EACCES" }, "transient"],
    [{ code: "ETIMEDOUT", killed: true }, "transient"],
    [{ killed: true, signal: "SIGTERM" }, "transient"],
    [new SyntaxError("bad JSON"), "transient"],
    [new Error("unknown"), "transient"],
    [null, "transient"],
  ] as const)("classifies %# as %s", (error, expected) => {
    expect(classifyCliExecError(error)).toBe(expected);
  });

  it.each([
    ["auto", false, undefined, true, false],
    ["auto", true, undefined, true, false],
    ["auto", true, "transient", true, false],
    ["auto", true, "missing-executable", false, true],
    ["cli", true, "missing-executable", true, false],
    ["ingest", true, undefined, false, true],
  ] as const)(
    "enforces one writer for %s with token=%s and failure=%s",
    (configured, hasIngestToken, failure, cliActive, ingestActive) => {
      let state = createInitialDataSourceState(
        configured as ConfiguredDataSource,
        hasIngestToken,
      );
      if (failure) state = applyCliFailure(state, failure as CliFailureKind);

      expect(isCliPollingActive(state)).toBe(cliActive);
      expect(isIngestWritesActive(state)).toBe(ingestActive);
      expect(Number(cliActive) + Number(ingestActive)).toBe(1);
    },
  );
});
