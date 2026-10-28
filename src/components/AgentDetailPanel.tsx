import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentState, AgentActivity, SubAgentInfo } from '../../shared/types';
import { useModalFocus } from '../hooks/useModalFocus';
import { TaskDetailsView } from './TaskDetails';
import { AgentConversation } from './AgentConversation';
import { TaskResults } from './TaskResults';
import { AgentWorkspace } from './AgentWorkspace';
import { ConversationUsage } from './ConversationUsage';
import { useTaskDetails } from '../control/useTaskDetails';
import { useRunHistory } from '../control/useRunHistory';
import { useControlAccess } from '../control/ControlAccess';
import { targetIdentity } from '../control/api';
import { HistoricalConversation, RunHistoryPicker } from './RunHistory';
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
const detailTabs = ['task', 'conversation', 'results', 'workspace', 'usage', 'agent'] as const;

export const AgentDetailPanel: React.FC<Props> = ({ agent, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const [tab, setTab] = useState<typeof detailTabs[number]>('task');
  const tabsId = useId();
  const access = useControlAccess();
  const [runSelection, setRunSelection] = useState<{ agentId: string; target: string; runId: string } | null>(null);
  const historical = runSelection?.agentId === agent.id;
  const controlActive = tab === 'task' || tab === 'conversation' || tab === 'results' || tab === 'usage';
  const details = useTaskDetails({ agentId: agent.id, initialSessionKey: agent.sessionKey, active: controlActive, taskActive: tab === 'task' && !historical, resultsActive: tab === 'results' && !historical, usageActive: tab === 'usage' && !historical });
  const selectedRunId = historical && details.selected && runSelection.target === targetIdentity(details.selected) ? runSelection.runId : undefined;
  const history = useRunHistory({ target: details.selected, runId: selectedRunId, active: controlActive, resultsActive: tab === 'results' && !!selectedRunId });
  const retainedHistory = !!selectedRunId && !history.snapshot?.task && !!history.lastKnown?.task;
  const historicalTask = history.snapshot?.task ?? (history.lastKnown?.task ? { ...history.lastKnown.task, source: { ...history.lastKnown.task.source, state: 'stale' as const } } : null);
  useEffect(() => { setRunSelection(null); }, [agent.id, access.generation]);
  useEffect(() => { if (access.state !== 'unlocked' || access.status?.canRead === false) setRunSelection(null); }, [access.state, access.status?.canRead]);
  const displayDetails = { ...details, selectSession: (target: Parameters<typeof details.selectSession>[0]) => { setRunSelection(null); details.selectSession(target); },
    ...(selectedRunId ? { historicalRunId: selectedRunId, task: historicalTask, results: history.results, usage: null, loading: history.loading, error: history.error,
      refresh: async () => { await history.refresh(); }, loadEarlier: async () => { await history.loadEarlier(); } } : {}) };
  const runNavigation = <RunHistoryPicker snapshot={history.snapshot} lastKnown={history.lastKnown} runId={selectedRunId} loading={history.loading} error={history.error}
    onSelect={runId => { if (runId && details.selected) setRunSelection({ agentId: agent.id, target: targetIdentity(details.selected), runId }); else setRunSelection(null); }}
    onRefresh={() => { void history.refresh(); }} onEarlier={() => { void history.loadEarlier(); }} />;

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
          {detailTabs.map((name, index) => <button key={name} type="button" role="tab" id={`${tabsId}-${name}-tab`}
            aria-selected={tab === name} aria-controls={`${tabsId}-${name}-panel`} tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)} onKeyDown={event => {
              const position = event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % detailTabs.length : event.key === 'ArrowLeft' ? (index + detailTabs.length - 1) % detailTabs.length : -1;
              if (position < 0) return; event.preventDefault(); const next = detailTabs[position]; setTab(next); document.getElementById(`${tabsId}-${next}-tab`)?.focus();
            }}>{name.charAt(0).toUpperCase() + name.slice(1)}</button>)}
        </div>
        <div role="tabpanel" id={`${tabsId}-task-panel`} aria-labelledby={`${tabsId}-task-tab`} hidden={tab !== 'task'}>
          <TaskDetailsView agentId={agent.id} active={tab === 'task'} state={displayDetails} runNavigation={runNavigation} historical={!!selectedRunId} retainedHistory={retainedHistory} />
        </div>
        <div role="tabpanel" id={`${tabsId}-conversation-panel`} aria-labelledby={`${tabsId}-conversation-tab`} hidden={tab !== 'conversation'}>
          <TaskDetailsView agentId={agent.id} active={tab === 'conversation'} state={displayDetails} runNavigation={runNavigation} historical={!!selectedRunId}>
            <div hidden={!!selectedRunId}><AgentConversation target={details.selected} agentId={agent.id} active={tab === 'conversation' && !selectedRunId} busy={details.selected?.hasActiveRun === true} onCreated={target => { setRunSelection(null); details.selectCreatedSession(target); }} /></div>
            {selectedRunId && <HistoricalConversation snapshot={history.snapshot?.task ? history.snapshot : history.lastKnown ?? history.snapshot} />}
          </TaskDetailsView>
        </div>
        <div role="tabpanel" id={`${tabsId}-results-panel`} aria-labelledby={`${tabsId}-results-tab`} hidden={tab !== 'results'}>
          <TaskDetailsView agentId={agent.id} active={tab === 'results'} state={displayDetails} runNavigation={runNavigation} historical={!!selectedRunId}>
            <TaskResults state={displayDetails} active={tab === 'results'} />
          </TaskDetailsView>
        </div>
        <div role="tabpanel" id={`${tabsId}-workspace-panel`} aria-labelledby={`${tabsId}-workspace-tab`} hidden={tab !== 'workspace'}>
          <AgentWorkspace agentId={agent.id} active={tab === 'workspace'} />
        </div>
        <div role="tabpanel" id={`${tabsId}-usage-panel`} aria-labelledby={`${tabsId}-usage-tab`} hidden={tab !== 'usage'}>
          <TaskDetailsView agentId={agent.id} active={tab === 'usage'} state={displayDetails} runNavigation={runNavigation} historical={!!selectedRunId}>
            {selectedRunId ? <p className="task-notice">Per-run usage is unavailable from the current Gateway contract. Conversation totals are not shown as usage for this recorded run. Return to Live / latest task to view conversation Usage.</p> : <ConversationUsage snapshot={details.usage} loading={details.loading || details.sessionsLoading} selected={details.selected !== null} error={details.usageError} />}
          </TaskDetailsView>
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
