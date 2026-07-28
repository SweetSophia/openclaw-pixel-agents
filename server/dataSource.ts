export type ConfiguredDataSource = "auto" | "cli" | "ingest";
export type EffectiveDataSource = "cli-poll" | "ingest-only";
export type CliFailureKind = "missing-executable" | "transient";

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

/** Only path-resolution failures prove that the configured CLI is unavailable. */
export function classifyCliExecError(error: unknown): CliFailureKind {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return "missing-executable";
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
    || failure !== "missing-executable"
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
