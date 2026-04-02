import React, { useState, useEffect, useCallback } from 'react';
import { ALL_TAGS, TAG_COLORS, type AgentTag } from '../hooks/useAgentStore';
import './TagEditor.css';

interface Props {
  agentId: string;
  agentName: string;
  currentTags: string[];
  onUpdateTags: (agentId: string, tags: string[]) => Promise<void>;
  onClose: () => void;
}

export const TagEditor: React.FC<Props> = ({ agentId, agentName, currentTags, onUpdateTags, onClose }) => {
  const [selectedTags, setSelectedTags] = useState<string[]>([...currentTags]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await onUpdateTags(agentId, selectedTags);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save tags');
    } finally {
      setSaving(false);
    }
  }, [agentId, selectedTags, onUpdateTags, onClose]);

  // Escape key handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const toggleTag = (tag: string) => {
    setSelectedTags(prev => {
      if (prev.includes(tag)) {
        return prev.filter(t => t !== tag);
      }
      // Max 3 tags to keep room routing simple
      if (prev.length >= 3) return prev;
      return [...prev, tag];
    });
  };

  const headingId = `tag-editor-heading-${agentId}`;

  return (
    <div className="tag-editor-overlay" onClick={onClose}>
      <div
        className="tag-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={e => e.stopPropagation()}
      >
        <h3 id={headingId}>Tags for {agentName}</h3>
        <p className="tag-hint">First tag determines room assignment. Max 3.</p>
        <div className="tag-palette">
          {ALL_TAGS.map(tag => {
            const isSelected = selectedTags.includes(tag);
            const isFirst = selectedTags[0] === tag;
            return (
              <button
                key={tag}
                className={`tag-chip ${isSelected ? 'selected' : ''} ${isFirst ? 'primary' : ''}`}
                style={{
                  borderColor: isSelected ? TAG_COLORS[tag as AgentTag] : '#333',
                  backgroundColor: isSelected ? TAG_COLORS[tag as AgentTag] + '20' : 'transparent',
                }}
                onClick={() => toggleTag(tag)}
              >
                {isFirst && <span className="tag-star">★</span>}
                {tag}
              </button>
            );
          })}
        </div>
        <div className="tag-selected-order">
          <span className="tag-order-label">Room routing:</span>
          {selectedTags.length > 0 ? (
            selectedTags.map((tag, i) => (
              <span key={tag} className="tag-order-item">
                {i === 0 ? '→' : '+'}
                <span style={{ color: TAG_COLORS[tag as AgentTag] }}>{tag}</span>
              </span>
            ))
          ) : (
            <span className="tag-order-item">(default: office)</span>
          )}
        </div>
        {error && <p className="tag-editor-error">{error}</p>}
        <div className="tag-editor-actions">
          <button className="tag-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button className="tag-cancel-btn" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
};
