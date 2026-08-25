/**
 * OpenClaw Pixel Agents — Backend Server
 *
 * Polls the OpenClaw Gateway for agent states via the CLI and exposes them via REST + WebSocket.
 * Uses `openclaw sessions --all-agents --json` as the data source — simpler and more stable
 * than implementing the full Gateway WebSocket protocol.
 */

import { execFile } from "node:child_process";
import { isIP } from "node:net";
import express from "express";
import helmet from "helmet";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { open as openAsync, type FileHandle } from "node:fs/promises";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { applyAgentSnapshot } from "./agentSnapshots";
import { correlationMiddleware, httpRequestLogMiddleware } from "./correlation";
import { createCorsConfig, isOriginAllowed } from "./cors";
import {
  applyCliFailure,
  classifyCliExecError,
  createInitialDataSourceState,
  isCliPollingActive,
  isIngestWritesActive,
  type CliFailureKind,
  type ConfiguredDataSource,
} from "./dataSource";
import { apiErrorHandler, registerProcessErrorHandlers } from "./errors";
import {
  isTranscriptPathContained,
  parseIngestSessions,
  resolveTranscriptPath,
  type CliSession,
} from "./ingestSessions";
import { isValidLayoutId } from "./layouts";
import { logger } from "./logger";
import { parseLayoutMutationBody, parseOfficeLayoutDoc, parsePersistedPrefs, parseRecipe, parseSpriteBody, parseTagsBody, parseToggleBody, type OfficeLayoutDoc, type PersistedPrefs } from "./validation";
import { ALL_TAGS, TAG_COLORS, DEFAULT_ROOMS, resolveRoomByTags, type AgentState, type AgentActivity, type SubAgentInfo, type TickerMessage, type Room, type AgentTag } from "../shared/types";
const app = express();
const server = createServer(app);
const corsConfig = createCorsConfig();

/**
 * Reverse-proxy trust contract (issue #125 review, P1).
 *
 * Default: no proxy trust — `req.ip` is the direct socket peer, the safe
 * default for direct exposure. Without trust, every browser behind one
 * reverse proxy would share a single public-GET rate bucket, letting one
 * noisy client deny the dashboard to all others.
 *
 * `TRUST_PROXY` opts in explicitly for documented reverse-proxy deployments
 * (see README "Reverse-proxy deployments"):
 *   - unset / "false" / "0"   -> trust nobody (default)
 *   - integer string ("1", …) -> trust that many proxy hops (Express
 *     `trust proxy <n>` semantics); use the exact hop count of the deployed
 *     proxy chain so the client IP is read from the correct
 *     X-Forwarded-For position
 *   - comma-separated IPs/CIDRs or presets ("10.0.0.0/8,127.0.0.1",
 *     "loopback", "linklocal", "uniquelocal") -> trust those proxy
 *     addresses only
 *
 * "true"/unrestricted trust is deliberately NOT accepted: with no proxy in
 * front, clients could spoof X-Forwarded-For and each forged value would
 * get its own rate bucket, defeating the limiter entirely. Only enable
 * this when the front proxy overwrites client-supplied forwarding headers.
 *
 * Malformed values fail fast at startup with a descriptive error naming
 * the accepted forms — never as an opaque TypeError from deep inside
 * Express, and never by silently falling back to no trust (which would
 * reintroduce the all-users-share-one-bucket collapse).
 */
const TRUST_PROXY_PRESETS = new Set(["loopback", "linklocal", "uniquelocal"]);

/** One TRUST_PROXY list entry: a bare IP, an IP/prefix-length CIDR, or a
 * documented preset. Deliberately stricter than proxy-addr: no DNS
 * hostnames, no wildcard octets — operators state exact addresses. */
function isTrustProxyEntry(entry: string): boolean {
  if (TRUST_PROXY_PRESETS.has(entry)) return true;
  const slash = entry.indexOf("/");
  if (slash === -1) return isIP(entry) !== 0;
  const addr = entry.slice(0, slash);
  const prefix = entry.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  const family = isIP(addr);
  // Prefix length 0 ("0.0.0.0/0", "::/0") matches every address of the
  // family — semantically unrestricted trust, which this contract rejects
  // — and proxy-addr's compile() additionally throws an opaque
  // "invalid range on address" TypeError on /0 CIDRs (review repro).
  if (bits < 1) return false;
  if (family === 6) return bits <= 128;
  return family === 4 && bits <= 32;
}

export function parseTrustProxy(raw: string | undefined): number | string[] | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value || value === "false" || value === "0") return undefined;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops > 0 && String(hops) === value) return hops;
  const entries = value.split(",").map(s => s.trim()).filter(Boolean);
  if (entries.length === 0 || !entries.every(isTrustProxyEntry)) {
    throw new Error(
      `Invalid TRUST_PROXY value: "${raw}". Accepted forms: unset/"false"/"0" (no proxy trust, default), ` +
      `a positive integer (trusted proxy hop count, e.g. "1"), or a comma-separated list of proxy ` +
      `IPs/CIDRs (prefix length 1-32 for IPv4, 1-128 for IPv6) or the presets loopback/linklocal/uniquelocal ` +
      `(e.g. "10.0.0.0/8,127.0.0.1"). ` +
      `Unrestricted "true" is deliberately rejected: without a controlled proxy that overwrites ` +
      `X-Forwarded-For, clients could forge forwarding headers and defeat per-client rate limiting. ` +
      `See README "Reverse-proxy deployments".`,
    );
  }
  return entries;
}
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== undefined) {
  app.set("trust proxy", trustProxy);
  logger.info({ trustProxy, subsystem: "server" }, "Reverse-proxy trust configured");
}

const io = new SocketIOServer(server, {
  cors: {
    origin: corsConfig.socketOrigin,
  },
});

// WebSocket origin validation
io.engine.on("initial_headers", (_headers, req: any) => {
  if (!isOriginAllowed(req.headers.origin, corsConfig)) {
    // Send explicit 403 before destroying to avoid noisy engine.io error logs
    req.socket?.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    req.socket?.destroy();
  }
});

// Security headers (OWASP A05:2021, CWE-693)
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  // 'unsafe-inline' needed for React-emitted inline styles; nonce migration
  // tracked for future hardening. Google Fonts CSS is loaded via <link> in index.html.
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com"],
  imgSrc: ["'self'", "data:"],
  // WebSocket scheme-source. Per CSP3, the ws scheme-source token covers both
  // plain and TLS WebSocket connections; the standalone secure variant is
  // technically redundant but kept for defensive clarity and CSP-linter
  // compatibility (Sourcery flags a scheme-source-only directive as ambiguous).
  connectSrc: ["'self'", "ws:", "wss:"],
  // Defense-in-depth: lock down <base>, <object>, and <form> targets against
  // any future XSS vector even though no such sinks exist today.
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

const isProd = process.env.NODE_ENV === "production";

