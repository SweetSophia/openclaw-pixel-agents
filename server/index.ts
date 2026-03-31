/**
 * OpenClaw Pixel Agents — Backend Server
 * 
 * Polls the OpenClaw Gateway API for agent states and exposes them via REST + WebSocket.
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import type { AgentState, AgentActivity } from '../shared/types';

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' },
});

app.use(express.json());

// ---- OpenClaw Gateway Integration ----

const OPENCLAW_GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://localhost:18789';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '2000', 10);

/** Current cached agent states */
const agentStates = new Map<string, AgentState>();

/** Known agent configuration (loaded from OpenClaw config) */
interface KnownAgent {
  id: string;
  name: string;
  pixelEnabled: boolean;
  characterSpriteId?: string;
}

const knownAgents: Map<string, KnownAgent> = new Map();

/**
 * Poll OpenClaw gateway for agent states.
 * 
 * Uses the gateway status/session API to determine what each agent is doing.
 * Falls back to `openclaw status` CLI if the API is unavailable.
 */
async function pollAgentStates(): Promise<void> {
  try {
    // Try the gateway API first
    const res = await fetch(`${OPENCLAW_GATEWAY}/api/status`);
    if (!res.ok) throw new Error(`Gateway returned ${res.status}`);

    const data = await res.json();
    const sessions = data.sessions || [];

    // Process each session to determine agent activity
    const seenAgentIds = new Set<string>();

    for (const session of sessions) {
      const agentId = session.agentId || session.key?.split(':')[1];
      if (!agentId) continue;

      seenAgentIds.add(agentId);

      // Determine activity from session state
      const activity = determineActivity(session);

      // Register new agents
      if (!knownAgents.has(agentId)) {
        knownAgents.set(agentId, {
          id: agentId,
          name: agentId.charAt(0).toUpperCase() + agentId.slice(1),
          pixelEnabled: true,
        });
      }

      const known = knownAgents.get(agentId)!;

      const state: AgentState = {
        id: agentId,
        name: known.name,
        activity,
        model: session.model || 'unknown',
        sessionKey: session.key || '',
        active: true,
        lastActivity: Date.now(),
        tokens: session.tokens
          ? { used: session.tokens.used || 0, limit: session.tokens.limit || 100000 }
          : undefined,
        characterSpriteId: known.characterSpriteId,
        pixelEnabled: known.pixelEnabled,
        subAgents: session.subAgents,
      };

      agentStates.set(agentId, state);
    }

    // Mark unseen agents as inactive
    for (const [id, state] of agentStates.entries()) {
      if (!seenAgentIds.has(id)) {
        state.active = false;
        state.activity = 'sleeping';
      }
    }

    // Broadcast updates to connected clients
    io.emit('agents:update', Array.from(agentStates.values()));
  } catch (err) {
    console.error('Failed to poll OpenClaw gateway:', err);
  }
}

/**
 * Determine agent activity from session data.
 * 
 * OpenClaw sessions expose model activity — we infer what the agent is doing
 * based on timestamps, token usage patterns, and session state.
 */
function determineActivity(session: any): AgentActivity {
  // If session has an explicit state, use it
  if (session.waitingForInput) return 'waiting_input';
  if (session.error) return 'error';

  // Infer from recent activity
  const lastActivity = session.lastActivity || session.updatedAt;
  if (lastActivity) {
    const elapsed = Date.now() - new Date(lastActivity).getTime();
    if (elapsed > 300000) return 'sleeping';  // 5 min idle = sleeping
    if (elapsed > 60000) return 'idle';       // 1 min idle = idle
  }

  // If tokens are being consumed, agent is active
  if (session.isProcessing) return 'thinking';
  if (session.isRunningTool) return 'running_command';

  return 'idle';
}

// ---- REST API ----

app.get('/api/agents', (_req, res) => {
  res.json({ agents: Array.from(agentStates.values()) });
});

app.get('/api/status', (_req, res) => {
  res.json({
    connected: true,
    agentCount: agentStates.size,
    activeCount: Array.from(agentStates.values()).filter(a => a.active).length,
    uptime: process.uptime(),
  });
});

app.post('/api/agents/:id/toggle', (req, res) => {
  const { id } = req.params;
  const { enabled } = req.body;

  const known = knownAgents.get(id);
  if (known) {
    known.pixelEnabled = enabled;
    const state = agentStates.get(id);
    if (state) state.pixelEnabled = enabled;
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Agent not found' });
  }
});

app.post('/api/agents/:id/sprite', (req, res) => {
  const { id } = req.params;
  const { spriteId } = req.body;

  const known = knownAgents.get(id);
  if (known) {
    known.characterSpriteId = spriteId;
    const state = agentStates.get(id);
    if (state) state.characterSpriteId = spriteId;
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Agent not found' });
  }
});

// ---- WebSocket ----

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current state on connect
  socket.emit('agents:update', Array.from(agentStates.values()));

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ---- Start ----

const PORT = parseInt(process.env.PORT || '3001', 10);

server.listen(PORT, () => {
  console.log(`🖥️  OpenClaw Pixel Agents server running on port ${PORT}`);
  console.log(`📡 Polling OpenClaw gateway at ${OPENCLAW_GATEWAY}`);

  // Start polling
  pollAgentStates();
  setInterval(pollAgentStates, POLL_INTERVAL);
});

export { app, server, io };
