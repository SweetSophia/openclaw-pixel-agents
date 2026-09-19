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
