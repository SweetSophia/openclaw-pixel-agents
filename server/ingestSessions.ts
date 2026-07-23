import { isAbsolute, relative, resolve, sep } from "node:path";

export interface CliSession {
  key: string;
  agentId: string;
  model?: string;
  modelProvider?: string;
  totalTokens?: number | null;
  contextTokens?: number | null;
  updatedAt?: number;
  kind?: string;
  label?: string;
  status?: string;
  abortedLastRun?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  sessionId?: string;
  thinkingLevel?: string;
  ageMs?: number;
  acpRuntime?: boolean;
  agentRuntime?: {
    id?: string;
    source?: string;
  };
  lastInteractionAt?: number;
  modelOverride?: string;
  providerOverride?: string;
  reasoningLevel?: string;
  sessionFile?: string;
  sessionStartedAt?: number;
  systemSent?: boolean;
  totalTokensFresh?: boolean;
}

export type IngestSessionValidationError = {
  code:
    | "sessions-not-array"
    | "too-many-sessions"
    | "invalid-session-object"
    | "unknown-field"
    | "invalid-key"
    | "unknown-agent"
    | "invalid-string"
    | "invalid-number"
    | "invalid-boolean"
    | "invalid-session-id"
    | "invalid-agent-runtime";
  sessionIndex?: number;
  field?: keyof CliSession;
};

export type ParseIngestSessionsResult =
  | { ok: true; sessions: CliSession[] }
  | { ok: false; error: IngestSessionValidationError };

type ParseIngestSessionResult =
  | { ok: true; session: CliSession }
  | { ok: false; error: IngestSessionValidationError };

const SESSION_KEYS = new Set<keyof CliSession>([
  "key",
  "agentId",
  "model",
  "modelProvider",
  "totalTokens",
  "contextTokens",
  "updatedAt",
  "kind",
  "label",
  "status",
  "abortedLastRun",
  "inputTokens",
  "outputTokens",
  "sessionId",
  "thinkingLevel",
  "ageMs",
  "acpRuntime",
  "agentRuntime",
  "lastInteractionAt",
  "modelOverride",
  "providerOverride",
  "reasoningLevel",
  "sessionFile",
  "sessionStartedAt",
  "systemSent",
  "totalTokensFresh",
]);
const AGENT_RUNTIME_KEYS = new Set(["id", "source"]);
const KEY_MAX_LENGTH = 512;
const STRING_LIMITS: Partial<Record<keyof CliSession, number>> = {
  model: 256,
  modelProvider: 128,
  kind: 64,
  label: 256,
  status: 64,
  thinkingLevel: 64,
  modelOverride: 256,
  providerOverride: 128,
  reasoningLevel: 64,
  sessionFile: 4096,
};
const NUMBER_FIELDS = [
  "updatedAt",
  "inputTokens",
  "outputTokens",
  "ageMs",
  "lastInteractionAt",
  "sessionStartedAt",
] as const satisfies readonly (keyof CliSession)[];
const NULLABLE_NUMBER_FIELDS = [
  "totalTokens",
  "contextTokens",
] as const satisfies readonly (keyof CliSession)[];
const BOOLEAN_FIELDS = [
  "abortedLastRun",
  "acpRuntime",
  "systemSent",
  "totalTokensFresh",
] as const satisfies readonly (keyof CliSession)[];
const OPAQUE_AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const OPAQUE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isAgentRuntime(value: unknown): value is NonNullable<CliSession["agentRuntime"]> {
  if (!isPlainObject(value)) return false;
  if (!Object.keys(value).every((key) => AGENT_RUNTIME_KEYS.has(key))) return false;
  return (value.id === undefined || isBoundedString(value.id, 128))
    && (value.source === undefined || isBoundedString(value.source, 128));
}