// Helmet owns every security header it supports. The explicit configuration
// preserves the application's pre-Helmet policy instead of accepting Helmet's
// broader defaults:
//   - CSP keeps the tested Google Fonts and WebSocket allowances, while
//     useDefaults:false avoids adding upgrade-insecure-requests in local dev.
//   - HSTS remains production-only with the existing two-year max age.
//   - X-Frame-Options stays DENY and Referrer-Policy retains its exact value.
// COEP (require-corp) stays off: it would gate every subresource on
// third-party CORP responses (Google Fonts CSS/woff2), which cannot be
// verified from CI — the strict CSP already binds loadable sources.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: CSP_DIRECTIVES,
    },
    strictTransportSecurity: isProd
      ? { maxAge: 63072000, includeSubDomains: true }
      : false,
    xFrameOptions: { action: "deny" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use((_req, res, next) => {
  // Helmet does not provide Permissions-Policy middleware.
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.use(correlationMiddleware);
app.use(httpRequestLogMiddleware);
app.use(express.json({ limit: "100kb" }));

// Serve built frontend in production (Vite output is in dist/client, server is compiled to dist/server/index.js).
// FRONTEND_DIR is env-overridable for HTTP-level tests (issue #125).
const FRONTEND_DIR = process.env.FRONTEND_DIR || resolve(__dirname, "..", "..", "client");
if (existsSync(FRONTEND_DIR)) {
  // Throttle unauthenticated GET/HEAD traffic before the static middleware so
  // express.static's filesystem access is rate-limited per IP (issue #125).
  // The middleware itself skips /api paths — see publicGetRateLimiter.
  app.use(publicGetRateLimiter);
  app.use(express.static(FRONTEND_DIR));
}

// ---- Configuration ----

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "3000", 10);
const ACTIVE_THRESHOLD_MIN = parseInt(process.env.ACTIVE_MINUTES || "30", 10);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const PERSIST_PATH = join(DATA_DIR, "agent-prefs.json");
const INGEST_TOKEN = process.env.INGEST_API_TOKEN || "";
/** Base directory for OpenClaw agent session transcripts */
const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || join(process.env.HOME || "/root", ".openclaw", "agents");

/**
 * Data source mode:
 *   "auto"    — try CLI polling; if openclaw not found and ingest token is set, use ingest-only
 *   "cli"     — always poll via local openclaw CLI (original behavior)
 *   "ingest"  — only accept pushed data via the ingest API (no local CLI needed)
 */
const configuredDataSource = (process.env.DATA_SOURCE || "auto").toLowerCase();
// Unknown values fail safe to auto, which keeps CLI as the initial writer.
const DATA_SOURCE: ConfiguredDataSource = configuredDataSource === "cli"
  || configuredDataSource === "ingest"
  ? configuredDataSource
  : "auto";
let dataSourceState = createInitialDataSourceState(DATA_SOURCE, !!INGEST_TOKEN);

// ---- Known agents from config ----

interface KnownAgent {
  id: string;
  name: string;
  pixelEnabled: boolean;
  characterSpriteId?: string;
  tags: AgentTag[];
  /** Paperdoll recipe: body/hair/outfit indices */
  recipe?: { bodyIndex: number; hairIndex: number; outfitIndex: number };
}

/** Default agent definitions */
function defaultRegistry(): Map<string, KnownAgent> {
  return new Map([
    ["main", { id: "main", name: "Shodan", pixelEnabled: true, tags: ["orchestration", "research"] }],
    ["miku", { id: "miku", name: "Miku", pixelEnabled: true, tags: ["creative", "media"] }],
    ["chi", { id: "chi", name: "Chi", pixelEnabled: true, tags: ["research", "analysis"] }],
    ["sysauxilia", { id: "sysauxilia", name: "Sysauxilia", pixelEnabled: true, tags: ["infrastructure", "monitoring"] }],
    ["descartes", { id: "descartes", name: "Descartes", pixelEnabled: true, tags: ["research", "analysis"] }],
    ["cyberlogis", { id: "cyberlogis", name: "Cyberlogis", pixelEnabled: true, tags: ["coding", "logic"] }],
    ["cylena", { id: "cylena", name: "Cylena", pixelEnabled: true, tags: ["coding", "frontend"] }],
    ["cybera", { id: "cybera", name: "Cybera", pixelEnabled: true, tags: ["coding", "infrastructure"] }],
  ]);
}

/** Load persisted agent preferences (pixelEnabled, spriteId, tags, recipe) from disk */
function loadPersistedPrefs(): Map<string, PersistedPrefs> {
  try {
    if (!existsSync(PERSIST_PATH)) return new Map();
    const raw = readFileSync(PERSIST_PATH, "utf-8");
    const data = JSON.parse(raw);
    const map = new Map<string, PersistedPrefs>();

    for (const [k, v] of Object.entries(data)) {
      const prefs = parsePersistedPrefs(v);
      if (prefs) {
        map.set(k, prefs);
      } else {
        logger.warn({ agentId: k, subsystem: "prefs" }, "skipping invalid persisted prefs");
      }
    }
    return map;
  } catch (err) {
    logger.warn({ err, subsystem: "prefs" }, "failed to load persisted prefs");
    return new Map();
  }
}

/** Save agent preferences to disk */
function savePersistedPrefs() {
  try {
    const prefs: Record<string, { pixelEnabled: boolean; characterSpriteId?: string; tags: AgentTag[]; recipe?: { bodyIndex: number; hairIndex: number; outfitIndex: number } }> = {};
    for (const [id, agent] of AGENT_REGISTRY) {
      prefs[id] = { pixelEnabled: agent.pixelEnabled, characterSpriteId: agent.characterSpriteId, tags: agent.tags, recipe: agent.recipe };
    }
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PERSIST_PATH, JSON.stringify(prefs, null, 2));
  } catch (err) {
    logger.error({ err, subsystem: "persist" }, "failed to save prefs");
  }
}

// Build registry from defaults + persisted prefs
const AGENT_REGISTRY = defaultRegistry();
const savedPrefs = loadPersistedPrefs();
for (const [id, prefs] of savedPrefs) {
  const agent = AGENT_REGISTRY.get(id);
  if (agent) {
    if (prefs.pixelEnabled !== undefined) agent.pixelEnabled = prefs.pixelEnabled;
    if (prefs.characterSpriteId !== undefined) agent.characterSpriteId = prefs.characterSpriteId;
    if (prefs.tags !== undefined) agent.tags = prefs.tags;
    if (prefs.recipe !== undefined) agent.recipe = prefs.recipe;
  }
}

// ---- Rooms ----

const rooms: Room[] = [...DEFAULT_ROOMS];

/** Determine which room an agent should be in based on their first tag.
 *  Shared helper — see shared/types.ts for the implementation. */
const resolveRoom = resolveRoomByTags;

// ---- State ----

const agentStates = new Map<string, AgentState>();
/** Transcript paths discovered from CLI session data, keyed by agentId */
const agentTranscriptPaths = new Map<string, string>();

// ---- CLI data source ----

interface CliSessionsResult {
  sessions: CliSession[];
  count: number;
  sourceError?: boolean;
  cliFailureKind?: CliFailureKind;
}

/**
 * Poll OpenClaw sessions via CLI.
 *
 * Uses `openclaw sessions --all-agents --json --active <minutes>` to get
 * recently-active sessions, then maps them to agent states.
 */
function pollSessions(): Promise<CliSessionsResult> {
  return new Promise((resolve) => {
    const args = [
      "sessions",
      "--all-agents",
      "--json",
      "--active", String(ACTIVE_THRESHOLD_MIN),
    ];

    execFile(OPENCLAW_BIN, args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        const cliFailureKind = classifyCliExecError(err);
        logger.error({ err, subsystem: "poll" }, "cli error");
        resolve({ sessions: [], count: 0, sourceError: true, cliFailureKind });
        return;
      }

      try {
        const data = JSON.parse(stdout);
        resolve({
          sessions: data.sessions || [],
          count: data.count || 0,
        });
      } catch (parseErr) {
        logger.error({ err: parseErr, subsystem: "poll" }, "json parse error");
        resolve({ sessions: [], count: 0, sourceError: true, cliFailureKind: "transient" });
      }
    });
  });
}

