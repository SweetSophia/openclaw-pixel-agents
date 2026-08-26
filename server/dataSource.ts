export type ConfiguredDataSource = "auto" | "cli" | "ingest";
export type EffectiveDataSource = "cli-poll" | "ingest-only";
export type CliFailureKind = "operator-action-required" | "transient";
export type CliPollLogAction = "none" | "incident" | "reminder" | "recovered";

export type CliPollHealth = Readonly<{
  consecutiveFailures: number;
  lastFailureKind: CliFailureKind | null;
}>;

export const INITIAL_CLI_POLL_HEALTH: CliPollHealth = Object.freeze({
  consecutiveFailures: 0,
  lastFailureKind: null,
});

const CLI_POLL_REMINDER_INTERVAL = 20;

export function updateCliPollHealth(
  health: CliPollHealth,
  failureKind: CliFailureKind | null,
): Readonly<{ health: CliPollHealth; action: CliPollLogAction }> {
  if (failureKind === null) {
    return Object.freeze({
      health: INITIAL_CLI_POLL_HEALTH,
      action: health.consecutiveFailures === 0 ? "none" : "recovered",
    });
  }

  const kindChanged = health.lastFailureKind !== failureKind;
  const consecutiveFailures = kindChanged ? 1 : health.consecutiveFailures + 1;
  const nextHealth = Object.freeze({
    consecutiveFailures,
    lastFailureKind: failureKind,
  });
  const action = kindChanged
    ? "incident"
    : consecutiveFailures % CLI_POLL_REMINDER_INTERVAL === 0
      ? "reminder"
      : "none";

  return Object.freeze({ health: nextHealth, action });
}

/** Keep CLI session output capacity aligned with the standalone collector. */
export const OPENCLAW_SESSIONS_EXEC_OPTIONS = Object.freeze({
  timeout: 10_000,
  maxBuffer: 10 * 1024 * 1024,
});

const PERMANENT_CLI_EXEC_ERROR_CODES = new Set([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "EACCES",
  "EPERM",
  "ENOEXEC",
  "EFTYPE",
  "ELOOP",
  "ENAMETOOLONG",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
]);

export type DataSourceState = Readonly<{
  configured: ConfiguredDataSource;
  effective: EffectiveDataSource;
  hasIngestToken: boolean;
  transitioned: boolean;
}>;

/** Create the initial state for the data-source finite-state machine. */
export function createInitialDataSourceState(
  configured: ConfiguredDataSource,
  hasIngestToken: boolean,
): DataSourceState {
  return Object.freeze({
    configured,
    effective: configured === "ingest" ? "ingest-only" : "cli-poll",
    hasIngestToken,
    transitioned: false,
  });
}

/** Classify failures that require an operator/configuration change to recover. */
export function classifyCliExecError(error: unknown): CliFailureKind {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && PERMANENT_CLI_EXEC_ERROR_CODES.has(code)) {
      return "operator-action-required";
    }
  }
  return "transient";
}

/**
 * Apply CLI failure policy with hysteresis: auto mode may transition once and
 * then remains ingest-only, preventing ownership from oscillating.
 */
export function applyCliFailure(
  state: DataSourceState,
  failure: CliFailureKind,
): DataSourceState {
  if (
    state.configured !== "auto"
    || !state.hasIngestToken
    || state.effective !== "cli-poll"
    || state.transitioned
    || failure !== "operator-action-required"
  ) {
    return state;
  }

  return Object.freeze({
    ...state,
    effective: "ingest-only",
    transitioned: true,
  });
}

export function isCliPollingActive(state: DataSourceState): boolean {
  return state.effective === "cli-poll";
}

export function isIngestWritesActive(state: DataSourceState): boolean {
  return state.effective === "ingest-only";
}
