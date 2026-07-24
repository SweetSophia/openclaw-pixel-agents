import { isAbsolute, relative, resolve, sep } from "node:path";

export interface CliSession {
  key: string;
  agentId: string;
  model?: string;
  modelProvider?: string;
  totalTokens?: number | null;
  contextTokens?: number | null;
  updatedAt?: number | null;
  kind?: string;
  status?: string;
  abortedLastRun?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  sessionId?: string;
}

export type IngestSessionValidationError = {
  code:
    | "sessions-not-array"
    | "too-many-sessions"
    | "invalid-session-object"
    | "reserved-field"
    | "invalid-key"
    | "unknown-agent"
    | "invalid-string"
    | "invalid-number"
    | "invalid-boolean"
    | "invalid-session-id";
  sessionIndex?: number;
  field?: keyof CliSession;
};

export type ParseIngestSessionsResult =
  | { ok: true; sessions: CliSession[] }
  | { ok: false; error: IngestSessionValidationError };

type ParseIngestSessionResult =
  | { ok: true; session: CliSession }
  | { ok: false; error: IngestSessionValidationError };

const RESERVED_SESSION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const KEY_MAX_LENGTH = 512;
const STRING_LIMITS: Partial<Record<keyof CliSession, number>> = {
  model: 256,
  modelProvider: 128,
  kind: 64,
  status: 64,
};
const NUMBER_FIELDS = [
  "inputTokens",
  "outputTokens",
] as const satisfies readonly (keyof CliSession)[];
const NULLABLE_NUMBER_FIELDS = [
  "totalTokens",
  "contextTokens",
  "updatedAt",
] as const satisfies readonly (keyof CliSession)[];
const BOOLEAN_FIELDS = [
  "abortedLastRun",
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
  if (Object.keys(value).some((key) => RESERVED_SESSION_KEYS.has(key))) {
    return invalid("reserved-field");
  }
  if (!isBoundedString(value.key, KEY_MAX_LENGTH)) return invalid("invalid-key", "key");
  if (typeof value.agentId !== "string" || !knownAgentIds.has(value.agentId)) {
    return invalid("unknown-agent", "agentId");
  }

  const session: CliSession = {
    key: value.key,
    agentId: value.agentId,
  };
  const sessionRecord = session as unknown as Record<string, unknown>;

  for (const [field, maxLength] of Object.entries(STRING_LIMITS) as [keyof CliSession, number][]) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !isBoundedString(fieldValue, maxLength)) {
      return invalid("invalid-string", field);
    }
    if (fieldValue !== undefined) sessionRecord[field] = fieldValue;
  }
  for (const field of NUMBER_FIELDS) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !isNonNegativeSafeInteger(fieldValue)) {
      return invalid("invalid-number", field);
    }
    if (fieldValue !== undefined) sessionRecord[field] = fieldValue;
  }
  for (const field of NULLABLE_NUMBER_FIELDS) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && fieldValue !== null && !isNonNegativeSafeInteger(fieldValue)) {
      return invalid("invalid-number", field);
    }
    if (fieldValue !== undefined) sessionRecord[field] = fieldValue;
  }
  for (const field of BOOLEAN_FIELDS) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && typeof fieldValue !== "boolean") {
      return invalid("invalid-boolean", field);
    }
    if (fieldValue !== undefined) sessionRecord[field] = fieldValue;
  }
  if (
    value.sessionId !== undefined
    && (typeof value.sessionId !== "string" || !OPAQUE_SESSION_ID_RE.test(value.sessionId))
  ) {
    return invalid("invalid-session-id", "sessionId");
  }
  if (value.sessionId !== undefined) session.sessionId = value.sessionId;

  return {
    ok: true,
    session,
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
