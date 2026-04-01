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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { AgentState, AgentActivity } from "../shared/types";

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
            }
          : undefined,
        characterSpriteId: known.characterSpriteId,
        pixelEnabled: known.pixelEnabled,
        subAgents: sessions
          ?.filter((s) => s.kind === "subagent")
          .map((s) => s.key),
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

// ---- Polling loop ----

async function pollAndBroadcast(): Promise<void> {
  const { sessions } = await pollSessions();
  const agentList = mapToAgentStates(sessions);

  // Broadcast to all connected WebSocket clients
  io.emit("agents:update", agentList);
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

// ---- WebSocket ----

io.on("connection", (socket) => {
  console.log("[ws] Client connected:", socket.id);

  // Send current state on connect
  socket.emit("agents:update", Array.from(agentStates.values()));

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
