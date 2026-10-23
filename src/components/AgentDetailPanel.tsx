import React, { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentState, AgentActivity, SubAgentInfo } from '../../shared/types';
import { useModalFocus } from '../hooks/useModalFocus';
import { TaskDetails } from './TaskDetails';
import './AgentDetailPanel.css';

interface Props {
  agent: AgentState;
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
  idle: '#8a93b2',
  thinking: '#ffc107',
  typing: '#4ecca3',
  reading: '#17a2b8',
  running_command: '#e94560',
  waiting_input: '#ff6b6b',
  sleeping: '#8a93b2',
  error: '#dc3545',
};

export const AgentDetailPanel: React.FC<Props> = ({ agent, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const [tab, setTab] = useState<'task' | 'agent'>('task');
  const tabsId = useId();

  useModalFocus({ overlayRef, initialFocusRef: closeRef, onClose });

  const lastActivityDate = agent.lastActivity
    ? new Date(agent.lastActivity).toLocaleTimeString()
    : 'Never';

  const tokenPercent = agent.tokens
    ? Math.round((agent.tokens.used / agent.tokens.limit) * 100)
    : null;

  return createPortal(
    <div className="detail-overlay" onClick={onClose} ref={overlayRef} tabIndex={-1}>
      <div
        className="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={e => e.stopPropagation()}
      >
        <button
          ref={closeRef}
          type="button"
          className="detail-close"
          aria-label={`Close details for ${agent.name}`}
          onClick={onClose}
        >
          ✕
        </button>

        {/* Header */}
        <div className="detail-header">
          <div
            className="detail-avatar"
            style={{ backgroundColor: activityColors[agent.activity] }}
          >
            {agent.name.charAt(0)}
          </div>
          <div className="detail-title">
            <h2 id={headingId}>{agent.name}</h2>
            <span className="detail-id">{agent.id}</span>
          </div>
        </div>

        <div className="detail-tabs" role="tablist" aria-label="Agent details">
          {(['task', 'agent'] as const).map((name, index) => <button key={name} type="button" role="tab" id={`${tabsId}-${name}-tab`}
            aria-selected={tab === name} aria-controls={`${tabsId}-${name}-panel`} tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)} onKeyDown={event => {
              const position = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : event.key === 'ArrowRight' ? (index + 1) % 2 : event.key === 'ArrowLeft' ? (index + 1) % 2 : -1;
              if (position < 0) return; event.preventDefault(); const next = position === 0 ? 'task' : 'agent'; setTab(next); document.getElementById(`${tabsId}-${next}-tab`)?.focus();
            }}>{name === 'task' ? 'Task' : 'Agent'}</button>)}
        </div>
        <div role="tabpanel" id={`${tabsId}-task-panel`} aria-labelledby={`${tabsId}-task-tab`} hidden={tab !== 'task'}>
          <TaskDetails key={agent.id} agentId={agent.id} initialSessionKey={agent.sessionKey} active={tab === 'task'} />
        </div>
        <div role="tabpanel" id={`${tabsId}-agent-panel`} aria-labelledby={`${tabsId}-agent-tab`} hidden={tab !== 'agent'}>
        <p className="detail-subvalue">Office roster summary</p>
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
    </div>,
    document.body,
  );
};

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
