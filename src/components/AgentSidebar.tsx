import React, { useState } from 'react';
import type { AgentState, AgentActivity, AgentTag } from '../../shared/types';
import { TAG_COLORS } from '../hooks/useAgentStore';
import { TagEditor } from './TagEditor';
import './AgentSidebar.css';

interface Props {
  agents: AgentState[];
  onToggle: (agentId: string, enabled: boolean) => void;
  onToggleAll: (enabled: boolean) => void;
  onSelectAgent?: (agentId: string) => void;
  onUpdateTags?: (agentId: string, tags: string[]) => Promise<void>;
}

const activityIcons: Record<AgentActivity, string> = {
  idle: '💤',
  thinking: '🤔',
  typing: '⌨️',
  reading: '📖',
  running_command: '⚡',
  waiting_input: '💬',
  sleeping: '😴',
  error: '❌',
};

const activityColors: Record<AgentActivity, string> = {
  idle: '#6c757d',
  thinking: '#ffc107',
  typing: '#4ecca3',
  reading: '#17a2b8',
  running_command: '#e94560',
  waiting_input: '#ff6b6b',
  sleeping: '#6c757d',
  error: '#dc3545',
};

export const AgentSidebar: React.FC<Props> = ({ agents, onToggle, onToggleAll, onSelectAgent, onUpdateTags }) => {
  const enabledCount = agents.filter(a => a.pixelEnabled).length;
  const activeCount = agents.filter(a => a.active).length;
  const [tagEditorAgent, setTagEditorAgent] = useState<AgentState | null>(null);

  return (
    <aside className="agent-sidebar">
      <h2>Agents ({enabledCount}/{agents.length})</h2>
      <div className="agent-list">
        {agents.map(agent => {
          const cardClass = !agent.pixelEnabled
            ? 'agent-card disabled'
            : agent.active
              ? 'agent-card active'
              : 'agent-card inactive';

          return (
            <div key={agent.id} className={cardClass} onClick={() => onSelectAgent?.(agent.id)} style={{ cursor: onSelectAgent ? 'pointer' : 'default' }}>
              <div className="agent-header">
                <span className="agent-icon">
                  {agent.pixelEnabled ? activityIcons[agent.activity] : '🚫'}
                </span>
                <span className="agent-name">{agent.name}</span>
                <button
                  className={`toggle-btn ${agent.pixelEnabled ? 'on' : 'off'}`}
                  onClick={(e) => { e.stopPropagation(); onToggle(agent.id, !agent.pixelEnabled); }}
                  title={agent.pixelEnabled ? 'Hide from office' : 'Show in office'}
                >
                  {agent.pixelEnabled ? '👁️' : '👁️‍🗨️'}
                </button>
              </div>
              <div className="agent-details">
                <span
                  className="activity-badge"
                  style={{ backgroundColor: activityColors[agent.activity] }}
                >
                  {agent.activity}
                </span>
                <span className="agent-model">
                  {agent.model !== 'unknown' ? agent.model.split('/').pop() : '—'}
                </span>
              </div>
              {agent.tokens && (
                <div className="agent-tokens">
                  <div className="token-bar">
                    <div
                      className="token-fill"
                      style={{
                        width: `${(agent.tokens.used / agent.tokens.limit) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="token-text">
                    {((agent.tokens.used / agent.tokens.limit) * 100).toFixed(0)}%
                  </span>
                </div>
              )}
              {agent.tags && agent.tags.length > 0 && (
                <div className="agent-tags">
                  {agent.tags.map(tag => (
                    <span
                      key={tag}
                      className="tag-badge"
                      style={{ backgroundColor: (TAG_COLORS[tag as AgentTag] || '#666') + '30', color: TAG_COLORS[tag as AgentTag] || '#999' }}
                    >
                      {tag}
                    </span>
                  ))}
                  <button
                    className="tag-edit-btn"
                    onClick={(e) => { e.stopPropagation(); setTagEditorAgent(agent); }}
                    title="Edit tags"
                  >
                    ✏️
                  </button>
                </div>
              )}
              {(!agent.tags || agent.tags.length === 0) && (
                <button
                  className="tag-add-btn"
                  onClick={(e) => { e.stopPropagation(); setTagEditorAgent(agent); }}
                  title="Add tags"
                >
                  + tags
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="sidebar-footer">
        <button onClick={() => onToggleAll(true)}>
          👁 Show All
        </button>
        <button className="danger" onClick={() => onToggleAll(false)}>
          🚫 Hide All
        </button>
      </div>
      {tagEditorAgent && onUpdateTags && (
        <TagEditor
          agentId={tagEditorAgent.id}
          agentName={tagEditorAgent.name}
          currentTags={tagEditorAgent.tags || []}
          onUpdateTags={onUpdateTags}
          onClose={() => setTagEditorAgent(null)}
        />
      )}
    </aside>
  );
};
