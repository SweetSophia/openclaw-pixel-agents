import { useState, useEffect, useCallback, useMemo } from 'react';
import { io as socketIO } from 'socket.io-client';
import type { AgentState, CharacterRecipe } from '../../shared/types';
import { ALL_TAGS, TAG_COLORS, DEFAULT_ROOMS, resolveRoomByTags, type AgentTag } from '../../shared/types';

const API_BASE = '/api';

export { ALL_TAGS, TAG_COLORS };
export type { AgentTag };

export function useAgentStore() {
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string>('office');

  const fetchAgents = useCallback(async () => {
    // `connected` is a WebSocket-liveness signal and is driven only by the
    // Socket.IO event handlers below. A successful REST response here is NOT
    // evidence that the WS is up — flipping `connected` from this function
    // would create a feedback loop with the REST polling fallback that gates
    // on `connected` (see useEffect for the fallback).
    try {
      const res = await fetch(`${API_BASE}/agents`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAgents(data.agents || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    }
  }, []);

  const toggleAgent = useCallback(async (agentId: string, enabled: boolean) => {
    try {
      await fetch(`${API_BASE}/agents/${agentId}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      // Optimistic update — don't wait for next poll
      setAgents(prev => prev.map(a =>
        a.id === agentId ? { ...a, pixelEnabled: enabled } : a
      ));
    } catch (err) {
      console.error('Failed to toggle agent:', err);
      // Revert on error by re-fetching
      fetchAgents();
    }
  }, [fetchAgents]);

  const toggleAll = useCallback(async (enabled: boolean) => {
    try {
      // Fire all toggles in parallel
      const promises = agents.map(agent => {
        if (agent.pixelEnabled !== enabled) {
          return fetch(`${API_BASE}/agents/${agent.id}/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
          });
        }
        return Promise.resolve();
      });
      await Promise.all(promises);
      // Optimistic update
      setAgents(prev => prev.map(a => ({ ...a, pixelEnabled: enabled })));
    } catch (err) {
      console.error('Failed to toggle all agents:', err);
      fetchAgents();
    }
  }, [agents, fetchAgents]);

  const setCharacterSprite = useCallback(async (agentId: string, spriteId: string) => {
    try {
      await fetch(`${API_BASE}/agents/${agentId}/sprite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spriteId }),
      });
      fetchAgents();
    } catch (err) {
      console.error('Failed to set sprite:', err);
    }
  }, [fetchAgents]);

  /** Update tags for an agent — only mutates local state on server success */
  const updateTags = useCallback(async (agentId: string, tags: AgentTag[]) => {
    try {
      const res = await fetch(`${API_BASE}/agents/${agentId}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      // Only mutate local state after server confirms success
      const body = await res.json();
      setAgents(prev => prev.map(a =>
        a.id === agentId ? { ...a, tags, roomId: body.roomId } : a
      ));
    } catch (err) {
      console.error('Failed to update tags:', err);
      throw err; // re-throw so caller (TagEditor) can display the error
    }
  }, []);

  /**
   * Resolve which room an agent belongs to.
   * If the server has set `roomId`, use it directly. Otherwise derive the
   * room from the agent's tags via the shared `resolveRoomByTags` helper,
   * which mirrors the server's logic. This prevents agents from disappearing
   * when a Socket.IO update arrives with a missing `roomId` during a room
   * switch.
   */
  const resolveAgentRoom = useCallback((agent: AgentState): string => {
    if (agent.roomId) return agent.roomId;
    return resolveRoomByTags(agent.tags || []);
  }, []);

  /** Filter agents visible in the current room */
  const roomAgents = useMemo(() => agents.filter(a =>
    resolveAgentRoom(a) === activeRoomId
  ), [agents, activeRoomId, resolveAgentRoom]);

  /** Update character recipe (paperdoll body/hair/outfit) for an agent */
  const updateRecipe = useCallback(async (agentId: string, recipe: CharacterRecipe) => {
    try {
      const res = await fetch(`${API_BASE}/agents/${agentId}/recipe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recipe),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      // Optimistic update
      setAgents(prev => prev.map(a =>
        a.id === agentId ? { ...a, recipe } : a
      ));
    } catch (err) {
      console.error('Failed to update recipe:', err);
      throw err;
    }
  }, []);

  useEffect(() => {
    fetchAgents(); // Initial fetch
    
    const socket = socketIO({ transports: ['websocket', 'polling'] });

    const handleConnect = () => setConnected(true);
    const handleDisconnect = () => setConnected(false);
    const handleUpdate = (updatedAgents: AgentState[]) => {
      setAgents(updatedAgents);
      setError(null);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('agents:update', handleUpdate);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('agents:update', handleUpdate);
      socket.disconnect();
    };
  }, [fetchAgents]);

  // REST polling fallback — primary update channel is Socket.IO; this degraded-mode
  // poll kicks in only when the WS connection is down so the UI does not freeze on
  // stale state. Matches the contract documented in AGENTS.md ("Data Flow").
  useEffect(() => {
    if (connected) return;
    fetchAgents(); // immediate first fetch — don't wait the full interval on entry
    const pollTimer = setInterval(fetchAgents, 2000);
    return () => clearInterval(pollTimer);
  }, [connected, fetchAgents]);

  return { agents, connected, error, toggleAgent, toggleAll, setCharacterSprite, updateTags, updateRecipe, activeRoomId, setActiveRoomId, roomAgents, refresh: fetchAgents };
}
