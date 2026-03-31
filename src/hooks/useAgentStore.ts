import { useState, useEffect, useCallback } from 'react';
import type { AgentState } from '../../shared/types';

const API_BASE = '/api';

export function useAgentStore() {
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/agents`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAgents(data.agents || []);
      setConnected(true);
      setError(null);
    } catch (err) {
      setConnected(false);
      setError(err instanceof Error ? err.message : 'Connection failed');
    }
  }, []);

  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, 2000);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  const toggleAgent = useCallback(async (agentId: string, enabled: boolean) => {
    try {
      await fetch(`${API_BASE}/agents/${agentId}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      fetchAgents();
    } catch (err) {
      console.error('Failed to toggle agent:', err);
    }
  }, [fetchAgents]);

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

  return { agents, connected, error, toggleAgent, setCharacterSprite, refresh: fetchAgents };
}
