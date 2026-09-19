import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server as SocketIOServer } from "socket.io";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { boundTickerMessageId } from "./index";

describe("transcript ticker boundary", () => {
  let dataDir: string;
  let sessionsDir: string;
  let io: SocketIOServer;
  let tailTranscript: typeof import("./index").tailTranscript;

  const makeLine = (content: string, metadata: Record<string, unknown> = {}) =>
    `${JSON.stringify({
      role: "assistant",
      content,
      timestamp: Date.now(),
      ...metadata,
    })}\n`;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pixel-agents-ticker-test-"));
    sessionsDir = join(dataDir, "agents", "main", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("DATA_SOURCE", "ingest");
    vi.stubEnv("INGEST_API_TOKEN", "ticker-test-secret");
    vi.stubEnv("OPENCLAW_AGENTS_DIR", join(dataDir, "agents"));
    vi.stubEnv("NODE_ENV", "test");

    vi.resetModules();
    const serverModule = await import("./index");
    io = serverModule.io;
    tailTranscript = serverModule.tailTranscript;
  });

  afterAll(() => {
    io.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resets the cursor when a transcript is truncated in place", async () => {
    const transcriptPath = join(sessionsDir, "truncated.jsonl");
    writeFileSync(transcriptPath, makeLine("message before truncation is deliberately longer"));

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toHaveLength(1);

    writeFileSync(transcriptPath, makeLine("new line after truncation"));

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ text: "new line after truncation" }),
    ]);
  });

  it("resets after copy-truncate even when the rewritten file regrows past the cursor", async () => {
    const transcriptPath = join(sessionsDir, "copy-truncate-regrown.jsonl");
    writeFileSync(transcriptPath, makeLine("short original message"));

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toHaveLength(1);

    writeFileSync(
      transcriptPath,
      `${makeLine("rewritten first message after copy truncate")}${makeLine("rewritten second message")}`,
    );

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ text: "rewritten first message after copy truncate" }),
      expect.objectContaining({ text: "rewritten second message" }),
    ]);
  });

  it("detects a same-length copy-truncate rewrite that preserves the old suffix", async () => {
    const transcriptPath = join(sessionsDir, "copy-truncate-suffix-collision.jsonl");
    const sharedSuffix = "z".repeat(200);
    const timestamp = Date.now();
    const originalLine = makeLine(`first record ${sharedSuffix}`, { timestamp });
    const rewrittenLine = makeLine(`other record ${sharedSuffix}`, { timestamp });
    expect(Buffer.byteLength(rewrittenLine)).toBe(Buffer.byteLength(originalLine));
    writeFileSync(transcriptPath, originalLine);

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toHaveLength(1);

    writeFileSync(
      transcriptPath,
      `${rewrittenLine}${makeLine("record appended after same-size rewrite")}`,
    );

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ text: expect.stringMatching(/^other record z+$/) }),
      expect.objectContaining({ text: "record appended after same-size rewrite" }),
    ]);
  });

  it("detects a rewritten prefix when the last committed record is unchanged", async () => {
    const transcriptPath = join(sessionsDir, "copy-truncate-unchanged-last.jsonl");
    const timestamp = Date.now();
    const first = makeLine("first prefix record", {
      timestamp,
      __openclaw: { id: "prefix-a" },
    });
    const replacement = makeLine("other prefix record", {
      timestamp,
      __openclaw: { id: "prefix-c" },
    });
    const unchanged = makeLine("unchanged trailing record", {
      timestamp,
      __openclaw: { id: "prefix-b" },
    });
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(first));
    writeFileSync(transcriptPath, `${first}${unchanged}`);

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toHaveLength(2);

    writeFileSync(
      transcriptPath,
      `${replacement}${unchanged}${makeLine("new record after rewritten prefix", {
        __openclaw: { id: "prefix-d" },
      })}`,
    );

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ id: "prefix-c", text: "other prefix record" }),
      expect.objectContaining({ id: "prefix-d", text: "new record after rewritten prefix" }),
    ]);
  });

  it("resets the cursor when a transcript path is replaced during rotation", async () => {
    const transcriptPath = join(sessionsDir, "rotated.jsonl");
    const rotatedPath = join(sessionsDir, "rotated.jsonl.1");
    writeFileSync(transcriptPath, makeLine("old inode message is deliberately longer"));

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toHaveLength(1);

    renameSync(transcriptPath, rotatedPath);
    writeFileSync(transcriptPath, makeLine("new inode message"));

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ text: "new inode message" }),
    ]);
  });

  it("drains an append made to the opened inode immediately before rotation", async () => {
    const transcriptPath = join(sessionsDir, "rotated-during-read.jsonl");
    const rotatedPath = join(sessionsDir, "rotated-during-read.jsonl.1");
    writeFileSync(transcriptPath, makeLine("record before rotation window"));

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toHaveLength(1);

    await expect(
      tailTranscript("main", "Shodan", transcriptPath, {
        afterInitialStat: () => {
          appendFileSync(transcriptPath, makeLine("late record on old inode"));
          renameSync(transcriptPath, rotatedPath);
          writeFileSync(transcriptPath, makeLine("record on replacement inode"));
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ text: "late record on old inode" }),
    ]);

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ text: "record on replacement inode" }),
    ]);
  });

  it.each([
    { label: "string", timestamp: "not-a-number" },
    { label: "object", timestamp: {} },
    { label: "array", timestamp: [] },
  ])("drops messages with an invalid $label timestamp", async ({ label, timestamp }) => {
    const transcriptPath = join(
      sessionsDir,
      `invalid-timestamp-${label}.jsonl`,
    );
    writeFileSync(
      transcriptPath,
      `${makeLine("invalid timestamp message", { timestamp })}${makeLine("valid timestamp message")}`,
    );

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ text: "valid timestamp message" }),
    ]);
  });

  it("drops a timestamp that parses as non-finite", async () => {
    const transcriptPath = join(sessionsDir, "non-finite-timestamp.jsonl");
    const nonFiniteLine = '{"role":"assistant","content":"non finite timestamp","timestamp":1e400}\n';
    writeFileSync(transcriptPath, `${nonFiniteLine}${makeLine("valid timestamp after infinity")}`);

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ text: "valid timestamp after infinity" }),
    ]);
  });

  it("replaces an oversized transcript message id with a bounded synthetic id", async () => {
    const transcriptPath = join(sessionsDir, "oversized-id.jsonl");
    const oversizedId = "x".repeat(129);
    writeFileSync(
      transcriptPath,
      makeLine("message with oversized id", {
        __openclaw: { id: oversizedId },
      }),
    );

    const [message] = await tailTranscript("main", "Shodan", transcriptPath);

    expect(message).toBeDefined();
    expect(message.id).not.toBe(oversizedId);
    expect(message.id.length).toBeLessThanOrEqual(128);
  });

  it("replaces an untyped transcript message id with a bounded synthetic id", async () => {
    const transcriptPath = join(sessionsDir, "untyped-id.jsonl");
    writeFileSync(
      transcriptPath,
      makeLine("message with object id", { __openclaw: { id: { nested: true } } }),
    );

    const [message] = await tailTranscript("main", "Shodan", transcriptPath);

    expect(message).toBeDefined();
    expect(message.id).toEqual(expect.any(String));
    expect(message.id.length).toBeLessThanOrEqual(128);
  });

  it("clamps the synthetic id and preserves the digest tail (issue #215)", async () => {
    // Regression: the synthetic id path was `${agentId}-${digest32}`,
    // whose length is unbounded if `agentId` is long. The naive fix was
    // `candidate.slice(0, TICKER_MAX_ID_CHARS)` which would strip the
    // digest entirely if `agentId` reached 128 chars, collapsing every
    // message for that agent to the same id and suppressing all but
    // the first. The correct fix truncates the agentId prefix only,
    // keeping the 32-char digest intact at the tail.
    //
    // Two messages, same long agentId, different content → different
    // synthetic ids (digest differs). Both ids end with their respective
    // 32-char digest (the digest portion is preserved). Both ids are ≤
    // TICKER_MAX_ID_CHARS.
    const longAgentId = "a" + "x".repeat(63); // 64 chars total, valid identifier
    const longAgentSessionsDir = join(dataDir, "agents", longAgentId, "sessions");
    mkdirSync(longAgentSessionsDir, { recursive: true });
    const transcriptPath = join(longAgentSessionsDir, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      [
        makeLine("message one", { __openclaw: { id: undefined } }),
        makeLine("message two", { __openclaw: { id: undefined } }),
      ].join(""),
    );

    const messages = await tailTranscript(longAgentId, "Shodan", transcriptPath);

    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m.id.length).toBeLessThanOrEqual(128);
      expect(m.id.length).toBeGreaterThan(0);
      // The synthetic id must keep the digest (last 32 hex chars). If the
      // naive `slice(0, TICKER_MAX_ID_CHARS)` were applied to an agentId
      // long enough to overflow, the digest would be stripped — this
      // assertion catches that regression.
      expect(m.id).toMatch(/-[0-9a-f]{32}$/);
    }
    // Different messages → different digests → different ids.
    expect(messages[0]?.id).not.toBe(messages[1]?.id);
  });

  it("preserves a valid bounded transcript message id", async () => {
    const transcriptPath = join(sessionsDir, "valid-id.jsonl");
    writeFileSync(
      transcriptPath,
      makeLine("message with valid id", { __openclaw: { id: "valid-message-id" } }),
    );

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ id: "valid-message-id" }),
    ]);
  });

  it("accounts for invalid UTF-8 by raw bytes without duplicating prior records", async () => {
    const transcriptPath = join(sessionsDir, "invalid-utf8.jsonl");
    writeFileSync(
      transcriptPath,
      Buffer.concat([
        Buffer.from(makeLine("valid record before invalid bytes")),
        Buffer.from([0xff, 0x0a]),
      ]),
    );

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ text: "valid record before invalid bytes" }),
    ]);

    appendFileSync(transcriptPath, makeLine("valid record after invalid bytes"));

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ text: "valid record after invalid bytes" }),
    ]);
  });

  it("assembles a large record split across many chunks correctly (issue #216)", async () => {
    // Regression: the previous `pending = Buffer.concat([pending, contentSegment])`
    // inside the per-chunk loop was O(n^2) for an n-byte record split
    // across many chunks. The fix accumulates segments in an array and
    // concatenates once per record (at the newline terminator). This
    // regression pins correctness with a large record that exercises
    // many chunks (text is truncated to TICKER_MAX_CHARS at the message
    // boundary, so we assert on the truncated length, not the source).
    const transcriptPath = join(sessionsDir, "large-record.jsonl");
    const largeText = "x".repeat(64 * 1024);
    writeFileSync(transcriptPath, makeLine(largeText));

    const [message] = await tailTranscript("main", "Shodan", transcriptPath);

    expect(message).toBeDefined();
    // Text is truncated to TICKER_MAX_CHARS (150) at message construction.
    expect(message.text.length).toBe(150);
    // All 150 chars must be the same `x` content (no truncation mid-byte
    // crossing chunk boundaries).
    expect(message.text).toBe("x".repeat(150));
  });

  it("skips prefix rehashing on append-only polls (issue #217)", async () => {
    // Issue #217: the post-read digest re-verification rehashes the
    // entire committed prefix on every poll. For append-only workloads
    // (an active agent appending every cycle), the prefix `[0,
    // committedOffset]` is unchanged by appends but mtime grows on every
    // write — so the existing `|| finalStat.mtimeMs !== baselineModifiedMs`
    // gate fires on every poll.
    //
    // This regression is INTENTIONALLY WEAK: it just verifies that
    // correctness holds across several append-only polls. A real perf
    // fix (incremental digest state in the cursor, or a smarter gate
    // that distinguishes append-only from in-place rewrite) is tracked
    // separately — the simple size-only gate approach leaves
    // in-place rewrite tests vulnerable. Don't tighten this test
    // without also re-asserting the copy-truncate / same-length-rewrite
    // / rewritten-prefix tests above.
    const transcriptPath = join(sessionsDir, "append-only.jsonl");
    writeFileSync(transcriptPath, makeLine("first message"));

    const baseline = await tailTranscript("main", "Shodan", transcriptPath);
    expect(baseline).toHaveLength(1);

    let totalSeen = 1;
    for (let i = 0; i < 5; i += 1) {
      appendFileSync(transcriptPath, makeLine(`append ${i + 1}`));
      const next = await tailTranscript("main", "Shodan", transcriptPath);
      totalSeen += next.length;
    }

    // All 6 records (1 initial + 5 appends) should be returned across
    // the polls. Correctness must hold even though we're not asserting
    // on the per-poll behavior (issue #217's perf claim is not validated
    // by this test — see the comment above).
    expect(totalSeen).toBe(6);
  });

  it("skips an oversized record while advancing to the next complete record", async () => {
    const transcriptPath = join(sessionsDir, "oversized-record.jsonl");
    writeFileSync(
      transcriptPath,
      `${"x".repeat(1024 * 1024 + 1)}\n${makeLine("valid record after oversized record")}`,
    );

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ text: "valid record after oversized record" }),
    ]);
    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([]);
  });

  it("does not advance past a partial trailing JSONL record", async () => {
    const transcriptPath = join(sessionsDir, "partial.jsonl");
    const completeLine = makeLine("complete line before partial record");
    const completedLater = makeLine("partial line completed later");
    writeFileSync(
      transcriptPath,
      `${completeLine}${completedLater.slice(0, -1)}`,
    );

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ text: "complete line before partial record" }),
    ]);

    writeFileSync(transcriptPath, `${completeLine}${completedLater}`);

    await expect(
      tailTranscript("main", "Shodan", transcriptPath),
    ).resolves.toEqual([
      expect.objectContaining({ text: "partial line completed later" }),
    ]);
  });
});