function parseIngestSession(
  value: unknown,
  knownAgentIds: ReadonlySet<string>,
  sessionIndex: number,
): ParseIngestSessionResult {
  const invalid = (
    code: IngestSessionValidationError["code"],
    field?: keyof CliSession,
  ): ParseIngestSessionResult => ({
    ok: false,
    error: { code, sessionIndex, ...(field ? { field } : {}) },
  });

  if (!isPlainObject(value)) return invalid("invalid-session-object");
  if (!Object.keys(value).every((key) => SESSION_KEYS.has(key as keyof CliSession))) {
    return invalid("unknown-field");
  }
  if (!isBoundedString(value.key, KEY_MAX_LENGTH)) return invalid("invalid-key", "key");
  if (typeof value.agentId !== "string" || !knownAgentIds.has(value.agentId)) {
    return invalid("unknown-agent", "agentId");
  }

  for (const [field, maxLength] of Object.entries(STRING_LIMITS) as [keyof CliSession, number][]) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !isBoundedString(fieldValue, maxLength)) {
      return invalid("invalid-string", field);
    }
  }
  for (const field of NUMBER_FIELDS) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !isNonNegativeSafeInteger(fieldValue)) {
      return invalid("invalid-number", field);
    }
  }
  for (const field of NULLABLE_NUMBER_FIELDS) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && fieldValue !== null && !isNonNegativeSafeInteger(fieldValue)) {
      return invalid("invalid-number", field);
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && typeof fieldValue !== "boolean") {
      return invalid("invalid-boolean", field);
    }
  }
  if (
    value.sessionId !== undefined
    && (typeof value.sessionId !== "string" || !OPAQUE_SESSION_ID_RE.test(value.sessionId))
  ) {
    return invalid("invalid-session-id", "sessionId");
  }
  if (value.agentRuntime !== undefined && !isAgentRuntime(value.agentRuntime)) {
    return invalid("invalid-agent-runtime", "agentRuntime");
  }

  const session = { ...value };
  // `sessionFile` is an absolute path on the collector host. Accept it as part
  // of the current CLI schema, but never carry that foreign path into server
  // state; transcript access is derived solely from the validated session ID.
  delete session.sessionFile;

  return {
    ok: true,
    session: session as unknown as CliSession,
  };
}

export function parseIngestSessions(
  value: unknown,
  knownAgentIds: ReadonlySet<string>,
): ParseIngestSessionsResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: { code: "sessions-not-array" } };
  }
  if (value.length > 50) {
    return { ok: false, error: { code: "too-many-sessions" } };
  }

  const sessions: CliSession[] = [];
  for (const [sessionIndex, candidate] of value.entries()) {
    const result = parseIngestSession(candidate, knownAgentIds, sessionIndex);
    if (!result.ok) return result;
    sessions.push(result.session);
  }
  return { ok: true, sessions };
}

function isContained(expectedDir: string, candidatePath: string): boolean {
  const candidateRelativePath = relative(expectedDir, candidatePath);
  return candidateRelativePath !== ""
    && !isAbsolute(candidateRelativePath)
    && candidateRelativePath !== ".."
    && !candidateRelativePath.startsWith(`..${sep}`);
}

export function resolveTranscriptPath(
  agentsDir: string,
  agentId: string,
  sessionId: string,
): string | null {
  if (!OPAQUE_AGENT_ID_RE.test(agentId) || !OPAQUE_SESSION_ID_RE.test(sessionId)) {
    return null;
  }
  const expectedDir = resolve(agentsDir, agentId, "sessions");
  const candidatePath = resolve(expectedDir, `${sessionId}.jsonl`);
  return isContained(expectedDir, candidatePath) ? candidatePath : null;
}

export function isTranscriptPathContained(
  agentsDir: string,
  agentId: string,
  transcriptPath: string,
): boolean {
  if (!OPAQUE_AGENT_ID_RE.test(agentId)) return false;
  const expectedDir = resolve(agentsDir, agentId, "sessions");
  return isContained(expectedDir, resolve(transcriptPath));
}
