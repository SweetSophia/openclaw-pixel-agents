/**
 * CharacterCustomizer — Paperdoll recipe editor for agents
 *
 * Lets users pick body, hair, and outfit indices for each agent's
 * composed character sprite. Shows a live preview via canvas rendering.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { CharacterRecipe } from '../../shared/types';
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

  // Live preview: render the composed character on a canvas
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const previewCanvas = canvas;
    const previewCtx = ctx;

    previewCtx.imageSmoothingEnabled = false;

    // Load source sheets and composite a preview
    let cancelled = false;

    async function renderPreview() {
      if (cancelled) return;

      const BASE = '/assets/source/MetroCity/';
      const SRC = 32;
      const DST = 48; // 1.5× scale for better visibility

      try {
        // Load the three layers for the down-facing idle frame (col 0 in source)
        const [bodyImg, hairImg, outfitImg] = await Promise.all([
          loadImage(`${BASE}CharacterModel/Character Model.png`),
          loadImage(`${BASE}Hair/Hairs.png`),
          loadImage(`${BASE}Outfits/Outfit${recipe.outfitIndex + 1}.png`),
        ]);

        if (cancelled) return;

        // Clear
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

        // Draw checkerboard background for transparency
        const CHECK = 6;
        for (let y = 0; y < previewCanvas.height; y += CHECK) {
          for (let x = 0; x < previewCanvas.width; x += CHECK) {
            previewCtx.fillStyle = ((x / CHECK + y / CHECK) % 2 === 0) ? '#1a1a2e' : '#16213e';
            previewCtx.fillRect(x, y, CHECK, CHECK);
          }
        }

        // Source crop: south direction (col 0), row = bodyIndex/hairIndex/outfitIndex
        const srcX = 0; // south idle frame
        const cropX = 8; // center 16px of 32px source
        const cropW = 16;
        const cropH = 32;

        // Layer: body
        previewCtx.drawImage(bodyImg, srcX + cropX, recipe.bodyIndex * SRC, cropW, cropH, 16, 8, DST, DST * 2);
        // Layer: outfit
        previewCtx.drawImage(outfitImg, srcX + cropX, 0, cropW, cropH, 16, 8, DST, DST * 2);
        // Layer: hair
        previewCtx.drawImage(hairImg, srcX + cropX, recipe.hairIndex * SRC, cropW, cropH, 16, 8, DST, DST * 2);

      } catch (err) {
        if (cancelled) return;

        // Preview failed — draw fallback
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        previewCtx.fillStyle = '#1a1a2e';
        previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
        previewCtx.fillStyle = '#4ecca3';
        previewCtx.font = '12px monospace';
        previewCtx.textAlign = 'center';
        previewCtx.fillText('Preview', previewCanvas.width / 2, previewCanvas.height / 2);
      }
    }

    renderPreview();
    return () => { cancelled = true; };
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

  // Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const headingId = `customizer-heading-${agentId}`;

  return (
    <div className="customizer-overlay" onClick={onClose}>
      <div
        className="customizer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={e => e.stopPropagation()}
      >
        <h3 id={headingId}> Customize {agentName}</h3>

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
    </div>
  );
};

/** Load an image from a URL and return an HTMLImageElement */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}
