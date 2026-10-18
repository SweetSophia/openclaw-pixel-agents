import { useId, useRef, useState } from 'react';
import { getRoomName, resolveRoomByTags, type AgentState } from '../../shared/types';
import { useActivityFeed } from '../hooks/useActivityFeed';
import { activityGroup, activityGroups, activityLabel, ageLabel, type ActivityGroup } from '../util/activity';
import MessageTicker from './MessageTicker';
import './LiveActivity.css';

interface LiveActivityProps {
  agents: AgentState[];
  connected: boolean;
  snapshotReceivedAt: number | null;
  onSelectAgent: (id: string) => void;
}

export default function LiveActivity({ agents, connected, snapshotReceivedAt, onSelectAgent }: LiveActivityProps) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<ActivityGroup | 'All'>('All');
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const { changes, now, sourceNow, updatedAt, freshness, dataSource } = useActivityFeed(agents, snapshotReceivedAt);
  const counts = activityGroups.map(group => ({ group, count: agents.filter(agent => activityGroup(agent) === group).length }));
  const visibleAgents = agents.filter(agent => filter === 'All' || activityGroup(agent) === filter)
    .sort((a, b) => activityGroups.indexOf(activityGroup(a)) - activityGroups.indexOf(activityGroup(b)));
  const freshnessText = freshness === 'unavailable' ? 'Freshness unavailable'
    : freshness === 'waiting' ? 'Waiting for source data'
    : freshness === 'stale' ? `Data is stale · ${ageLabel(updatedAt!, now)}`
    : `${dataSource === 'cli-poll' ? 'Snapshot received' : 'Updated'} ${ageLabel(updatedAt!, now)}`;

  return (
    <section className={`activity-dock activity-dock--${freshness}`} aria-label="Live activity"
      onKeyDown={event => {
        if (event.key === 'Escape' && expanded) {
          setExpanded(false);
          toggle.current?.focus();
        }
      }}>
      <button className="activity-toggle" ref={toggle} aria-expanded={expanded} aria-controls={expanded ? panelId : undefined}
        onClick={() => setExpanded(value => !value)}>
        <span className="activity-title">Live activity <span aria-hidden="true">{expanded ? '▾' : '▴'}</span></span>
        <span className="activity-freshness">{freshnessText}</span>
        <span className="activity-counts">
          {counts.map(({ group, count }) => <span key={group}>{group} {count}</span>)}
        </span>
      </button>
      {expanded && <div className="activity-content" id={panelId}>
        <p className="activity-explanation">
          Activity is estimated from session recency and token counts; task and tool details are not supplied.
          {freshness !== 'current' && ' Showing last known activity.'}
        </p>
        <p className="activity-source">{dataSource === 'ingest' ? 'Collector' : dataSource === 'cli-poll' ? 'OpenClaw CLI' : 'Source pending'}
          {' · '}{connected ? 'Socket connected' : 'REST fallback'} · History since this page opened</p>
        <div className="activity-filters" role="group" aria-label="Filter agent activity">
          {(['All', ...activityGroups] as const).map(group => <button key={group}
            aria-pressed={filter === group} onClick={() => setFilter(group)}>{group}</button>)}
        </div>
        <div className="activity-columns">
          <div>
            <h2>Agents <span>{visibleAgents.length}</span></h2>
            {visibleAgents.length === 0 ? <p className="activity-empty">{agents.length ? 'No agents in this state.' : 'No agents received yet.'}</p>
              : <ul className="activity-roster" aria-label="Agent activity">
                {visibleAgents.map(agent => <li key={agent.id}>
                  <button onClick={() => onSelectAgent(agent.id)}>
                    <span className="activity-agent-heading"><strong>{agent.name}</strong>
                      <span className={`activity-state activity-state--${activityGroup(agent).toLowerCase().replace(/ /g, '-')}`}>{activityLabel(agent)}</span></span>
                    <span className="activity-agent-meta">{getRoomName(agent.roomId || resolveRoomByTags(agent.tags)) || 'Unknown room'} · {agent.model || 'No model'}</span>
                    <span className="activity-agent-age">{agent.lastActivity > 0 ? `Session activity ${ageLabel(agent.lastActivity, sourceNow)}` : 'No recent session'}</span>
                  </button>
                </li>)}
              </ul>}
          </div>
          <div>
            <h2>Observed changes</h2>
            {changes.length === 0 ? <p className="activity-empty">No changes observed yet. New status changes appear here.</p>
              : <ol className="activity-changes" aria-label="Observed changes">
                {changes.map(change => <li key={change.id}>
                  <button onClick={() => onSelectAgent(change.agentId)}><strong>{change.agentName}</strong>
                    <span>{change.from} → {change.to}</span>
                    <time dateTime={new Date(change.observedAt).toISOString()}>{ageLabel(change.observedAt, now)}</time>
                  </button>
                </li>)}
              </ol>}
          </div>
        </div>
        <MessageTicker />
      </div>}
    </section>
  );
}
