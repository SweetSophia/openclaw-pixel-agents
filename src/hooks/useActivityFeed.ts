import { useEffect, useRef, useState } from 'react';
import type { AgentState } from '../../shared/types';
import { activityLabel } from '../util/activity';

interface ObservedChange {
  id: number;
  agentId: string;
  agentName: string;
  from: string;
  to: string;
  observedAt: number;
}

type SourceStatus = { dataSource: 'cli' | 'ingest'; lastIngestAt: number | null };

export function useActivityFeed(agents: AgentState[], snapshotReceivedAt: number | null) {
  const [changes, setChanges] = useState<ObservedChange[]>([]);
  const previous = useRef(new Map<string, string>());
  const sequence = useRef(0);
  const [now, setNow] = useState(Date.now());
  const [source, setSource] = useState<SourceStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const next = new Map(agents.map(agent => [agent.id, activityLabel(agent)]));
    const observedAt = Date.now();
    const additions = agents.flatMap(agent => {
      const from = previous.current.get(agent.id);
      const to = next.get(agent.id)!;
      return from && from !== to ? [{
        id: ++sequence.current, agentId: agent.id, agentName: agent.name,
        from, to, observedAt,
      }] : [];
    });
    previous.current = next;
    // Session/token refreshes and preference edits are not activity changes.
    if (additions.length) setChanges(current => [...additions, ...current].slice(0, 50));
  }, [agents]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let nextPoll: ReturnType<typeof setTimeout>;
    let request: AbortController;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      request = new AbortController();
      timeout = setTimeout(() => request.abort(), 10_000);
      try {
        const response = await fetch('/api/status', { signal: request.signal });
        if (!response.ok) throw new Error('Status unavailable');
        const status = await response.json();
        if ((status.dataSource !== 'ingest' && status.dataSource !== 'cli')
          || (status.dataSource === 'ingest' && status.lastIngestAt !== null
            && !(Number.isFinite(status.lastIngestAt) && status.lastIngestAt > 0))) {
          throw new Error('Invalid source status');
        }
        if (!cancelled) {
          setSource({ dataSource: status.dataSource, lastIngestAt: status.lastIngestAt ?? null });
          setUnavailable(false);
          setNow(Date.now());
        }
      } catch {
        if (!cancelled) setUnavailable(true);
      } finally {
        clearTimeout(timeout);
        if (!cancelled) nextPoll = setTimeout(poll, 15_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      request?.abort();
      clearTimeout(timeout);
      clearTimeout(nextPoll);
    };
  }, []);

  // Receiving a cached server snapshot does not prove the collector is alive.
  const updatedAt = source?.dataSource === 'ingest' ? source.lastIngestAt : snapshotReceivedAt;
  const freshness = unavailable ? 'unavailable'
    : !source || !updatedAt ? 'waiting'
    : now - updatedAt >= 90_000 ? 'stale' : 'current';

  return { changes, now, updatedAt, freshness, dataSource: source?.dataSource };
}
