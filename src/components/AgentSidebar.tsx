import React from 'react';
import type { AgentState, AgentActivity } from '../../shared/types';
import './AgentSidebar.css';

interface Props {
  agents: AgentState[];
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

export const AgentSidebar: React.FC<Props> = ({ agents }) => {
  return (
    <aside className="agent-sidebar">
      <h2>Agents</h2>
      <div className="agent-list">
        {agents.map(agent => (
          <div
            key={agent.id}
            className={`agent-card ${agent.active ? 'active' : 'inactive'}`}
          >
            <div className="agent-header">
              <span className="agent-icon">
                {activityIcons[agent.activity]}
              </span>
              <span className="agent-name">{agent.name}</span>
              <button
                className={`toggle-btn ${agent.pixelEnabled ? 'on' : 'off'}`}
                onClick={() => {
                  // Dispatch a custom event that useAgentStore can handle
                  window.dispatchEvent(
                    new CustomEvent('agent:toggle', { detail: { agentId: agent.id, enabled: !agent.pixelEnabled } })
                  );
                }}
                title={agent.pixelEnabled ? 'Hide in office' : 'Show in office'}
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
              <span className="agent-model">{agent.model.split('/').pop()}</span>
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
          </div>
        ))}
      </div>
    </aside>
  );
};
