import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { io as socketIO } from 'socket.io-client';
import type { AgentState, CharacterRecipe } from '../../shared/types';
import { ALL_TAGS, TAG_COLORS, resolveRoomByTags, type AgentTag } from '../../shared/types';

const API_BASE = '/api';

export { ALL_TAGS, TAG_COLORS };
export type { AgentTag };

async function requireOk(response: Response): Promise<void> {
  if (response.ok) return;

  const body = await response.json().catch(() => null);
  const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
    ? body.error
    : `HTTP ${response.status}`;
  throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Connection failed';
}

export function useAgentStore() {
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string>('office');
  const socketRevisionRef = useRef(0);
  const stateRevisionRef = useRef(0);
  const pendingMutationsRef = useRef(0);
  const pendingReconcileRef = useRef(false);
  const agentsRef = useRef<AgentState[]>([]);
  const mutationRevisionRef = useRef(new Map<string, number>());

  const updateAgents = useCallback((updater: (current: AgentState[]) => AgentState[]) => {
    const next = updater(agentsRef.current);
    agentsRef.current = next;
    stateRevisionRef.current += 1;
    setAgents(next);
  }, []);

  const fetchAgents = useCallback(async () => {
    // `connected` means a Socket.IO snapshot has arrived, not merely that the
    // transport opened. A successful REST response here must not stop the
    // fallback polling that remains active until that first snapshot.
    const socketRevisionAtRequest = socketRevisionRef.current;
    const stateRevisionAtRequest = stateRevisionRef.current;
    try {
      const res = await fetch(`${API_BASE}/agents`);
      await requireOk(res);
      const data = await res.json();
      if (
        socketRevisionRef.current !== socketRevisionAtRequest
        || stateRevisionRef.current !== stateRevisionAtRequest
        || pendingMutationsRef.current > 0
      ) return;
      updateAgents(() => data.agents || []);
      setError(null);
    } catch (err) {
      if (
        socketRevisionRef.current !== socketRevisionAtRequest
        || stateRevisionRef.current !== stateRevisionAtRequest
        || pendingMutationsRef.current > 0
      ) return;
      setError(errorMessage(err));
    }
  }, [updateAgents]);

  const beginMutation = useCallback((key: string) => {
    const revision = (mutationRevisionRef.current.get(key) ?? 0) + 1;
    mutationRevisionRef.current.set(key, revision);
    return revision;
  }, []);

  const startMutation = useCallback(() => {
    pendingMutationsRef.current += 1;
  }, []);

  const isCurrentMutation = useCallback((key: string, revision: number) => (
    mutationRevisionRef.current.get(key) === revision
  ), []);

  const finishMutation = useCallback((needsReconcile = false) => {
    if (needsReconcile) pendingReconcileRef.current = true;
    pendingMutationsRef.current = Math.max(0, pendingMutationsRef.current - 1);
    // Invalidate any REST snapshot that began while this mutation was active,
    // including successful mutations that required no further local update.
    stateRevisionRef.current += 1;
    if (pendingMutationsRef.current === 0 && pendingReconcileRef.current) {
      pendingReconcileRef.current = false;
      void fetchAgents();
    }
  }, [fetchAgents]);

  const toggleAgent = useCallback(async (agentId: string, enabled: boolean) => {
    const mutationKey = `toggle:${agentId}`;
    const mutationRevision = beginMutation(mutationKey);
    startMutation();
    let previousEnabled: boolean | undefined;
    const socketRevisionAtMutation = socketRevisionRef.current;
    let needsReconcile = false;
    setError(null);
    updateAgents(current => current.map(agent => {
      if (agent.id !== agentId) return agent;
      previousEnabled = agent.pixelEnabled;
      return { ...agent, pixelEnabled: enabled };
    }));

    try {
      const res = await fetch(`${API_BASE}/agents/${agentId}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      await requireOk(res);
    } catch (err) {
      console.error('Failed to toggle agent:', err);
      if (socketRevisionRef.current === socketRevisionAtMutation) {
        const isCurrent = isCurrentMutation(mutationKey, mutationRevision);
        needsReconcile = !isCurrent;
        if (previousEnabled !== undefined && isCurrent) {
          const rollbackEnabled = previousEnabled;
          updateAgents(current => current.map(agent =>
            agent.id === agentId ? { ...agent, pixelEnabled: rollbackEnabled } : agent
          ));
        }
      }
      setError(errorMessage(err));
    } finally {
      finishMutation(needsReconcile);
    }
  }, [beginMutation, finishMutation, isCurrentMutation, startMutation, updateAgents]);

  const toggleAll = useCallback(async (enabled: boolean) => {
    const changedAgents = agentsRef.current.filter(agent => agent.pixelEnabled !== enabled);
    if (changedAgents.length === 0) {
      return;
    }

    startMutation();
    const previousEnabled = new Map(changedAgents.map(agent => [agent.id, agent.pixelEnabled]));
    const mutationRevisions = new Map(changedAgents.map(agent => {
      const key = `toggle:${agent.id}`;
      return [agent.id, beginMutation(key)] as const;
    }));
    const socketRevisionAtMutation = socketRevisionRef.current;
    setError(null);
    updateAgents(current => current.map(agent => (
      previousEnabled.has(agent.id) ? { ...agent, pixelEnabled: enabled } : agent
    )));

    let needsReconcile = false;
    try {
      const results = await Promise.all(changedAgents.map(async agent => {
        try {
          const res = await fetch(`${API_BASE}/agents/${agent.id}/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
          });
          await requireOk(res);
          return null;
        } catch (error) {
          return { agentId: agent.id, error };
        }
      }));

      const failures = results.filter((result): result is { agentId: string; error: unknown } => result !== null);
      if (failures.length > 0) {
        const details = failures.map(({ agentId, error }) => `${agentId} (${errorMessage(error)})`).join(', ');
        const message = `Failed to toggle ${failures.length} agent${failures.length === 1 ? '' : 's'}: ${details}`;
        console.error(message);
        if (socketRevisionRef.current === socketRevisionAtMutation) {
          const currentFailures = failures.filter(({ agentId }) => (
            isCurrentMutation(`toggle:${agentId}`, mutationRevisions.get(agentId) ?? 0)
          ));
          needsReconcile = currentFailures.length !== failures.length;
          const failedIds = new Set(currentFailures.map(failure => failure.agentId));
          updateAgents(current => current.map(agent =>
            failedIds.has(agent.id)
              ? { ...agent, pixelEnabled: previousEnabled.get(agent.id) ?? agent.pixelEnabled }
              : agent
          ));
        }
        setError(message);
      }
    } finally {
      finishMutation(needsReconcile);
    }
  }, [beginMutation, finishMutation, isCurrentMutation, startMutation, updateAgents]);

  const setCharacterSprite = useCallback(async (agentId: string, spriteId: string) => {
    const mutationKey = `sprite:${agentId}`;
    const mutationRevision = beginMutation(mutationKey);
    startMutation();
    let previousSpriteId: string | undefined;
    let foundAgent = false;
    const socketRevisionAtMutation = socketRevisionRef.current;
    let needsReconcile = false;
    setError(null);
    updateAgents(current => current.map(agent => {
      if (agent.id !== agentId) return agent;
      foundAgent = true;
      previousSpriteId = agent.characterSpriteId;
      return { ...agent, characterSpriteId: spriteId };
    }));

    try {
      const res = await fetch(`${API_BASE}/agents/${agentId}/sprite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spriteId }),
      });
      await requireOk(res);
    } catch (err) {
      console.error('Failed to set sprite:', err);
      if (socketRevisionRef.current === socketRevisionAtMutation) {
        const isCurrent = isCurrentMutation(mutationKey, mutationRevision);
        needsReconcile = !isCurrent;
        if (foundAgent && isCurrent) {
          updateAgents(current => current.map(agent => {
            if (agent.id !== agentId) return agent;
            const nextAgent = { ...agent };
            if (previousSpriteId === undefined) {
              delete nextAgent.characterSpriteId;
            } else {
              nextAgent.characterSpriteId = previousSpriteId;
            }
            return nextAgent;
          }));
        }
      }
      setError(errorMessage(err));
    } finally {
      finishMutation(needsReconcile);
    }
  }, [beginMutation, finishMutation, isCurrentMutation, startMutation, updateAgents]);

  /** Update tags for an agent — only mutates local state on server success */
  const updateTags = useCallback(async (agentId: string, tags: AgentTag[]) => {
    try {
      const res = await fetch(`${API_BASE}/agents/${agentId}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
      });
      await requireOk(res);
      // Only mutate local state after server confirms success
      const body = await res.json();
      updateAgents(current => current.map(a =>
        a.id === agentId ? { ...a, tags, roomId: body.roomId } : a
      ));
    } catch (err) {
      console.error('Failed to update tags:', err);
      throw err; // re-throw so caller (TagEditor) can display the error
    }
  }, [updateAgents]);

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
      await requireOk(res);
      // Optimistic update
      updateAgents(current => current.map(a =>
        a.id === agentId ? { ...a, recipe } : a
      ));
    } catch (err) {
      console.error('Failed to update recipe:', err);
      throw err;
    }
  }, [updateAgents]);

  useEffect(() => {
    const socket = socketIO({ transports: ['websocket', 'polling'] });

    // Transport connectivity alone does not mean client state is fresh. Keep
    // the REST fallback active until this connection delivers its first snapshot.
    const handleConnect = () => setConnected(false);
    const handleDisconnect = () => setConnected(false);
    const handleUpdate = (updatedAgents: AgentState[]) => {
      socketRevisionRef.current += 1;
      updateAgents(() => updatedAgents);
      setError(null);
      setConnected(true);
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
  }, [updateAgents]);

  // REST polling fallback — keep it active while Socket.IO is down or while a
  // newly opened connection has not delivered its first authoritative snapshot.
  useEffect(() => {
    if (connected) return;
    fetchAgents(); // immediate first fetch — don't wait the full interval on entry
    const pollTimer = setInterval(fetchAgents, 2000);
    return () => clearInterval(pollTimer);
  }, [connected, fetchAgents]);

  return { agents, connected, error, toggleAgent, toggleAll, setCharacterSprite, updateTags, updateRecipe, activeRoomId, setActiveRoomId, roomAgents, refresh: fetchAgents };
}