/**
 * Determine agent activity from session data.
 *
 * Heuristics:
 * - recently updated + high output tokens → typing/running
 * - recently updated + high input tokens → reading
 * - moderate staleness → thinking
 * - stale → idle/sleeping
 */
function inferActivity(session: CliSession): AgentActivity {
  const updatedAt = session.updatedAt;
  if (!updatedAt) return "idle";

  const ageMs = Date.now() - updatedAt;
  const ageMin = ageMs / 60000;

  // Very stale → sleeping
  if (ageMin > ACTIVE_THRESHOLD_MIN) return "sleeping";
  // Quite stale → idle
  if (ageMin > 10) return "idle";

  // Active session — infer from token patterns
  const hasOutput = (session.outputTokens ?? 0) > 100;
  const hasInput = (session.inputTokens ?? 0) > 500;

  if (ageMin < 2 && hasOutput) return "typing";
  if (ageMin < 2 && hasInput) return "reading";

  if (ageMin < 5) return "thinking";

  return "idle";
}

/**
 * Map CLI session data to agent states.
 *
 * Aggregates sessions by agentId — picks the most recently updated session
 * to determine the agent's current activity.
 */
function mapToAgentStates(cliSessions: CliSession[]): Map<string, AgentState> {
  // Group sessions by agentId
  const byAgent = new Map<string, CliSession[]>();
  for (const s of cliSessions) {
    const agentId = s.agentId;
    if (!agentId) continue;
    const list = byAgent.get(agentId) || [];
    list.push(s);
    byAgent.set(agentId, list);
  }

  const results = new Map<string, AgentState>();

  // Process all registered agents (including those without active sessions)
  for (const [agentId, known] of AGENT_REGISTRY) {
    const sessions = byAgent.get(agentId);
    const sorted = sessions ? [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) : [];
    const latestSession = sorted[0];
    agentTranscriptPaths.delete(agentId);

    if (latestSession) {
      const activity = inferActivity(latestSession);
      const model = latestSession.model
        ? `${latestSession.modelProvider}/${latestSession.model}`
        : "unknown";

      // Capture transcript path for message ticker polling
      if (latestSession.sessionId) {
        const transcriptPath = resolveTranscriptPath(
          AGENTS_DIR,
          agentId,
          latestSession.sessionId,
        );
        if (transcriptPath) agentTranscriptPaths.set(agentId, transcriptPath);
      }

      results.set(agentId, {
        id: agentId,
        name: known.name,
        activity,
        model,
        sessionKey: latestSession.key,
        active: true,
        lastActivity: latestSession.updatedAt ?? Date.now(),
        tokens: latestSession.totalTokens
          ? {
            used: latestSession.totalTokens,
            limit: latestSession.contextTokens ?? 100000,
            inputTokens: latestSession.inputTokens,
            outputTokens: latestSession.outputTokens,
          }
          : undefined,
        characterSpriteId: known.characterSpriteId,
        pixelEnabled: known.pixelEnabled,
        tags: known.tags,
        recipe: known.recipe,
        roomId: resolveRoom(known.tags),
        subAgents: sessions
          ?.filter((s) => s.kind === "subagent")
          .map((s) => ({
            id: s.key,
            name: s.key.split("/").pop() || s.key,
            task: undefined,
            spawnedAt: s.updatedAt ?? Date.now(),
            status: s.status === "completed" ? "completed" as const : s.abortedLastRun ? "failed" as const : "running" as const,
          })),
        sessionUptime: latestSession.updatedAt ? (Date.now() - latestSession.updatedAt) / 1000 : undefined,
      });
    } else {
      // No active session — agent is sleeping
      results.set(agentId, {
        id: agentId,
        name: known.name,
        activity: "sleeping",
        model: "unknown",
        sessionKey: "",
        active: false,
        lastActivity: 0,
        characterSpriteId: known.characterSpriteId,
        pixelEnabled: known.pixelEnabled,
        tags: known.tags,
        recipe: known.recipe,
        roomId: resolveRoom(known.tags),
      });
    }
  }

  return results;
}

// ---- Message Ticker ----

/** Maximum messages to keep in the rolling buffer */
const TICKER_BUFFER_SIZE = 30;
/** Maximum characters per ticker message */
const TICKER_MAX_CHARS = 150;
/** Maximum characters accepted from an untrusted transcript message ID */
const TICKER_MAX_ID_CHARS = 128;
/** Maximum JSONL record size parsed into memory; oversized records are skipped */
const TICKER_MAX_RECORD_BYTES = 1024 * 1024;
/** How far back to look for messages (ms) */
const TICKER_MAX_AGE = 5 * 60 * 1000; // 5 minutes

const tickerMessages: TickerMessage[] = [];
/**
 * Track the byte offset of the last read position per transcript so we only
 * read newly-appended lines on each poll cycle instead of the whole file.
 */
interface TranscriptReadCursor {
  offset: number;
  device: number;
  inode: number;
  modifiedMs: number;
  digest: string;
  seenIds: string[];
}

const lastReadCursor = new Map<string, TranscriptReadCursor>();

const EMPTY_TRANSCRIPT_DIGEST = "0".repeat(64);

function advanceTranscriptDigest(
  digest: string,
  recordDigest: Buffer,
): string {
  return createHash("sha256")
    .update(Buffer.from(digest, "hex"))
    .update(recordDigest)
    .digest("hex");
}

async function readTranscriptDigest(
  fileHandle: FileHandle,
  length: number,
): Promise<string | null> {
  let digest = EMPTY_TRANSCRIPT_DIGEST;
  let recordHash = createHash("sha256");
  let recordLength = 0;
  const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(length, 1)));
  let bytesRemaining = length;
  let position = 0;

  while (bytesRemaining > 0) {
    const readLength = Math.min(buffer.length, bytesRemaining);
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      readLength,
      position,
    );
    if (bytesRead !== readLength) return null;

    let chunkOffset = 0;
    while (chunkOffset < bytesRead) {
      const newlineIndex = buffer.indexOf(0x0a, chunkOffset);
      const segmentEnd = newlineIndex === -1 || newlineIndex >= bytesRead
        ? bytesRead
        : newlineIndex + 1;
      const segment = buffer.subarray(chunkOffset, segmentEnd);
      recordHash.update(segment);
      recordLength += segment.length;
      if (newlineIndex === -1 || newlineIndex >= bytesRead) break;
      digest = advanceTranscriptDigest(digest, recordHash.digest());
      recordHash = createHash("sha256");
      recordLength = 0;
      chunkOffset = segmentEnd;
    }

    bytesRemaining -= bytesRead;
    position += bytesRead;
  }
  return recordLength === 0 ? digest : null;
}

/**
 * Extract displayable text from a message content block.
 * Returns the first text content found, truncated.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content.slice(0, TICKER_MAX_CHARS);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      // Skip non-text content blocks (thinking, tool calls, tool results)
      if (b.type === "thinking" || b.type === "tool_use" || b.type === "tool_result") continue;
      if (b.type === "text" && typeof b.text === "string") {
        return b.text.slice(0, TICKER_MAX_CHARS);
      }
    }
  }
  return "";
}

/**
 * Tail the transcript JSONL for a given session and extract new messages.
 * Uses a byte-offset to seek directly to the end of what was already read,
 * so each poll cycle reads only the newly-appended lines.
 */
