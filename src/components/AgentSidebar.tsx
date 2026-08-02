import React, { useState, useMemo, useCallback } from 'react';
import type { AgentState, AgentActivity, AgentTag, CharacterRecipe } from '../../shared/types';
import { TAG_COLORS } from '../../shared/types';
import { TagEditor } from './TagEditor';
import { CharacterCustomizer } from './CharacterCustomizer';
import { AgentPortrait } from './AgentPortrait';
import './AgentSidebar.css';

interface Props {
  agents: AgentState[];
  onToggle: (agentId: string, enabled: boolean) => void;
  onToggleAll: (enabled: boolean) => void;
  onSelectAgent?: (agentId: string) => void;
  onUpdateTags?: (agentId: string, tags: AgentTag[]) => Promise<void>;
  onUpdateRecipe?: (agentId: string, recipe: CharacterRecipe) => Promise<void>;
  /** Drawer mode (≤1024px): whether the off-canvas panel is open. */
  open?: boolean;
  /** Drawer mode: request to close (backdrop / close button). */
  onClose?: () => void;
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

interface AgentCardProps {
  agent: AgentState;
  onToggle: (agentId: string, enabled: boolean) => void;
  onSelectAgent?: (agentId: string) => void;
  onOpenTagEditor: (agent: AgentState) => void;
  onOpenCustomizer: (agent: AgentState) => void;
}

const AgentCard = React.memo<AgentCardProps>(({ agent, onToggle, onSelectAgent, onOpenTagEditor, onOpenCustomizer }) => {
  const cardClass = !agent.pixelEnabled
    ? 'agent-card disabled'
    : agent.active
      ? 'agent-card active'
      : 'agent-card inactive';

  return (
    <div className={`${cardClass}${onSelectAgent ? ' has-details' : ''}`}>
      {onSelectAgent && (
        <button
          type="button"
          className="agent-details-button"
          aria-label={`Open details for ${agent.name}`}
          onClick={() => onSelectAgent(agent.id)}
        />
      )}
      <div className="agent-card-inner">
        <div className="agent-portrait-wrapper">
          <AgentPortrait recipe={agent.recipe} size={44} />
        </div>
        <div className="agent-content">
          <div className="agent-header">
            <span className="agent-name">{agent.name}</span>
            <button
              className={`toggle-btn ${agent.pixelEnabled ? 'on' : 'off'}`}
              onClick={() => onToggle(agent.id, !agent.pixelEnabled)}
              title={agent.pixelEnabled ? 'Hide from office' : 'Show in office'}
              aria-label={agent.pixelEnabled ? `Hide ${agent.name} from office` : `Show ${agent.name} in office`}
              aria-pressed={agent.pixelEnabled}
            >
              {agent.pixelEnabled ? '👁️' : '👁️‍🗨️'}
            </button>
          </div>
          <div className="agent-details">
            <span className="agent-icon">
              {agent.pixelEnabled ? activityIcons[agent.activity] : '🚫'}
            </span>
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
              <div className="card-actions">
                <button
                  className="tag-edit-btn"
                  data-focus-return={`tags-${agent.id}`}
                  onClick={() => onOpenTagEditor(agent)}
                  title="Edit tags"
                  aria-label={`Edit tags for ${agent.name}`}
                >
                  ✏️
                </button>
                <button
                  className="tag-edit-btn"
                  onClick={() => onOpenCustomizer(agent)}
                  title="Customize appearance"
                  aria-label={`Customize appearance for ${agent.name}`}
                >
                  🎨
                </button>
              </div>
            </div>
          )}
          {(!agent.tags || agent.tags.length === 0) && (
            <div className="agent-tags">
              <button
                className="tag-add-btn"
                data-focus-return={`tags-${agent.id}`}
                onClick={() => onOpenTagEditor(agent)}
                title="Add tags"
                aria-label={`Add tags for ${agent.name}`}
              >
                + tags
              </button>
              <div className="card-actions">
                <button
                  className="tag-edit-btn"
                  onClick={() => onOpenCustomizer(agent)}
                  title="Customize appearance"
                  aria-label={`Customize appearance for ${agent.name}`}
                >
                  🎨
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export const AgentSidebar: React.FC<Props> = React.memo(({ agents, onToggle, onToggleAll, onSelectAgent, onUpdateTags, onUpdateRecipe, open = true, onClose }) => {
  const enabledCount = agents.filter(a => a.pixelEnabled).length;
  const [tagEditorAgent, setTagEditorAgent] = useState<AgentState | null>(null);
  const [customizerAgent, setCustomizerAgent] = useState<AgentState | null>(null);
  const openTagEditor = useCallback((agent: AgentState) => {
    setCustomizerAgent(null);
    setTagEditorAgent(agent);
  }, []);
  const openCustomizer = useCallback((agent: AgentState) => {
    setTagEditorAgent(null);
    setCustomizerAgent(agent);
  }, []);

  const agentCards = useMemo(() => agents.map(agent => (
    <AgentCard
      key={agent.id}
      agent={agent}
      onToggle={onToggle}
      onSelectAgent={onSelectAgent}
      onOpenTagEditor={openTagEditor}
      onOpenCustomizer={openCustomizer}
    />
  )), [agents, onToggle, onSelectAgent, openTagEditor, openCustomizer]);

  return (
    <aside className={`agent-sidebar ${open ? 'open' : ''}`} aria-label="Agents">
      <button className="sidebar-close-btn" onClick={onClose} aria-label="Close agents panel">✖</button>
      <h2>Agents ({enabledCount}/{agents.length})</h2>
      <div className="agent-list">
        {agentCards}
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
      {customizerAgent && onUpdateRecipe && (
        <CharacterCustomizer
          agentId={customizerAgent.id}
          agentName={customizerAgent.name}
          currentRecipe={customizerAgent.recipe || { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 }}
          onUpdateRecipe={onUpdateRecipe}
          onClose={() => setCustomizerAgent(null)}
        />
      )}
    </aside>
  );
});
