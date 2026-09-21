/**
 * CharacterCustomizer — Paperdoll recipe editor for agents
 *
 * Lets users pick body, hair, and outfit indices for each agent's
 * composed character sprite. Shows a live preview via canvas rendering.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { CharacterRecipe } from '../../shared/types';
import { useModalFocus } from '../hooks/useModalFocus';
import { drawRecipePreview } from './recipePreview';
import './CharacterCustomizer.css';

interface Props {
  agentId: string;
  agentName: string;
  currentRecipe: CharacterRecipe;
  onUpdateRecipe: (agentId: string, recipe: CharacterRecipe) => Promise<void>;
  onClose: () => void;
}

// Label sets for the picker UI
const BODY_LABELS = ['Light', 'Fair', 'Medium', 'Tan', 'Brown', 'Dark'];
const HAIR_LABELS = ['Short', 'Neat', 'Long', 'Spiky', 'Wavy', 'Curly', 'Flowing', 'Braided'];
const OUTFIT_LABELS = ['Shirt', 'Formal', 'Casual', 'Belt', 'Full', 'Hoodie'];

const BODY_SKIN_PREVIEW = ['#fce4c0', '#f5d0a9', '#d4a574', '#c68642', '#8d5524', '#5c3310'];
const HAIR_COLOR_PREVIEW = ['#3a2213', '#1a1a1a', '#6b4423', '#d4a44c', '#8b4513', '#2c1810', '#c4a35a', '#1c0f05'];
const OUTFIT_COLOR_PREVIEW = ['#4a6fa5', '#2d3748', '#48bb78', '#9f7aea', '#ed8936', '#636e72'];

export const CharacterCustomizer: React.FC<Props> = ({
  agentId,
  agentName,
  currentRecipe,
  onUpdateRecipe,
  onClose,
}) => {
  const [recipe, setRecipe] = useState<CharacterRecipe>({ ...currentRecipe });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useModalFocus({ overlayRef, initialFocusRef: headingRef, onClose });

  // Issue #164: reset local form state when the agent identity
  // changes — but key on `agentId` ONLY (not `currentRecipe`).
  // AgentSidebar passes `currentRecipe={customizerAgent.recipe ?? {...}}`
  // and the `??` fallback is a fresh object literal on every render, so
  // depending on `currentRecipe` would re-fire this effect on every
  // unrelated parent re-render (socket event, sidebar toggle, etc.)
  // and silently clobber the user's in-progress selection. The
  // initial `useState({...currentRecipe})` already seeds state from
  // props on mount; this effect handles the later case where
  // `agentId` itself changes (modal reuse / switch-agent control).
  useEffect(() => {
    setRecipe({ ...currentRecipe });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Live preview: render the composed character on a canvas.
  // The recipe → canvas logic is shared with AgentPortrait via
  // `./recipePreview` (issue #165).
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;

    const cancelled = { value: false };
    drawRecipePreview({
      canvas,
      recipe,
      basePath: '/assets/source/MetroCity/',
      background: 'checkerboard',
      cancelled,
    });
    return () => { cancelled.value = true; };
  }, [recipe.bodyIndex, recipe.hairIndex, recipe.outfitIndex]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await onUpdateRecipe(agentId, recipe);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [agentId, recipe, onUpdateRecipe, onClose]);

  const headingId = `customizer-heading-${agentId}`;

  return createPortal(
    <div className="customizer-overlay" onClick={onClose} ref={overlayRef} tabIndex={-1}>
      <div
        className="customizer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={e => e.stopPropagation()}
      >
        <h3 ref={headingRef} id={headingId} tabIndex={-1}>Customize {agentName}</h3>

        {/* Live preview */}
        <div className="customizer-preview">
          <canvas
            ref={previewRef}
            width={80}
            height={112}
            className="preview-canvas"
          />
        </div>

        {/* Body picker */}
        <div className="option-group">
          <label className="option-label">Body</label>
          <div className="option-chips">
            {BODY_LABELS.map((label, i) => (
              <button
                key={i}
                className={`option-chip ${recipe.bodyIndex === i ? 'selected' : ''}`}
                style={{
                  borderColor: recipe.bodyIndex === i ? BODY_SKIN_PREVIEW[i] : '#333',
                  backgroundColor: recipe.bodyIndex === i ? BODY_SKIN_PREVIEW[i] + '30' : 'transparent',
                }}
                onClick={() => setRecipe(r => ({ ...r, bodyIndex: i }))}
              >
                <span
                  className="body-dot"
                  style={{ backgroundColor: BODY_SKIN_PREVIEW[i] }}
                />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Hair picker */}
        <div className="option-group">
          <label className="option-label">Hair</label>
          <div className="option-chips">
            {HAIR_LABELS.map((label, i) => (
              <button
                key={i}
                className={`option-chip ${recipe.hairIndex === i ? 'selected' : ''}`}
                style={{
                  borderColor: recipe.hairIndex === i ? HAIR_COLOR_PREVIEW[i] : '#333',
                  backgroundColor: recipe.hairIndex === i ? HAIR_COLOR_PREVIEW[i] + '30' : 'transparent',
                }}
                onClick={() => setRecipe(r => ({ ...r, hairIndex: i }))}
              >
                <span
                  className="hair-dot"
                  style={{ backgroundColor: HAIR_COLOR_PREVIEW[i] }}
                />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Outfit picker */}
        <div className="option-group">
          <label className="option-label">Outfit</label>
          <div className="option-chips">
            {OUTFIT_LABELS.map((label, i) => (
              <button
                key={i}
                className={`option-chip ${recipe.outfitIndex === i ? 'selected' : ''}`}
                style={{
                  borderColor: recipe.outfitIndex === i ? OUTFIT_COLOR_PREVIEW[i] : '#333',
                  backgroundColor: recipe.outfitIndex === i ? OUTFIT_COLOR_PREVIEW[i] + '30' : 'transparent',
                }}
                onClick={() => setRecipe(r => ({ ...r, outfitIndex: i }))}
              >
                <span
                  className="outfit-dot"
                  style={{ backgroundColor: OUTFIT_COLOR_PREVIEW[i] }}
                />
                {label}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="customizer-error">{error}</p>}

        <div className="customizer-actions">
          <button className="customizer-save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Apply'}
          </button>
          <button className="customizer-cancel" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