export async function tailTranscript(
  agentId: string,
  agentName: string,
  transcriptPath: string | undefined,
  options: { afterInitialStat?: () => void | Promise<void> } = {},
): Promise<TickerMessage[]> {
  if (
    !transcriptPath
    || !isTranscriptPathContained(AGENTS_DIR, agentId, transcriptPath)
  ) {
    return [];
  }

  const key = `${agentId}:${transcriptPath}`;

  // Open first, then inspect and stream through the same descriptor. A path
  // lookup followed by a separate open can cross a rotation boundary and pair
  // one inode's identity with another inode's bytes.
  let fileHandle: FileHandle | undefined;
  try {
    fileHandle = await openAsync(transcriptPath, "r");
  } catch {
    // File doesn't exist or is unreadable — skip silently
    return [];
  }

  let fileSize: number;
  let device: number;
  let inode: number;
  let modifiedMs: number;
  let offset = 0;
  let digest = EMPTY_TRANSCRIPT_DIGEST;
  const previousCursor = lastReadCursor.get(key);
  const baselineSeenIds = new Set(previousCursor?.seenIds ?? []);
  let seenIds = new Set(baselineSeenIds);
  try {
    const fileStat = await fileHandle.stat();
    fileSize = fileStat.size;
    device = fileStat.dev;
    inode = fileStat.ino;
    modifiedMs = fileStat.mtimeMs;

    const sameFile = previousCursor?.device === device
      && previousCursor.inode === inode;
    if (sameFile && fileSize >= previousCursor.offset) {
      const metadataUnchanged = fileSize === previousCursor.offset
        && modifiedMs === previousCursor.modifiedMs;
      const prefixDigest = metadataUnchanged
        ? previousCursor.digest
        : await readTranscriptDigest(fileHandle, previousCursor.offset);
      if (prefixDigest === previousCursor.digest) {
        offset = previousCursor.offset;
        digest = previousCursor.digest;
      }
    }
  } catch {
    await fileHandle.close().catch(() => {});
    return [];
  }

  try {
    await options.afterInitialStat?.();
  } catch {
    await fileHandle.close().catch(() => {});
    return [];
  }

  const newMessages: TickerMessage[] = [];
  const processLine = (
    rawLine: Buffer,
    recordDigest: Buffer,
    messages: TickerMessage[],
    knownIds: Set<string>,
  ) => {
      const content = rawLine[rawLine.length - 1] === 0x0d
        ? rawLine.subarray(0, -1)
        : rawLine;
      const line = content.toString("utf-8");

      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);

        // Only extract assistant and user messages with text
        const role = msg.role;
        if (role !== "assistant" && role !== "user") return;

        const text = extractText(msg.content);
        if (!text || text.length < 5) return;

        // Skip heartbeat messages
        if (text.startsWith("HEARTBEAT_OK") || text.includes("HEARTBEAT.md")) return;

        const rawId = msg.__openclaw?.id;
        const id = typeof rawId === "string"
          && rawId.length > 0
          && rawId.length <= TICKER_MAX_ID_CHARS
          ? rawId
          : `${agentId}-${recordDigest.toString("hex").slice(0, 32)}`;
        const timestamp = msg.timestamp ?? msg.__openclaw?.ts ?? Date.now();
        if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return;

        // Age check
        if (Date.now() - timestamp > TICKER_MAX_AGE) return;

        if (knownIds.has(id)) return;
        knownIds.add(id);
        messages.push({ id, agentId, agentName, role, text, timestamp });
      } catch {
        // Skip malformed lines
      }
    };

  let committedOffset = offset;
  let baselineOffset = offset;
  let baselineModifiedMs = modifiedMs;

  try {
    // Drain to the descriptor's current EOF, then fstat and repeat if a writer
    // appended while the read was in flight. The path may already have been
    // rotated; the open descriptor still owns those final old-file records.
    for (let pass = 0; pass < 3; pass++) {
      const readStart = committedOffset;
      let physicalBytesRead = 0;
      let bytesCommitted = 0;
      let recordLength = 0;
      let recordHash = createHash("sha256");
      let pending = Buffer.alloc(0);
      let recordTooLarge = false;
      const passMessages: TickerMessage[] = [];
      const passSeenIds = new Set(seenIds);
      const stream = fileHandle.createReadStream({
        start: readStart,
        autoClose: false,
      });

      for await (const rawChunk of stream) {
        const chunk = rawChunk as Buffer;
        physicalBytesRead += chunk.length;
        let chunkOffset = 0;
        while (chunkOffset < chunk.length) {
          const newlineIndex = chunk.indexOf(0x0a, chunkOffset);
          const segmentEnd = newlineIndex === -1
            ? chunk.length
            : newlineIndex + 1;
          const segment = chunk.subarray(chunkOffset, segmentEnd);
          recordHash.update(segment);
          recordLength += segment.length;

          if (!recordTooLarge) {
            const contentSegment = newlineIndex === -1
              ? segment
              : segment.subarray(0, -1);
            if (pending.length + contentSegment.length <= TICKER_MAX_RECORD_BYTES) {
              pending = Buffer.concat([pending, contentSegment]);
            } else {
              pending = Buffer.alloc(0);
              recordTooLarge = true;
            }
          }

          if (newlineIndex === -1) break;
          bytesCommitted += recordLength;
          const recordDigest = recordHash.digest();
          if (!recordTooLarge) {
            processLine(pending, recordDigest, passMessages, passSeenIds);
          }
          digest = advanceTranscriptDigest(digest, recordDigest);
          recordLength = 0;
          recordHash = createHash("sha256");
          pending = Buffer.alloc(0);
          recordTooLarge = false;
          chunkOffset = segmentEnd;
        }
      }

      committedOffset = readStart + bytesCommitted;
      const finalStat = await fileHandle.stat();
      const needsVerification = committedOffset !== baselineOffset
        || finalStat.mtimeMs !== baselineModifiedMs;
      const verifiedDigest = needsVerification
        ? await readTranscriptDigest(fileHandle, committedOffset)
        : digest;
      if (finalStat.size < committedOffset || verifiedDigest !== digest) {
        // The inode was truncated or rewritten while it was being consumed.
        // Discard observations from the unstable generation and retry from 0.
        newMessages.length = 0;
        committedOffset = 0;
        baselineOffset = 0;
        digest = EMPTY_TRANSCRIPT_DIGEST;
        seenIds = new Set(baselineSeenIds);
        baselineModifiedMs = finalStat.mtimeMs;
        continue;
      }

      seenIds = passSeenIds;
      newMessages.push(...passMessages);
      modifiedMs = finalStat.mtimeMs;
      const physicalEnd = readStart + physicalBytesRead;
      if (finalStat.size <= physicalEnd) break;
    }

    // Avoid re-hashing a stable prefix on quiet polls. Any size or mtime
    // change triggers full-prefix verification on the next call.
    lastReadCursor.set(key, {
      offset: committedOffset,
      device,
      inode,
      modifiedMs,
      digest,
      seenIds: Array.from(seenIds).slice(-256),
    });
    return newMessages;
  } catch {
    // A failed stream must not advance the cursor or emit a partial batch.
    return [];
  } finally {
    await fileHandle.close().catch(() => {});
  }
}

/**
 * Prune read offsets for agents that are no longer active
 */
function pruneReadOffsets(activeAgentIds: Set<string>): void {
  for (const key of lastReadCursor.keys()) {
    const agentId = key.split(':')[0];
    if (!activeAgentIds.has(agentId)) {
      lastReadCursor.delete(key);
    }
  }
}

/**
 * Poll messages from all active agent transcripts.
 */
