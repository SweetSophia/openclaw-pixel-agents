import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isTranscriptPathContained,
  parseIngestSessions,
  resolveTranscriptPath,
} from "./ingestSessions";
import upstreamFixture from "./fixtures/openclaw-sessions-v2026.7.2.json";

const knownAgentIds = new Set(["main", "cybera"]);

const validSession = {
  key: "agent:main:telegram:direct:123",
  agentId: "main",
  model: "gpt-5",
  modelProvider: "openai",
  totalTokens: 1234,
  contextTokens: 200000,
  updatedAt: 1_753_300_000_000,
  kind: "direct",
  label: "Primary session",
  status: "active",
  abortedLastRun: false,
  inputTokens: 100,
  outputTokens: 200,
  sessionId: "123e4567-e89b-12d3-a456-426614174000",
  thinkingLevel: "high",
  ageMs: 1000,
  acpRuntime: false,
  agentRuntime: { id: "codex", source: "openclaw" },
  lastInteractionAt: 1_753_300_000_000,
  modelOverride: "gpt-5",
  providerOverride: "openai",
  reasoningLevel: "high",
  sessionFile: "/home/test/.openclaw/agents/main/sessions/session.jsonl",
  sessionStartedAt: 1_753_299_000_000,
  systemSent: true,
  totalTokensFresh: true,
};

describe("parseIngestSessions", () => {
  it("accepts the current collector session schema", () => {
    expect(parseIngestSessions([validSession], knownAgentIds)).toEqual({
      ok: true,
      sessions: [{
        key: validSession.key,
        agentId: validSession.agentId,
        model: validSession.model,
        modelProvider: validSession.modelProvider,
        totalTokens: validSession.totalTokens,
        contextTokens: validSession.contextTokens,
        updatedAt: validSession.updatedAt,
        kind: validSession.kind,
        status: validSession.status,
        abortedLastRun: validSession.abortedLastRun,
        inputTokens: validSession.inputTokens,
        outputTokens: validSession.outputTokens,
        sessionId: validSession.sessionId,
      }],
    });
  });

  it("accepts and sanitizes a captured upstream session shape", () => {
    const result = parseIngestSessions(upstreamFixture.sessions, knownAgentIds);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.sessions).toEqual([
      {
        key: "agent:main:subagent:fixture",
        agentId: "main",
        model: "gpt-5",
        modelProvider: "openai",
        totalTokens: 1234,
        contextTokens: 200000,
        updatedAt: null,
        kind: "subagent",
        status: "active",
        abortedLastRun: false,
        inputTokens: 100,
        outputTokens: 200,
        sessionId: "123e4567-e89b-12d3-a456-426614174000",
      },
    ]);
    expect(result.sessions[0]).not.toHaveProperty("spawnedBy");
    expect(result.sessions[0]).not.toHaveProperty("sessionFile");
  });

  it.each([
    "../outside",
    "..\\outside",
    "/tmp/outside",
    "C:\\outside",
    "nested/session",
  ])("rejects unsafe sessionId %s", (sessionId) => {
    expect(
      parseIngestSessions([{ ...validSession, sessionId }], knownAgentIds),
    ).toEqual({
      ok: false,
      error: {
        code: "invalid-session-id",
        sessionIndex: 0,
        field: "sessionId",
      },
    });
  });

  it("rejects non-string sub-agent keys before mapping", () => {
    expect(parseIngestSessions([
      { ...validSession, kind: "subagent", key: 123 },
    ], knownAgentIds)).toEqual({
      ok: false,
      error: {
        code: "invalid-key",
        sessionIndex: 0,
        field: "key",
      },
    });
  });

  it("rejects unknown agents and overlong known fields while dropping unknown fields", () => {
    expect(parseIngestSessions([
      { ...validSession, agentId: "unknown" },
    ], knownAgentIds)).toMatchObject({
      ok: false,
      error: { code: "unknown-agent" },
    });
    expect(parseIngestSessions([
      { ...validSession, unexpected: true },
    ], knownAgentIds)).toMatchObject({
      ok: true,
      sessions: [expect.not.objectContaining({ unexpected: true })],
    });
    expect(parseIngestSessions([
      { ...validSession, model: "x".repeat(257) },
    ], knownAgentIds)).toMatchObject({
      ok: false,
      error: { code: "invalid-string", field: "model" },
    });
  });

  it.each([
    "__proto__",
    "constructor",
    "prototype",
  ])("rejects reserved object key %s instead of copying it", (reservedKey) => {
    const session = JSON.parse(
      `{"key":"agent:main:test","agentId":"main","${reservedKey}":{"polluted":true}}`,
    );

    expect(parseIngestSessions([session], knownAgentIds)).toMatchObject({
      ok: false,
      error: { code: "reserved-field" },
    });
  });
});

describe("transcript path containment", () => {
  const agentsDir = "/srv/openclaw/agents";

  it("resolves an opaque session ID inside the registered agent's sessions directory", () => {
    const transcriptPath = resolveTranscriptPath(
      agentsDir,
      "main",
      "123e4567-e89b-12d3-a456-426614174000",
    );

    expect(transcriptPath).toBe(
      resolve(
        agentsDir,
        "main",
        "sessions",
        "123e4567-e89b-12d3-a456-426614174000.jsonl",
      ),
    );
    expect(isTranscriptPathContained(agentsDir, "main", transcriptPath!)).toBe(true);
  });

  it("rejects paths outside the expected agent sessions directory at the sink", () => {
    expect(
      isTranscriptPathContained(
        agentsDir,
        "main",
        resolve(agentsDir, "cybera", "sessions", "session.jsonl"),
      ),
    ).toBe(false);
    expect(
      isTranscriptPathContained(agentsDir, "main", "/tmp/outside.jsonl"),
    ).toBe(false);
    expect(
      isTranscriptPathContained(agentsDir, "../../tmp", "/tmp/session.jsonl"),
    ).toBe(false);
    expect(
      resolveTranscriptPath(agentsDir, "../../tmp", "session"),
    ).toBeNull();
  });
});
