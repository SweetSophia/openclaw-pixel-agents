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
import { join, dirname } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { AgentState, AgentActivity, SubAgentInfo, TickerMessage } from "../shared/types";

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" },
});

app.use(express.json());

// ---- Configuration ----

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "3000", 10);
const ACTIVE_THRESHOLD_MIN = parseInt(process.env.ACTIVE_MINUTES || "30", 10);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const DATA_DIR = process.env.DATA_DIR || join(dirname(import.meta.dirname || __dirname), "data");
const PERSIST_PATH = join(DATA_DIR, "agent-prefs.json");
/** Base directory for OpenClaw agent session transcripts */
const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || join(process.env.HOME || "/root", ".openclaw", "agents");

// ---- Known agents from config ----

interface KnownAgent {
  id: string;
  name: string;
  pixelEnabled: boolean;
  characterSpriteId?: string;
}

/** Default agent definitions */
function defaultRegistry(): Map<string, KnownAgent> {
  return new Map([
    ["main", { id: "main", name: "Shodan", pixelEnabled: true }],
    ["miku", { id: "miku", name: "Miku", pixelEnabled: true }],
    ["chi", { id: "chi", name: "Chi", pixelEnabled: true }],
    ["sysauxilia", { id: "sysauxilia", name: "Sysauxilia", pixelEnabled: true }],
    ["descartes", { id: "descartes", name: "Descartes", pixelEnabled: true }],
    ["cyberlogis", { id: "cyberlogis", name: "Cyberlogis", pixelEnabled: true }],
    ["cylena", { id: "cylena", name: "Cylena", pixelEnabled: true }],
    ["cybera", { id: "cybera", name: "Cybera", pixelEnabled: true }],
  ]);
}