async function pollMessages(): Promise<void> {
  const promises: Promise<TickerMessage[]>[] = [];

  // Collect active agent IDs for pruning
  const activeAgentIds = new Set<string>();

  for (const [agentId, state] of agentStates) {
    if (!state.active) continue;
    activeAgentIds.add(agentId);

    const known = AGENT_REGISTRY.get(agentId);
    if (!known) continue;

    const transcriptPath = agentTranscriptPaths.get(agentId);
    if (transcriptPath) {
      promises.push(tailTranscript(agentId, known.name, transcriptPath));
    }
  }

  // Prune read offsets for inactive agents
  pruneReadOffsets(activeAgentIds);

  const results = await Promise.all(promises);
  const newMsgs = results.flat();

  // Prune messages older than TICKER_MAX_AGE from the rolling buffer
  const cutoff = Date.now() - TICKER_MAX_AGE;
  let i = 0;
  while (i < tickerMessages.length && tickerMessages[i].timestamp < cutoff) i++;
  const pruned = i > 0;
  if (pruned) tickerMessages.splice(0, i);

  if (newMsgs.length > 0) {
    // Insert each new message in sorted order (binary search)
    // Use <= so equal-timestamp messages insert after existing ones (stable order)
    for (const msg of newMsgs) {
      let lo = 0;
      let hi = tickerMessages.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (tickerMessages[mid].timestamp <= msg.timestamp) lo = mid + 1;
        else hi = mid;
      }
      tickerMessages.splice(lo, 0, msg);
    }

    // Trim to buffer size
    while (tickerMessages.length > TICKER_BUFFER_SIZE) {
      tickerMessages.shift();
    }
  }

  // Broadcast whenever the snapshot changed (new messages OR pruning)
  if (newMsgs.length > 0 || pruned) {
    io.emit("ticker:messages", tickerMessages);
  }
}

// ---- Polling loop ----

/**
 * Guard against overlapping poll cycles: if a previous invocation is still
 * awaiting the CLI or transcript reads, skip the next tick rather than
 * running concurrently and racing on shared state.
 */
let isPolling = false;

async function pollAndBroadcast(): Promise<void> {
  if (!isCliPollingActive(dataSourceState) || isPolling) return;
  isPolling = true;
  const cycleLog = logger.child({ cycleId: randomUUID(), subsystem: "poll" });
  try {
    const { sessions, sourceError, cliFailureKind } = await pollSessions();
    if (sourceError && cliFailureKind) {
      const nextState = applyCliFailure(dataSourceState, cliFailureKind);
      if (nextState !== dataSourceState) {
        dataSourceState = nextState;
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = undefined;
        }
        cycleLog.warn({
          configured: dataSourceState.configured,
          effective: dataSourceState.effective,
          failureKind: cliFailureKind,
        }, "CLI executable unavailable; transitioned permanently to ingest-only");
        return;
      }
    }
    const agentMap = sourceError ? undefined : mapToAgentStates(sessions);
    const { applied, snapshot } = applyAgentSnapshot(agentStates, agentMap, { sourceError });

    if (!applied) {
      cycleLog.warn("keeping previous agent snapshot after source error");
    } else {
      // Broadcast only when the visible agent snapshot actually changes.
      io.emit("agents:update", snapshot);
    }

    // Poll messages from transcripts
    await pollMessages();
  } catch (err) {
    cycleLog.error({ err }, "poll cycle failed");
  } finally {
    isPolling = false;
  }
}

// ---- Ingest API (receives data from OpenClaw host collector) ----

export type IngestTokenCrypto = Readonly<{
  digestToken: (token: string) => Buffer;
  compareDigests: (configured: Buffer, provided: Buffer) => boolean;
}>;

export const INGEST_TOKEN_DIGEST_CONTEXT =
  "openclaw-pixel-agents:ingest-token:v1";

export const defaultIngestTokenCrypto = Object.freeze<IngestTokenCrypto>({
  // HMAC treats each bearer token as cryptographic key material and produces
  // a fixed 32-byte value without misclassifying the token as a stored user
  // password. Node encodes both string token sources as UTF-8.
  digestToken: (token) =>
    createHmac("sha256", token)
      .update(INGEST_TOKEN_DIGEST_CONTEXT)
      .digest(),
  compareDigests: timingSafeEqual,
});

export function createIngestAuthenticator(
  ingestToken: string,
  crypto: IngestTokenCrypto = defaultIngestTokenCrypto,
): (req: express.Request, res: express.Response) => boolean {
  // Pre-compute a fixed-length HMAC-SHA-256 digest so the comparison never
  // leaks the configured token length via timing (CWE-208). Both sides are
  // always 32 bytes regardless of token length.
  const configuredDigest = ingestToken
    ? crypto.digestToken(ingestToken)
    : Buffer.alloc(32);

  return (req: express.Request, _res: express.Response): boolean => {
    if (!ingestToken) return false;
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) return false;
    const providedDigest = crypto.digestToken(auth.slice(7));
    return crypto.compareDigests(configuredDigest, providedDigest);
  };
}

export const authenticateIngest = createIngestAuthenticator(INGEST_TOKEN);

/**
 * Reset ingest rate-limit buckets. Exported for test isolation only —
 * production code should never call this.
 */
export function _resetRateLimitBuckets(): void {
  ingestRateBuckets.clear();
  ingestPreAuthBuckets.clear();
  publicGetRateBuckets.clear();
}

/** @deprecated Use _resetRateLimitBuckets — alias kept for import compatibility. */
export const _resetIngestRateBuckets = _resetRateLimitBuckets;

/**
 * POST /api/ingest/agents
 *
 * Accepts agent session data pushed from the OpenClaw host via the collector script.
 * Payload: { sessions: CliSession[], generatedAt: string }
 *
 * When valid ingest data arrives, it replaces the CLI-poll result and broadcasts.
 */

// In-process rate limiters:
// - PRE_AUTH: throttles unauthenticated/failed-token attempts per IP (CWE-770)
// - POST_AUTH: caps authenticated push frequency per token digest
// - PUBLIC_GET: app-wide throttle for unauthenticated GET traffic (SPA + static)
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;          // post-auth: 10 pushes/min per token
const PRE_AUTH_RATE_LIMIT_MAX = 5;   // pre-auth: 5 attempts/min per IP
const PUBLIC_GET_RATE_LIMIT_MAX = 120; // public GET: 120 req/min per IP (SPA + static)
const ingestRateBuckets = new Map<string, number[]>();
const ingestPreAuthBuckets = new Map<string, number[]>();
const publicGetRateBuckets = new Map<string, number[]>();

/**
 * Check whether an unauthenticated GET/HEAD request from this IP is within the
 * public rate limit. Keyed on req.ip. Returns true if allowed, false if
 * the caller should respond 429. Client-IP identity depends on the explicit
 * TRUST_PROXY contract configured at startup (see parseTrustProxy); with the
 * default no-trust setting req.ip is the direct peer.
 */
export function checkPublicGetRateLimit(req: express.Request): boolean {
  const ip = req.ip || "unknown";
  const key = `get:${ip}`;
  const now = Date.now();
  const bucket = publicGetRateBuckets.get(key) || [];
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recent = bucket.filter(t => t > windowStart);
  if (recent.length >= PUBLIC_GET_RATE_LIMIT_MAX) return false;
  recent.push(now);
  publicGetRateBuckets.set(key, recent);
  return true;
}

/**
 * Middleware: applies the public rate limit and returns 429 when exceeded.
 * Scope contract (issue #125, review): only GET and HEAD requests to
 * non-API paths are counted. HEAD is included because express.static and
 * the SPA sendFile fallback perform the same filesystem work for HEAD as
 * for GET — leaving it uncounted would let clients bypass the bound.
 * /api reads are exempt via an exact namespace boundary — "/api" itself and
 * "/api/*" only — so dashboard polling and other API traffic never consume
 * the static/SPA budget, while sibling public paths that merely share the
 * prefix ("/apiary", "/api-v2") stay rate-limited instead of leaking past
 * the limiter to the SPA filesystem path (review finding).
 */
