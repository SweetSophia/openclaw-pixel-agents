import { describe, expect, it } from "vitest";
import {
  applyCliFailure,
  classifyCliExecError,
  createInitialDataSourceState,
  isCliPollingActive,
  isIngestWritesActive,
  OPENCLAW_SESSIONS_EXEC_OPTIONS,
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
    ["auto", false, "operator-action-required", "cli-poll", false],
    ["auto", false, "transient", "cli-poll", false],
    ["auto", true, "operator-action-required", "ingest-only", true],
    ["auto", true, "transient", "cli-poll", false],
    ["cli", false, "operator-action-required", "cli-poll", false],
    ["cli", true, "operator-action-required", "cli-poll", false],
    ["cli", true, "transient", "cli-poll", false],
    ["ingest", false, "operator-action-required", "ingest-only", false],
    ["ingest", true, "operator-action-required", "ingest-only", false],
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
    const transitioned = applyCliFailure(initial, "operator-action-required");

    expect(applyCliFailure(transitioned, "operator-action-required")).toBe(transitioned);
    expect(applyCliFailure(transitioned, "transient")).toBe(transitioned);
    expect(transitioned.effective).toBe("ingest-only");
  });

  it.each([
    [{ code: "ENOENT" }, "operator-action-required"],
    [{ code: "ENOTDIR" }, "operator-action-required"],
    [{ code: "EACCES" }, "operator-action-required"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "operator-action-required"],
    [{ code: 1 }, "transient"],
    [{ code: "ETIMEDOUT", killed: true }, "transient"],
    [{ killed: true, signal: "SIGTERM" }, "transient"],
    [new SyntaxError("bad JSON"), "transient"],
    [new Error("unknown"), "transient"],
    [null, "transient"],
  ] as const)("classifies %# as %s", (error, expected) => {
    expect(classifyCliExecError(error)).toBe(expected);
  });

  it.each(["EACCES", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"])(
    "transitions auto mode with an ingest token after permanent %s failures",
    (code) => {
      const initial = createInitialDataSourceState("auto", true);
      const failure = classifyCliExecError({ code });
      const next = applyCliFailure(initial, failure);

      expect(failure).toBe("operator-action-required");
      expect(next).toEqual({
        configured: "auto",
        effective: "ingest-only",
        hasIngestToken: true,
        transitioned: true,
      });
    },
  );

  it("caps CLI session output at the collector's 10 MiB contract", () => {
    expect(OPENCLAW_SESSIONS_EXEC_OPTIONS).toEqual({
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(Object.isFrozen(OPENCLAW_SESSIONS_EXEC_OPTIONS)).toBe(true);
  });

  it.each([
    ["auto", false, undefined, true, false],
    ["auto", true, undefined, true, false],
    ["auto", true, "transient", true, false],
    ["auto", true, "operator-action-required", false, true],
    ["cli", true, "operator-action-required", true, false],
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
