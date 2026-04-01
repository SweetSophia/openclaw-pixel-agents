import React from 'react';
import type { AgentState, AgentActivity, SubAgentInfo } from '../../shared/types';
import './AgentDetailPanel.css';

interface Props {
  agent: AgentState | null;
  onClose: () => void;
}

const activityLabels: Record<AgentActivity, string> = {
  idle: '💤 Idle',
  thinking: '🤔 Thinking',
  typing: '⌨️ Typing',
  reading: '📖 Reading',
  running_command: '⚡ Running Command',
  waiting_input: '💬 Waiting for Input',
  sleeping: '😴 Sleeping',
  error: '❌ Error',
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

export const AgentDetailPanel: React.FC<Props> = ({ agent, onClose }) => {
  if (!agent) return null;

  const lastActivityDate = agent.lastActivity
    ? new Date(agent.lastActivity).toLocaleTimeString()
    : 'Never';

  const tokenPercent = agent.tokens
    ? Math.round((agent.tokens.used / agent.tokens.limit) * 100)
    : null;

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={e => e.stopPropagation()}>
        <button className="detail-close" onClick={onClose}>✕</button>

        {/* Header */}
        <div className="detail-header">
          <div
            className="detail-avatar"
            style={{ backgroundColor: activityColors[agent.activity] }}
          >
            {agent.name.charAt(0)}
          </div>
          <div className="detail-title">
            <h2>{agent.name}</h2>
            <span className="detail-id">{agent.id}</span>
          </div>
        </div>

        {/* Activity */}
        <div className="detail-section">
          <div className="detail-label">Activity</div>
          <div
            className="detail-activity"
            style={{ backgroundColor: activityColors[agent.activity] }}
          >
            {activityLabels[agent.activity]}
          </div>
        </div>

        {/* Model */}
        <div className="detail-section">
          <div className="detail-label">Model</div>
          <div className="detail-value">{agent.model !== 'unknown' ? agent.model : '—'}</div>
        </div>

        {/* Token usage */}
        {agent.tokens && tokenPercent !== null && (
          <div className="detail-section">
            <div className="detail-label">Token Usage</div>
            <div className="detail-token-bar">
              <div className="detail-token-fill" style={{ width: `${Math.min(tokenPercent, 100)}%` }} />
            </div>
            <div className="detail-token-text">
              {agent.tokens.used.toLocaleString()} / {agent.tokens.limit.toLocaleString()} ({tokenPercent}%)
            </div>
            {(agent.tokens.inputTokens || agent.tokens.outputTokens) && (
              <div className="detail-token-breakdown">
                {agent.tokens.inputTokens != null && (
                  <span>📥 {agent.tokens.inputTokens.toLocaleString()} in</span>
                )}
                {agent.tokens.outputTokens != null && (
                  <span>📤 {agent.tokens.outputTokens.toLocaleString()} out</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Session info */}
        <div className="detail-section">
          <div className="detail-label">Session</div>
          <div className="detail-value">
            {agent.active ? (
              <>
                <span className="detail-status-dot active" /> Active
              </>
            ) : (
              <>
                <span className="detail-status-dot inactive" /> Inactive
              </>
            )}
          </div>
          {agent.sessionUptime != null && (
            <div className="detail-subvalue">Uptime: {formatUptime(agent.sessionUptime)}</div>
          )}
          <div className="detail-subvalue">Last activity: {lastActivityDate}</div>
        </div>

        {/* Last message */}
        {agent.lastMessage && (
          <div className="detail-section">
            <div className="detail-label">Last Message</div>
            <div className="detail-message">{agent.lastMessage}</div>
          </div>
        )}

        {/* Sub-agents */}
        {agent.subAgents && agent.subAgents.length > 0 && (
          <div className="detail-section">
            <div className="detail-label">Sub-Agents ({agent.subAgents.length})</div>
            <div className="detail-subagents">
              {agent.subAgents.map((sub, i) => (
                <div key={i} className={`detail-subagent ${sub.status}`}>
                  <span className="subagent-dot" />
                  <span className="subagent-name">{sub.name || sub.id}</span>
                  {sub.task && <span className="subagent-task">{sub.task}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Status */}
        <div className="detail-footer">
          <div className={`detail-pixel-status ${agent.pixelEnabled ? 'enabled' : 'disabled'}`}>
            {agent.pixelEnabled ? '👁️ Visible in office' : '🚫 Hidden from office'}
          </div>
        </div>
      </div>
    </div>
  );
};

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