describe("boundTickerMessageId", () => {
  it("preserves the digest tail even when agentId alone would overflow the cap (issue #215)", () => {
    // The naive fix would slice the entire candidate, stripping the
    // digest and collapsing every message for that agent to the same
    // id (suppressed by `seenIds`). The correct fix truncates the
    // agentId prefix only, so the 32-char digest is always intact at
    // the tail and different messages produce different ids.
    const digest32 = "f".repeat(32);
    const longAgentId = "a".repeat(200); // 200 chars — well past TICKER_MAX_ID_CHARS

    const id = boundTickerMessageId(null, longAgentId, digest32);

    expect(id.length).toBeLessThanOrEqual(128);
    // Digest tail preserved.
    expect(id).toMatch(/-f{32}$/);
    // Synthetic id starts with the truncated agentId (first 95 chars).
    expect(id.startsWith(longAgentId.slice(0, 95))).toBe(true);
  });

  it("returns the rawId when it is within the cap", () => {
    expect(boundTickerMessageId("short-id", "agent", "f".repeat(32))).toBe("short-id");
  });

  it("falls back to synthetic when rawId is empty", () => {
    expect(boundTickerMessageId("", "agent", "f".repeat(32))).toBe("agent-" + "f".repeat(32));
  });

  it("falls back to synthetic when rawId is null", () => {
    expect(boundTickerMessageId(null, "agent", "f".repeat(32))).toBe("agent-" + "f".repeat(32));
  });

  it("clamps rawId that exceeds the cap (defensive)", () => {
    const longRaw = "r".repeat(200);
    const id = boundTickerMessageId(longRaw, "agent", "f".repeat(32));
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it("produces different ids for different digests at the same agentId", () => {
    const id1 = boundTickerMessageId(null, "agent", "1".repeat(32));
    const id2 = boundTickerMessageId(null, "agent", "2".repeat(32));
    expect(id1).not.toBe(id2);
  });
});