/** Load persisted agent preferences (pixelEnabled, spriteId) from disk */
function loadPersistedPrefs(): Map<string, { pixelEnabled?: boolean; characterSpriteId?: string }> {
  try {
    if (!existsSync(PERSIST_PATH)) return new Map();
    const raw = readFileSync(PERSIST_PATH, "utf-8");
    const data = JSON.parse(raw);
    const map = new Map<string, { pixelEnabled?: boolean; characterSpriteId?: string }>();
    for (const [k, v] of Object.entries(data)) {
      map.set(k, v as { pixelEnabled?: boolean; characterSpriteId?: string });
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Save agent preferences to disk */
function savePersistedPrefs() {
  try {
    const prefs: Record<string, { pixelEnabled: boolean; characterSpriteId?: string }> = {};
    for (const [id, agent] of AGENT_REGISTRY) {
      prefs[id] = { pixelEnabled: agent.pixelEnabled, characterSpriteId: agent.characterSpriteId };
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
  }
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
function mapToAgentStates(cliSessions: CliSession[]): AgentState[] {
  // Group sessions by agentId
  const byAgent = new Map<string, CliSession[]>();
  for (const s of cliSessions) {
    const agentId = s.agentId;
    if (!agentId) continue;
    const list = byAgent.get(agentId) || [];
    list.push(s);
    byAgent.set(agentId, list);
  }

  const results: AgentState[] = [];

  // Process all registered agents (including those without active sessions)
  for (const [agentId, known] of AGENT_REGISTRY) {
    const sessions = byAgent.get(agentId);
    const latestSession = sessions?.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];

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

      const state: AgentState = {
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
      };
      agentStates.set(agentId, state);
      results.push(state);
    } else {
      // No active session — agent is sleeping
      const state: AgentState = {
        id: agentId,
        name: known.name,
        activity: "sleeping",
        model: "unknown",
        sessionKey: "",
        active: false,
        lastActivity: 0,
        characterSpriteId: known.characterSpriteId,
        pixelEnabled: known.pixelEnabled,
      };
      agentStates.set(agentId, state);
      results.push(state);
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
  if (typeof content === 'string') {
    return content.slice(0, TICKER_MAX_CHARS);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      // Skip non-text content blocks (thinking, tool calls, tool results)
      if (b.type === 'thinking' || b.type === 'tool_use' || b.type === 'tool_result') continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        return b.text.slice(0, TICKER_MAX_CHARS);
      }
    }
  }
  return '';
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
  if (!transcriptPath || !existsSync(transcriptPath)) return [];

  const key = `${agentId}:${transcriptPath}`;
  const offset = lastReadOffset.get(key) ?? 0;

  // Snapshot the file size before reading so we have a stable upper bound even
  // if the file is still being written to during the read.
  let fileSize: number;
  try {
    fileSize = (await statAsync(transcriptPath)).size;
  } catch {
    return [];
  }

  // Nothing new since we last read (also ensures fileSize > offset, so
  // end = fileSize - 1 is always a valid range below)
  if (fileSize <= offset) return [];

  const newMessages: TickerMessage[] = [];

  return new Promise((resolve) => {
    const stream = createReadStream(transcriptPath, {
      encoding: 'utf-8',
      start: offset,
      end: fileSize - 1,
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);

        // Only extract assistant and user messages with text
        const role = msg.role;
        if (role !== 'assistant' && role !== 'user') return;

        const text = extractText(msg.content);
        if (!text || text.length < 5) return;

        // Skip heartbeat messages
        if (text.startsWith('HEARTBEAT_OK') || text.includes('HEARTBEAT.md')) return;

        const id = msg.__openclaw?.id || `${agentId}-${msg.__openclaw?.seq ?? Date.now()}`;
        const timestamp = msg.timestamp || msg.__openclaw?.ts || Date.now();

        // Age check
        if (Date.now() - timestamp > TICKER_MAX_AGE) return;

        newMessages.push({ id, agentId, agentName, role, text, timestamp });
      } catch {
        // Skip malformed lines
      }
    });

    rl.on('close', () => {
      lastReadOffset.set(key, fileSize);
      resolve(newMessages);
    });

    rl.on('error', () => resolve([]));
  });
}

/**
 * Poll messages from all active agent transcripts.
 */
async function pollMessages(): Promise<void> {
  const promises: Promise<TickerMessage[]>[] = [];

  for (const [agentId, state] of agentStates) {
    if (!state.active) continue;

    const known = AGENT_REGISTRY.get(agentId);
    if (!known) continue;

    const transcriptPath = agentTranscriptPaths.get(agentId);
    if (transcriptPath) {
      promises.push(tailTranscript(agentId, known.name, transcriptPath));
    }
  }

  const results = await Promise.all(promises);
  const newMsgs = results.flat();

  // Prune messages older than TICKER_MAX_AGE from the rolling buffer
  const cutoff = Date.now() - TICKER_MAX_AGE;
  let i = 0;
  while (i < tickerMessages.length && tickerMessages[i].timestamp < cutoff) i++;
  const pruned = i > 0;
  if (pruned) tickerMessages.splice(0, i);

  if (newMsgs.length > 0) {
    // Add new messages and sort by timestamp
    tickerMessages.push(...newMsgs);
    tickerMessages.sort((a, b) => a.timestamp - b.timestamp);

    // Trim to buffer size
    while (tickerMessages.length > TICKER_BUFFER_SIZE) {
      tickerMessages.shift();
    }
  }

  // Broadcast whenever the snapshot changed (new messages OR pruning)
  if (newMsgs.length > 0 || pruned) {
    // Broadcast
    io.emit('ticker:messages', tickerMessages);
  }
}

// ---- Polling loop ----

async function pollAndBroadcast(): Promise<void> {
  const { sessions } = await pollSessions();
  const agentList = mapToAgentStates(sessions);

  // Broadcast to all connected WebSocket clients
  io.emit("agents:update", agentList);

  // Poll messages from transcripts
  await pollMessages();
}

// ---- REST API ----

app.get("/api/agents", (_req, res) => {
  res.json({ agents: Array.from(agentStates.values()) });
});

app.get("/api/status", (_req, res) => {
  const agents = Array.from(agentStates.values());
  res.json({
    connected: true,
    agentCount: agents.length,
    activeCount: agents.filter((a) => a.active).length,
    uptime: process.uptime(),
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
    return files.map(f => {
      const raw = readFileSync(join(LAYOUTS_DIR, f), "utf-8");
      return JSON.parse(raw) as OfficeLayoutDoc;
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function loadLayout(id: string): OfficeLayoutDoc | null {
  try {
    const raw = readFileSync(join(LAYOUTS_DIR, `${id}.json`), "utf-8");
    return JSON.parse(raw) as OfficeLayoutDoc;
  } catch {
    return null;
  }
}

function saveLayout(layout: OfficeLayoutDoc): void {
  ensureLayoutsDir();
  layout.updatedAt = Date.now();
  writeFileSync(join(LAYOUTS_DIR, `${layout.id}.json`), JSON.stringify(layout, null, 2));
}

function deleteLayout(id: string): boolean {
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
  const layout = loadLayout(req.params.id);
  if (!layout) {
    // Auto-create default
    if (req.params.id === "default") {
      const def = getDefaultLayout();
      saveLayout(def);
      return res.json(def);
    }
    return res.status(404).json({ error: "Layout not found" });
  }
  res.json(layout);
});

app.put("/api/layouts/:id", (req, res) => {
  const existing = loadLayout(req.params.id);
  const layout: OfficeLayoutDoc = {
    ...(existing || { id: req.params.id, name: req.params.id, width: 24, height: 16 }),
    ...req.body,
    id: req.params.id, // prevent id overwrite
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
  if (req.params.id === "default") {
    return res.status(403).json({ error: "Cannot delete default layout" });
  }
  const ok = deleteLayout(req.params.id);
  res.json({ success: ok });
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

// ---- Start ----

const PORT = parseInt(process.env.PORT || "3001", 10);

server.listen(PORT, () => {
  console.log(`🖥️  OpenClaw Pixel Agents server running on port ${PORT}`);
  console.log(`📡 Polling via: ${OPENCLAW_BIN} sessions --all-agents --json --active ${ACTIVE_THRESHOLD_MIN}`);

  // Initial poll + interval
  pollAndBroadcast();
  setInterval(pollAndBroadcast, POLL_INTERVAL);
});

export { app, server, io };