function publicGetRateLimiter(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.method !== "GET" && req.method !== "HEAD") { next(); return; }
  if (req.path === "/api" || req.path.startsWith("/api/")) { next(); return; }
  if (!checkPublicGetRateLimit(req)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  next();
}

// Prune all three bucket maps on the same interval to prevent memory leaks
const ingestPruneTimer = setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, timestamps] of ingestRateBuckets) {
    const pruned = timestamps.filter(t => t > cutoff);
    if (pruned.length === 0) ingestRateBuckets.delete(key);
    else ingestRateBuckets.set(key, pruned);
  }
  for (const [key, timestamps] of ingestPreAuthBuckets) {
    const pruned = timestamps.filter(t => t > cutoff);
    if (pruned.length === 0) ingestPreAuthBuckets.delete(key);
    else ingestPreAuthBuckets.set(key, pruned);
  }
  for (const [key, timestamps] of publicGetRateBuckets) {
    const pruned = timestamps.filter(t => t > cutoff);
    if (pruned.length === 0) publicGetRateBuckets.delete(key);
    else publicGetRateBuckets.set(key, pruned);
  }
}, RATE_LIMIT_WINDOW_MS);
ingestPruneTimer.unref?.();

/**
 * Check pre-auth rate limit for a request. Returns true if the request should
 * be allowed through, false if it exceeded the threshold (caller sends 429).
 * Keyed on req.ip — trusts X-Forwarded-For only behind an explicit proxy.
 */
function checkPreAuthRateLimit(req: express.Request): boolean {
  const ip = req.ip || "unknown";
  const key = `preauth:${ip}`;
  const now = Date.now();
  const bucket = ingestPreAuthBuckets.get(key) || [];
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recent = bucket.filter(t => t > windowStart);
  if (recent.length >= PRE_AUTH_RATE_LIMIT_MAX) return false;
  recent.push(now);
  ingestPreAuthBuckets.set(key, recent);
  return true;
}

