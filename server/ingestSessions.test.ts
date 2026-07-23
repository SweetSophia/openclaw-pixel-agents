import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isTranscriptPathContained,
  parseIngestSessions,
  resolveTranscriptPath,
} from "./ingestSessions";

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
    expect(parseIngestSessions([validSession], knownAgentIds)).toEqual([validSession]);
  });

  it.each([
    "../outside",
    "..\\outside",
    "/tmp/outside",
    "C:\\outside",
    "nested/session",
  ])("rejects unsafe sessionId %s", (sessionId) => {
    expect(parseIngestSessions([{ ...validSession, sessionId }], knownAgentIds)).toBeNull();
  });

  it("rejects non-string sub-agent keys before mapping", () => {
    expect(parseIngestSessions([
      { ...validSession, kind: "subagent", key: 123 },
    ], knownAgentIds)).toBeNull();
  });

  it("rejects unknown agents, unknown fields, and overlong fields", () => {
    expect(parseIngestSessions([
      { ...validSession, agentId: "unknown" },
    ], knownAgentIds)).toBeNull();
    expect(parseIngestSessions([
      { ...validSession, unexpected: true },
    ], knownAgentIds)).toBeNull();
    expect(parseIngestSessions([
      { ...validSession, model: "x".repeat(257) },
    ], knownAgentIds)).toBeNull();
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
