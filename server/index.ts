/**
 * OpenClaw Pixel Agents — Backend Server
 *
 * Polls the OpenClaw Gateway for agent states via the CLI and exposes them via REST + WebSocket.
 * Uses `openclaw sessions --all-agents --json` as the data source — simpler and more stable
 * than implementing the full Gateway WebSocket protocol.
 */

import { execFile } from "node:child_process";
import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { ALL_TAGS, TAG_COLORS, DEFAULT_ROOMS, type AgentState, type AgentActivity, type SubAgentInfo, type TickerMessage, type Room, type AgentTag } from "../shared/types";

const app = express();
const server = createServer(app);
// Pre-compute allowed origins once (not per-request)
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim())
  : [];
const allowAllOrigins = !process.env.CORS_ORIGIN && process.env.NODE_ENV !== "production";

const io = new SocketIOServer(server, {
  cors: {
    origin: allowedOrigins.length > 0
      ? allowedOrigins
      : process.env.NODE_ENV === "production" ? false : "*",
  },
});

// WebSocket origin validation
io.engine.on("initial_headers", (_headers, req) => {
  if (allowAllOrigins) return; // Dev mode: allow all
  if (allowedOrigins.length === 0) {
    // Production with no CORS_ORIGIN configured: reject all WebSocket upgrades
    req.destroy();
    return;
  }
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) {
    req.destroy();
  }
});

// Basic security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:");
  next();
});

app.use(express.json({ limit: "100kb" }));

// Serve built frontend in production (Vite output is in dist/client, server is compiled to dist/server/index.js)
const FRONTEND_DIR = resolve(__dirname, "..", "..", "client");
if (existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
}

// ---- Configuration ----

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "3000", 10);
const ACTIVE_THRESHOLD_MIN = parseInt(process.env.ACTIVE_MINUTES || "30", 10);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const PERSIST_PATH = join(DATA_DIR, "agent-prefs.json");
/** Base directory for OpenClaw agent session transcripts */
const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || join(process.env.HOME || "/root", ".openclaw", "agents");

/**
 * Data source mode:
 *   "auto"    — try CLI polling; if openclaw not found and ingest token is set, use ingest-only
 *   "cli"     — always poll via local openclaw CLI (original behavior)
 *   "ingest"  — only accept pushed data via the ingest API (no local CLI needed)
 */
const DATA_SOURCE = (process.env.DATA_SOURCE || "auto").toLowerCase() as "auto" | "cli" | "ingest";

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

interface PersistedPrefs {
  pixelEnabled?: boolean;
  characterSpriteId?: string;
  tags?: AgentTag[];
  recipe?: { bodyIndex: number; hairIndex: number; outfitIndex: number };
}