app.post("/api/ingest/agents", (req, res) => {
  if (!INGEST_TOKEN) {
    res.status(501).json({ error: "Ingest not configured (no INGEST_API_TOKEN)" });
    return;
  }

  // Pre-auth rate limit: throttle unauthenticated requests per IP before
  // the token check to prevent brute-force and resource-exhaustion attacks.
  if (!checkPreAuthRateLimit(req)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  if (!authenticateIngest(req, res)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Single-writer principle: authenticated pushes cannot race CLI snapshots.
  if (!isIngestWritesActive(dataSourceState)) {
    res.status(409).json({ error: "Ingest unavailable while CLI polling is active" });
    return;
  }

  // Rate limiting: track requests per derived key (avoid storing raw token)
  const rawKey = req.headers.authorization || req.ip || "unknown";
  // Simple hash to avoid keeping sensitive tokens in memory
  let hash = 0;
  for (let i = 0; i < rawKey.length; i++) {
    hash = ((hash << 5) - hash + rawKey.charCodeAt(i)) | 0;
  }
  const rateKey = `ingest:${hash}`;
  const now = Date.now();
  const bucket = ingestRateBuckets.get(rateKey) || [];
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recentRequests = bucket.filter(t => t > windowStart);
  if (recentRequests.length >= RATE_LIMIT_MAX) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  recentRequests.push(now);
  ingestRateBuckets.set(rateKey, recentRequests);

  const sessions = req.body?.sessions;
  if (!Array.isArray(sessions)) {
    res.status(400).json({ error: "Missing or invalid 'sessions' array" });
    return;
  }
  if (sessions.length > 50) {
    res.status(413).json({ error: "Payload too large: maximum 50 sessions allowed" });
    return;
  }

  const parsedSessionsResult = parseIngestSessions(
    sessions,
    new Set(AGENT_REGISTRY.keys()),
  );
  if (!parsedSessionsResult.ok) {
    logger.warn({
      subsystem: "ingest",
      validationCode: parsedSessionsResult.error.code,
      sessionIndex: parsedSessionsResult.error.sessionIndex,
      field: parsedSessionsResult.error.field,
    }, "ingest payload rejected");
    res.status(400).json({ error: "Invalid sessions payload" });
    return;
  }

  // Map and broadcast
  const agentMap = mapToAgentStates(parsedSessionsResult.sessions);
  const { snapshot } = applyAgentSnapshot(agentStates, agentMap);

  lastIngestAt = Date.now();
  logger.info({ sessionCount: sessions.length, agentCount: snapshot.length, subsystem: "ingest" }, "ingest applied");
  io.emit("agents:update", snapshot);
  res.json({ ok: true, agents: snapshot.length, received: sessions.length });
});

let lastIngestAt = 0;

// ---- REST API ----

const MUTATING_API_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

app.use("/api", (req, res, next) => {
  if (!MUTATING_API_METHODS.has(req.method)) return next();
  // Ingest runs above this middleware and ends the chain with a response, so
  // this exemption is defensive belt-and-suspenders for the future ordering.
  if (req.path === "/ingest/agents") return next();
  if (isOriginAllowed(req.headers.origin, corsConfig)) return next();

  res.status(403).json({ error: "Forbidden origin" });
});

app.get("/api/agents", (_req, res) => {
  res.json({ agents: Array.from(agentStates.values()) });
});

app.get("/api/status", (_req, res) => {
  const agents = Array.from(agentStates.values());
  const cliPolling = isCliPollingActive(dataSourceState);
  res.json({
    connected: true,
    agentCount: agents.length,
    activeCount: agents.filter((a) => a.active).length,
    uptime: process.uptime(),
    dataSource: cliPolling ? "cli-poll" : "ingest",
    dataSourceConfig: dataSourceState.configured,
    dataSourceEffective: dataSourceState.effective,
    dataSourceTransitioned: dataSourceState.transitioned,
    lastIngestAt: lastIngestAt || null,
    cliPolling,
  });
});

app.get("/api/messages", (_req, res) => {
  res.json({ messages: tickerMessages });
});

app.post("/api/agents/:id/toggle", (req, res) => {
  const { id } = req.params;
  const enabled = parseToggleBody(req.body);
  if (enabled === null) {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }

  const known = AGENT_REGISTRY.get(id);
  if (known) {
    known.pixelEnabled = enabled;
    const state = agentStates.get(id);
    if (state) state.pixelEnabled = enabled;
    savePersistedPrefs();
    // Broadcast the change
    io.emit("agents:update", Array.from(agentStates.values()));
    res.json({ success: true, enabled });
  } else {
    res.status(404).json({ error: "Agent not found" });
  }
});

app.post("/api/agents/:id/sprite", (req, res) => {
  const { id } = req.params;
  const spriteId = parseSpriteBody(req.body);
  if (spriteId === null) {
    return res.status(400).json({ error: "spriteId must be a safe string" });
  }

  const known = AGENT_REGISTRY.get(id);
  if (known) {
    known.characterSpriteId = spriteId;
    const state = agentStates.get(id);
    if (state) state.characterSpriteId = spriteId;
    savePersistedPrefs();
    // Broadcast sprite change so other connected clients see the new sprite
    io.emit("agents:update", Array.from(agentStates.values()));
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Agent not found" });
  }
});

// ---- Character recipe (paperdoll) ----

app.put("/api/agents/:id/recipe", (req, res) => {
  const { id } = req.params;
  const recipe = parseRecipe(req.body);
  if (!recipe) {
    return res.status(400).json({ error: "bodyIndex, hairIndex, outfitIndex must be valid recipe indices" });
  }

  const known = AGENT_REGISTRY.get(id);
  if (!known) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  known.recipe = recipe;
  const state = agentStates.get(id);
  if (state) state.recipe = known.recipe;
  savePersistedPrefs();

  // Broadcast recipe change to connected Socket.IO clients
  io.emit("recipe-update", { agentId: id, recipe: known.recipe });

  res.json({ success: true, recipe: known.recipe });
});

/** Get available recipe options (body/hair/outfit counts) */
app.get("/api/recipes/options", (_req, res) => {
  res.json({
    bodies: 6,   // 6 skin tone / body type rows
    hairs: 8,    // 8 hairstyle rows in Hairs.png
    outfits: 6,  // 6 outfit sheets
  });
});

// ---- Tag management ----

/** Get all available tags */
app.get("/api/tags", (_req, res) => {
  res.json({ tags: ALL_TAGS, colors: TAG_COLORS });
});

/** Update tags for an agent */
app.put("/api/agents/:id/tags", (req, res) => {
  const { id } = req.params;
  const tags = parseTagsBody(req.body);
  if (!tags) {
    return res.status(400).json({ error: `tags must be an array of up to 3 valid tags: ${ALL_TAGS.join(", ")}` });
  }

  const known = AGENT_REGISTRY.get(id);
  if (!known) {
    return res.status(404).json({ error: "Agent not found" });
  }

  known.tags = tags;
  const state = agentStates.get(id);
  if (state) {
    state.tags = tags;
    state.roomId = resolveRoom(tags);
  }
  savePersistedPrefs();

  // Broadcast updated agent states
  io.emit("agents:update", Array.from(agentStates.values()));
  res.json({ success: true, tags, roomId: resolveRoom(tags) });
});

// ---- Room management ----

/** Get all rooms */
app.get("/api/rooms", (_req, res) => {
  // Single-pass: build room stats from agentStates once
  const stats = new Map<string, { agentCount: number; activeCount: number }>();
  for (const a of agentStates.values()) {
    if (!a.pixelEnabled) continue;
    const rid = a.roomId ?? "office";
    const s = stats.get(rid) ?? { agentCount: 0, activeCount: 0 };
    s.agentCount++;
    if (a.active) s.activeCount++;
    stats.set(rid, s);
  }
  const roomsWithCounts = rooms.map(room => ({
    ...room,
    agentCount: stats.get(room.id)?.agentCount ?? 0,
    activeCount: stats.get(room.id)?.activeCount ?? 0,
  }));
  res.json({ rooms: roomsWithCounts });
});

// ---- Layout persistence ----

const LAYOUTS_DIR = join(DATA_DIR, "layouts");

function ensureLayoutsDir() {
  mkdirSync(LAYOUTS_DIR, { recursive: true });
}

function listLayouts(): OfficeLayoutDoc[] {
  ensureLayoutsDir();
  try {
    const files = readdirSync(LAYOUTS_DIR).filter(f => f.endsWith(".json"));
    const layouts: OfficeLayoutDoc[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(LAYOUTS_DIR, file), "utf-8");
        const layout = parseOfficeLayoutDoc(JSON.parse(raw));
        if (layout) layouts.push(layout);
        else logger.warn({ file, subsystem: "layout" }, "skipping invalid layout file");
      } catch (err) {
        logger.warn({ err, file, subsystem: "layout" }, "skipping unreadable layout file");
      }
    }
    return layouts.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}


function loadLayout(id: string): OfficeLayoutDoc | null {
  if (!isValidLayoutId(id)) return null;
  try {
    const raw = readFileSync(join(LAYOUTS_DIR, `${id}.json`), "utf-8");
    const layout = parseOfficeLayoutDoc(JSON.parse(raw));
    if (!layout) logger.warn({ layoutId: id, subsystem: "layout" }, "ignoring invalid layout file");
    return layout;
  } catch (err) {
    if (!(typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT")) {
      logger.warn({ err, layoutId: id, subsystem: "layout" }, "failed to load layout");
    }
    return null;
  }
}

function saveLayout(layout: OfficeLayoutDoc): void {
  if (!isValidLayoutId(layout.id)) throw new Error(`Invalid layout ID: ${layout.id}`);
  ensureLayoutsDir();
  layout.updatedAt = Date.now();
  const validated = parseOfficeLayoutDoc(layout);
  if (!validated) throw new Error(`Invalid layout document: ${layout.id}`);
  writeFileSync(join(LAYOUTS_DIR, `${validated.id}.json`), JSON.stringify(validated, null, 2));
}

function deleteLayout(id: string): boolean {
  if (!isValidLayoutId(id)) return false;
  try {
    unlinkSync(join(LAYOUTS_DIR, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

// Default layout matching the hardcoded office
function getDefaultLayout(): OfficeLayoutDoc {
  return {
    id: "default",
    name: "Default Office",
    width: 24,
    height: 16,
    furniture: [
      { id: "plant-1", type: "LARGE_PLANT", x: 1, y: 1, rotation: 0 },
      { id: "coffee-1", type: "COFFEE", x: 22, y: 1, rotation: 0 },
      { id: "whiteboard-1", type: "WHITEBOARD", x: 11, y: 0, rotation: 0 },
      { id: "bookshelf-1", type: "BOOKSHELF", x: 1, y: 8, rotation: 0 },
      { id: "painting-1", type: "LARGE_PAINTING", x: 22, y: 8, rotation: 0 },
      // Per-agent desks
      { id: "desk-cybera", type: "DESK", x: 3, y: 4, rotation: 0 },
      { id: "desk-shodan", type: "DESK", x: 9, y: 4, rotation: 0 },
      { id: "desk-cyberlogis", type: "DESK", x: 15, y: 4, rotation: 0 },
      { id: "desk-descartes", type: "DESK", x: 20, y: 4, rotation: 0 },
      { id: "desk-chi", type: "DESK", x: 3, y: 10, rotation: 0 },
      { id: "desk-cylena", type: "DESK", x: 9, y: 10, rotation: 0 },
      { id: "desk-sysauxilia", type: "DESK", x: 15, y: 10, rotation: 0 },
      { id: "desk-miku", type: "DESK", x: 20, y: 10, rotation: 0 },
    ],
    seats: {
      cybera: { x: 3, y: 4 },
      shodan: { x: 9, y: 4 },
      cyberlogis: { x: 15, y: 4 },
      descartes: { x: 20, y: 4 },
      chi: { x: 3, y: 10 },
      cylena: { x: 9, y: 10 },
      sysauxilia: { x: 15, y: 10 },
      miku: { x: 20, y: 10 },
    },
    updatedAt: Date.now(),
  };
}

// Layout REST API

app.get("/api/layouts", (_req, res) => {
  const layouts = listLayouts();
  // Always include default if empty
  if (layouts.length === 0) {
    const def = getDefaultLayout();
    saveLayout(def);
    layouts.push(def);
  }
  res.json({ layouts });
});

app.get("/api/layouts/:id", (req, res) => {
  const { id } = req.params;
  if (!isValidLayoutId(id)) return res.status(400).json({ error: "Invalid layout ID" });
  const layout = loadLayout(id);

  if (!layout) {
    // Auto-create default
    if (id === "default") {
      const def = getDefaultLayout();
      saveLayout(def);
      return res.json(def);
    }
    return res.status(404).json({ error: "Layout not found" });
  }
  res.json(layout);
});

app.put("/api/layouts/:id", (req, res) => {
  const { id } = req.params;
  if (!isValidLayoutId(id)) return res.status(400).json({ error: "Invalid layout ID" });
  const existing = loadLayout(id);
  const baseLayout: OfficeLayoutDoc = existing || { id, name: id, width: 24, height: 16, furniture: [], seats: {}, updatedAt: Date.now() };
  const parsed = parseLayoutMutationBody(req.body, { width: baseLayout.width, height: baseLayout.height });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  // Server-side conflict detection: reject stale writes using baseUpdatedAt
  if (existing && parsed.baseUpdatedAt != null && existing.updatedAt != null) {
    if (parsed.baseUpdatedAt < existing.updatedAt) {
      return res.status(409).json({
        error: "Conflict: your data is stale. Reload and try again.",
        serverUpdatedAt: existing.updatedAt,
      });
    }
  }

  const layout: OfficeLayoutDoc = {
    ...baseLayout,
    ...parsed.body,
    id, // prevent id overwrite
  };
  if (!parseOfficeLayoutDoc(layout)) return res.status(400).json({ error: "Invalid layout document" });
  saveLayout(layout);
  io.emit("layout:update", layout);
  res.json({ success: true, layout });
});

app.post("/api/layouts", (req, res) => {
  const id = `layout-${randomUUID()}`;
  const parsed = parseLayoutMutationBody(req.body, { width: 24, height: 16 });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const layout: OfficeLayoutDoc = {
    id,
    name: parsed.body.name || "Untitled Layout",
    width: parsed.body.width || 24,
    height: parsed.body.height || 16,
    furniture: parsed.body.furniture || [],
    seats: parsed.body.seats || {},
    updatedAt: Date.now(),
  };
  if (!parseOfficeLayoutDoc(layout)) return res.status(400).json({ error: "Invalid layout document" });
  saveLayout(layout);
  io.emit("layout:update", layout);
  res.json({ success: true, layout });
});

app.delete("/api/layouts/:id", (req, res) => {
  const { id } = req.params;
  if (!isValidLayoutId(id)) return res.status(400).json({ error: "Invalid layout ID" });
  if (id === "default") {
    return res.status(403).json({ error: "Cannot delete default layout" });
  }
  const ok = deleteLayout(id);
  if (!ok) {
    return res.status(404).json({ error: "Layout not found" });
  }
  // Broadcast layout removal so connected clients drop the layout
  io.emit("layout:update", { id, deleted: true });
  res.json({ success: true });
});

// Furniture catalog (what types are available)
app.get("/api/furniture-catalog", (_req, res) => {
  const types = [
    "BIN", "BOOKSHELF", "CACTUS", "CLOCK", "COFFEE", "COFFEE_TABLE",
    "CUSHIONED_BENCH", "CUSHIONED_CHAIR", "DESK", "DOUBLE_BOOKSHELF",
    "HANGING_PLANT", "LARGE_PAINTING", "LARGE_PLANT", "PC", "PLANT",
    "PLANT_2", "POT", "SMALL_PAINTING", "SMALL_PAINTING_2", "SMALL_TABLE",
    "SOFA", "TABLE_FRONT", "WHITEBOARD", "WOODEN_BENCH", "WOODEN_CHAIR",
  ];
  res.json({ types });
});

// ---- WebSocket ----

io.on("connection", (socket) => {
  logger.info({ socketId: socket.id, subsystem: "ws" }, "client connected");

  // Send current state on connect
  socket.emit("agents:update", Array.from(agentStates.values()));
  socket.emit("ticker:messages", tickerMessages);

  socket.on("disconnect", () => {
    logger.info({ socketId: socket.id, subsystem: "ws" }, "client disconnected");
  });
});

// Unmatched requests that reach the end of the API route chain keep the API
// representation/status contract. In particular, an unknown GET must not fall
// through to the SPA and look like a successful HTML navigation response.
// Register this boundary before the client-side fallback (issue #103).
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// SPA fallback: serve index.html for any non-API/non-asset route.
// Express 5 (path-to-regexp v8) rejects a bare "*" wildcard at registration
// time; the named "*splat" wildcard is the documented migration form and
// still matches every unmatched GET path, including "/".
//
// Requests reach here only after passing publicGetRateLimiter + static
// above, so filesystem access for index.html is already bounded (issue #125).
app.get("*splat", (_req, res) => {
  const indexPath = join(FRONTEND_DIR, "index.html");
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Not found");
  }
});

app.use(apiErrorHandler);

// ---- Start ----

const PORT = parseInt(process.env.PORT || "3001", 10);

// ---- Graceful Shutdown ----

let isShuttingDown = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;

const GRACEFUL_SHUTDOWN_MS = 5000;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal, subsystem: "server" }, "received shutdown signal");

  // Clear periodic timers to prevent new work during shutdown
  clearInterval(ingestPruneTimer);
  if (pollTimer) clearInterval(pollTimer);

  // Race: graceful close vs. hard timeout. Hoist the hard-timeout handle so we
  // can `clearTimeout` once the race resolves, preventing a delayed forced-shutdown
  // log from firing after a successful graceful exit.
  let hardTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const gracefulClose = (async (): Promise<false> => {
    // Close HTTP server (stops accepting new connections)
    await new Promise<void>((resolve) =>
      server.close(() => {
        logger.info({ subsystem: "server" }, "http server closed");
        resolve();
      }),
    );
    // Close Socket.IO connections (awaited so log lines land in order).
    await io.close();
    logger.info({ subsystem: "server" }, "socket.io connections closed");
    return false;
  })();

  const hardTimeout = new Promise<true>((resolve) => {
    hardTimeoutHandle = setTimeout(() => {
      logger.error({ subsystem: "server" }, "forced shutdown after timeout");
      resolve(true);
    }, GRACEFUL_SHUTDOWN_MS);
    // Don't keep the loop alive solely on the force-timeout.
    hardTimeoutHandle.unref?.();
  });

  const timedOut = await Promise.race([gracefulClose, hardTimeout]);
  if (hardTimeoutHandle) clearTimeout(hardTimeoutHandle);
  if (timedOut) {
    logger.error({ subsystem: "server" }, "shutdown complete (forced)");
    logger.flush?.();
    process.exit(1);
  }

  logger.info({ subsystem: "server" }, "shutdown complete");
  // Best-effort drain of buffered pino lines; flush is fire-and-forget here
  // because `process.exit` is synchronous and there is no awaiting wrapper.
  logger.flush?.();
  process.exit(0);
}

function startServer(): void {
  registerProcessErrorHandlers();
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  server.listen(PORT, () => {
    logger.info({
      port: PORT,
      dataSource: dataSourceState.configured,
      effective: dataSourceState.effective,
      subsystem: "server",
    }, "🖥️  OpenClaw Pixel Agents server running");

    if (isCliPollingActive(dataSourceState)) {
      logger.info({
        bin: OPENCLAW_BIN,
        activeThresholdMin: ACTIVE_THRESHOLD_MIN,
        pollIntervalMs: POLL_INTERVAL,
        subsystem: "server",
      }, "📡 Polling via CLI");
      pollTimer = setInterval(pollAndBroadcast, POLL_INTERVAL);
      void pollAndBroadcast();
    } else {
      logger.info({ subsystem: "server" }, "📡 Awaiting ingest data from collector (no local CLI polling)");
    }
  });
}

if (require.main === module) {
  startServer();
}

export { app, server, io, startServer };