/** Load persisted agent preferences (pixelEnabled, spriteId, tags, recipe) from disk */
function loadPersistedPrefs(): Map<string, PersistedPrefs> {
  try {
    if (!existsSync(PERSIST_PATH)) return new Map();
    const raw = readFileSync(PERSIST_PATH, "utf-8");
    const data = JSON.parse(raw);
    const map = new Map<string, PersistedPrefs>();

    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        map.set(k, v as PersistedPrefs);
      }
    }
    return map;
  } catch {
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
    console.error("[persist] Failed to save prefs:", err);
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

/** Determine which room an agent should be in based on their first tag */
function resolveRoom(agentTags: AgentTag[]): string {
  if (agentTags.length === 0) return "office"; // default

  const firstTag = agentTags[0];
  // Check primary tag match
  const primaryMatch = rooms.find(r => r.primaryTag === firstTag);
  if (primaryMatch) return primaryMatch.id;

  // Check secondary tag match
  const secondaryMatch = rooms.find(r => r.secondaryTags?.includes(firstTag));
  if (secondaryMatch) return secondaryMatch.id;

  return "office"; // fallback
}

// ---- State ----

const agentStates = new Map<string, AgentState>();
/** Transcript paths discovered from CLI session data, keyed by agentId */
const agentTranscriptPaths = new Map<string, string>();

// ---- CLI data source ----

interface CliSession {
  key: string;
  agentId: string;
  model?: string;
  modelProvider?: string;
  totalTokens?: number | null;
  contextTokens?: number | null;
  updatedAt?: number;
  kind?: string;
  status?: string;
  abortedLastRun?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  sessionId?: string;
  thinkingLevel?: string;
}

interface CliSessionsResult {
  sessions: CliSession[];
  count: number;
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
        console.error("[poll] CLI error:", err.message);
        resolve({ sessions: [], count: 0 });
        return;
      }

      try {
        const data = JSON.parse(stdout);
        resolve({
          sessions: data.sessions || [],
          count: data.count || 0,
        });
      } catch (parseErr) {
        console.error("[poll] JSON parse error:", parseErr);
        resolve({ sessions: [], count: 0 });
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

    if (latestSession) {
      const activity = inferActivity(latestSession);
      const model = latestSession.model
        ? `${latestSession.modelProvider}/${latestSession.model}`
        : "unknown";

      // Capture transcript path for message ticker polling
      if (latestSession.sessionId) {
        const transcriptPath = join(AGENTS_DIR, agentId, "sessions", `${latestSession.sessionId}.jsonl`);
        agentTranscriptPaths.set(agentId, transcriptPath);
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
/** How far back to look for messages (ms) */
const TICKER_MAX_AGE = 5 * 60 * 1000; // 5 minutes

const tickerMessages: TickerMessage[] = [];
/**
 * Track the byte offset of the last read position per transcript so we only
 * read newly-appended lines on each poll cycle instead of the whole file.
 */
const lastReadOffset = new Map<string, number>();

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
async function tailTranscript(
  agentId: string,
  agentName: string,
  transcriptPath: string | undefined,
): Promise<TickerMessage[]> {
  if (!transcriptPath) return [];

  const key = `${agentId}:${transcriptPath}`;
  const offset = lastReadOffset.get(key) ?? 0;

  // Snapshot the file size before reading so we have a stable upper bound even
  // if the file is still being written to during the read.
  let fileSize: number;
  try {
    fileSize = (await statAsync(transcriptPath)).size;
  } catch {
    // File doesn't exist or is unreadable — skip silently
    return [];
  }

  // Nothing new since we last read (also ensures fileSize > offset, so
  // end = fileSize - 1 is always a valid range below)
  if (fileSize <= offset) return [];

  const newMessages: TickerMessage[] = [];

  return new Promise((resolve) => {
    const stream = createReadStream(transcriptPath, {
      encoding: "utf-8",
      start: offset,
      end: fileSize - 1,
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    // Track how many bytes we've consumed through complete newlines.
    // `readline` only emits a "line" event after encountering a newline
    // delimiter, so bytesConsumed always ends at a clean boundary — any
    // trailing partial line (no terminating newline) is NOT counted and
    // will be re-read on the next poll cycle.
    let bytesConsumed = 0;
    let errored = false;

    rl.on("line", (line) => {
      // +1 for the newline character that readline strips
      bytesConsumed += Buffer.byteLength(line, "utf-8") + 1;

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

        const id = msg.__openclaw?.id || `${agentId}-${msg.__openclaw?.seq ?? Date.now()}`;
        const timestamp = msg.timestamp || msg.__openclaw?.ts || Date.now();

        // Age check
        if (Date.now() - timestamp > TICKER_MAX_AGE) return;

        newMessages.push({ id, agentId, agentName, role, text, timestamp });
      } catch {
        // Skip malformed lines
      }
    });

    rl.on("close", () => {
      // On stream error, rl.close() is called which fires this handler.
      // Guard against advancing the cursor or resolving with partial data
      // when the read was interrupted by an I/O error.
      if (errored) return;

      // Only advance the cursor by bytes we know ended at a newline.
      // If the file was appended mid-line during our read, the partial
      // fragment (fileSize - bytesConsumed) will be re-read next cycle.
      if (bytesConsumed > 0) {
        lastReadOffset.set(key, offset + bytesConsumed);
      }
      resolve(newMessages);
    });

    // readline.Interface does not emit "error"; handle errors on the underlying stream.
    stream.on("error", () => {
      errored = true;
      rl.close();
      stream.destroy();
      resolve([]);
    });
  });
}

/**
 * Prune read offsets for agents that are no longer active
 */
function pruneReadOffsets(activeAgentIds: Set<string>): void {
  for (const key of lastReadOffset.keys()) {
    const agentId = key.split(':')[0];
    if (!activeAgentIds.has(agentId)) {
      lastReadOffset.delete(key);
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
  if (isPolling) return;
  isPolling = true;
  try {
    const { sessions } = await pollSessions();
    const agentMap = mapToAgentStates(sessions);
    const agentList = Array.from(agentMap.values());

    // Create immutable snapshot before any async operations
    const snapshot = agentList.map(a => ({ ...a }));

    // Update global state atomically
    agentStates.clear();
    for (const agent of agentMap.values()) {
      agentStates.set(agent.id, agent);
    }

    // Broadcast the snapshot (not the mutable global state)
    io.emit("agents:update", snapshot);

    // Poll messages from transcripts
    await pollMessages();
  } finally {
    isPolling = false;
  }
}

// ---- Ingest API (receives data from OpenClaw host collector) ----

const INGEST_TOKEN = process.env.INGEST_API_TOKEN || "";
const INGEST_TOKEN_BUF = INGEST_TOKEN ? Buffer.from(INGEST_TOKEN, "utf-8") : Buffer.alloc(0);

function authenticateIngest(req: express.Request, _res: express.Response): boolean {
  if (!INGEST_TOKEN_BUF.length) return false;
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  const provided = Buffer.from(token, "utf-8");
  if (INGEST_TOKEN_BUF.length !== provided.length) {
    timingSafeEqual(INGEST_TOKEN_BUF, Buffer.alloc(INGEST_TOKEN_BUF.length));
    return false;
  }
  return timingSafeEqual(INGEST_TOKEN_BUF, provided);
}

/**
 * POST /api/ingest/agents
 *
 * Accepts agent session data pushed from the OpenClaw host via the collector script.
 * Payload: { sessions: CliSession[], generatedAt: string }
 *
 * When valid ingest data arrives, it replaces the CLI-poll result and broadcasts.
 */

// In-process rate limiter: max RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_MS per token
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const ingestRateBuckets = new Map<string, number[]>();

// Periodically prune expired rate-limit entries to prevent memory leak
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, timestamps] of ingestRateBuckets) {
    const pruned = timestamps.filter(t => t > cutoff);
    if (pruned.length === 0) ingestRateBuckets.delete(key);
    else ingestRateBuckets.set(key, pruned);
  }
}, RATE_LIMIT_WINDOW_MS);

app.post("/api/ingest/agents", (req, res) => {
  if (!INGEST_TOKEN) {
    res.status(501).json({ error: "Ingest not configured (no INGEST_API_TOKEN)" });
    return;
  }
  if (!authenticateIngest(req, res)) {
    res.status(401).json({ error: "Unauthorized" });
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

  const { sessions } = req.body;
  if (!Array.isArray(sessions)) {
    res.status(400).json({ error: "Missing or invalid 'sessions' array" });
    return;
  }
  if (sessions.length > 50) {
    res.status(413).json({ error: "Payload too large: maximum 50 sessions allowed" });
    return;
  }

  // Map and broadcast
  const agentMap = mapToAgentStates(sessions as CliSession[]);
  const agentList = Array.from(agentMap.values());

  // Update global state
  agentStates.clear();
  for (const agent of agentMap.values()) {
    agentStates.set(agent.id, agent);
  }

  lastIngestAt = Date.now();
  console.log(`[ingest] ${agentList.length} agents updated (${sessions.length} sessions)`);
  io.emit("agents:update", agentList);
  res.json({ ok: true, agents: agentList.length, received: sessions.length });
});

let lastIngestAt = 0;

// ---- REST API ----

// General authorization middleware for state-modifying REST endpoints
// Scoped to /api to avoid blocking Socket.IO polling transport POSTs
app.use("/api", (req, res, next) => {
  if (req.method === "GET") return next();
  if (req.path === "/ingest/agents") return next(); // Handles its own auth

  if (authenticateIngest(req, res)) return next();

  res.status(401).json({ error: "Authentication required: provide 'Authorization: Bearer <INGEST_API_TOKEN>' header" });
});

app.get("/api/agents", (_req, res) => {
  res.json({ agents: Array.from(agentStates.values()) });
});

app.get("/api/status", (_req, res) => {
  const agents = Array.from(agentStates.values());
  const effectiveSource = useCli && !ingestExplicit ? "cli-poll" : "ingest";
  res.json({
    connected: true,
    agentCount: agents.length,
    activeCount: agents.filter((a) => a.active).length,
    uptime: process.uptime(),
    dataSource: lastIngestAt > 0 ? "ingest" : effectiveSource,
    dataSourceConfig: DATA_SOURCE,
    lastIngestAt: lastIngestAt || null,
    cliPolling: useCli && !ingestExplicit,
  });
});

app.get("/api/messages", (_req, res) => {
  res.json({ messages: tickerMessages });
});

app.post("/api/agents/:id/toggle", (req, res) => {
  const { id } = req.params;
  const { enabled } = req.body;

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
  const { spriteId } = req.body;

  const known = AGENT_REGISTRY.get(id);
  if (known) {
    known.characterSpriteId = spriteId;
    const state = agentStates.get(id);
    if (state) state.characterSpriteId = spriteId;
    savePersistedPrefs();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Agent not found" });
  }
});

// ---- Character recipe (paperdoll) ----

app.put("/api/agents/:id/recipe", (req, res) => {
  const { id } = req.params;
  const { bodyIndex, hairIndex, outfitIndex } = req.body;

  if (typeof bodyIndex !== 'number' || typeof hairIndex !== 'number' || typeof outfitIndex !== 'number') {
    res.status(400).json({ error: "bodyIndex, hairIndex, outfitIndex required (numbers)" });
    return;
  }

  const known = AGENT_REGISTRY.get(id);
  if (!known) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  // Validate ranges
  if (bodyIndex < 0 || bodyIndex > 5 || hairIndex < 0 || hairIndex > 8 || outfitIndex < 0 || outfitIndex > 5) {
    res.status(400).json({ error: "Indices out of range (body: 0-5, hair: 0-8, outfit: 0-5)" });
    return;
  }

  known.recipe = { bodyIndex, hairIndex, outfitIndex };
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
  const { tags } = req.body as { tags: AgentTag[] };

  if (!Array.isArray(tags)) {
    return res.status(400).json({ error: "tags must be an array of strings" });
  }

  // Validate each tag against the known AgentTag set
  const validTags = new Set<string>(ALL_TAGS);
  for (const tag of tags) {
    if (typeof tag !== "string" || !validTags.has(tag)) {
      return res.status(400).json({ error: `Invalid tag: "${tag}". Valid tags: ${ALL_TAGS.join(", ")}` });
    }
  }

  if (tags.length > 3) {
    return res.status(400).json({ error: "Maximum 3 tags allowed per agent" });
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

import type { PlacedFurniture } from "../shared/types";

interface OfficeLayoutDoc {
  id: string;
  name: string;
  width: number;
  height: number;
  furniture: PlacedFurniture[];
  seats: Record<string, { x: number; y: number }>;
  updatedAt: number;
}

const LAYOUTS_DIR = join(DATA_DIR, "layouts");

function ensureLayoutsDir() {
  mkdirSync(LAYOUTS_DIR, { recursive: true });
}

function listLayouts(): OfficeLayoutDoc[] {
  ensureLayoutsDir();
  try {
    const files = readdirSync(LAYOUTS_DIR).filter(f => f.endsWith(".json"));
    return files
      .map(f => {
        const raw = readFileSync(join(LAYOUTS_DIR, f), "utf-8");
        return JSON.parse(raw) as OfficeLayoutDoc;
      })
      .filter(layout => isValidLayoutId(layout.id)) // Only return layouts with valid IDs
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** Validate layout ID to prevent path traversal attacks */
function isValidLayoutId(id: unknown): boolean {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) && id.length <= 64;
}

function loadLayout(id: string): OfficeLayoutDoc | null {
  if (!isValidLayoutId(id)) return null;
  try {
    const raw = readFileSync(join(LAYOUTS_DIR, `${id}.json`), "utf-8");
    return JSON.parse(raw) as OfficeLayoutDoc;
  } catch {
    return null;
  }
}

function saveLayout(layout: OfficeLayoutDoc): void {
  if (!isValidLayoutId(layout.id)) throw new Error(`Invalid layout ID: ${layout.id}`);
  ensureLayoutsDir();
  layout.updatedAt = Date.now();
  writeFileSync(join(LAYOUTS_DIR, `${layout.id}.json`), JSON.stringify(layout, null, 2));
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

  // Server-side conflict detection: reject stale writes using baseUpdatedAt
  const { baseUpdatedAt, ...body } = req.body;
  if (existing && baseUpdatedAt != null && existing.updatedAt != null) {
    if (baseUpdatedAt < existing.updatedAt) {
      return res.status(409).json({
        error: "Conflict: your data is stale. Reload and try again.",
        serverUpdatedAt: existing.updatedAt,
      });
    }
  }

  const layout: OfficeLayoutDoc = {
    ...(existing || { id, name: id, width: 24, height: 16 }),
    ...body,
    id, // prevent id overwrite
  };
  saveLayout(layout);
  io.emit("layout:update", layout);
  res.json({ success: true, layout });
});

app.post("/api/layouts", (req, res) => {
  const { name, width, height, furniture, seats } = req.body;
  const id = `layout-${Date.now()}`;
  const layout: OfficeLayoutDoc = {
    id,
    name: name || "Untitled Layout",
    width: width || 24,
    height: height || 16,
    furniture: furniture || [],
    seats: seats || {},
    updatedAt: Date.now(),
  };
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
  console.log("[ws] Client connected:", socket.id);

  // Send current state on connect
  socket.emit("agents:update", Array.from(agentStates.values()));
  socket.emit("ticker:messages", tickerMessages);

  socket.on("disconnect", () => {
    console.log("[ws] Client disconnected:", socket.id);
  });
});

// SPA fallback: serve index.html for any non-API/non-asset route
app.get("*", (_req, res) => {
  const indexPath = join(FRONTEND_DIR, "index.html");
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Not found");
  }
});

// ---- Start ----

const PORT = parseInt(process.env.PORT || "3001", 10);

// Determine effective data source
const hasIngestToken = !!INGEST_TOKEN;
const cliExplicit = DATA_SOURCE === "cli";
const ingestExplicit = DATA_SOURCE === "ingest";
const useCli = cliExplicit || (DATA_SOURCE === "auto" && !ingestExplicit);

// ---- Graceful Shutdown ----

let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[server] Received ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    console.log("[server] HTTP server closed");
  });

  // Close Socket.IO connections
  io.close(() => {
    console.log("[server] Socket.IO connections closed");
  });

  // Give existing connections time to close
  setTimeout(() => {
    console.log("[server] Shutdown complete");
    process.exit(0);
  }, 2000);

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    console.error("[server] Forced shutdown after timeout");
    process.exit(1);
  }, 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, () => {
  console.log(`🖥️  OpenClaw Pixel Agents server running on port ${PORT}`);
  console.log(`📊 Data source: ${DATA_SOURCE} (effective: ${useCli && !ingestExplicit ? "cli-poll" : "ingest-only"})`);

  if (useCli && !ingestExplicit) {
    console.log(`📡 Polling via: ${OPENCLAW_BIN} sessions --all-agents --json --active ${ACTIVE_THRESHOLD_MIN}`);
    pollAndBroadcast();
    setInterval(pollAndBroadcast, POLL_INTERVAL);
  } else {
    console.log("📡 Awaiting ingest data from collector (no local CLI polling)");
  }
});

export { app, server, io };
