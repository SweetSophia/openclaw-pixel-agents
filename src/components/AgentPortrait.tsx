/**
 * AgentPortrait — Small composed character portrait for sidebar
 *
 * Renders a static preview of the agent's composed sprite at a small scale.
 * The recipe → canvas rendering is shared with CharacterCustomizer
 * via `./recipePreview` (issue #165).
 */

import React, { useEffect, useRef } from 'react';
import type { CharacterRecipe } from '../../shared/types';
import { drawRecipePreview } from './recipePreview';
import './AgentPortrait.css';

interface Props {
  recipe?: CharacterRecipe;
  size?: number;
}

const DEFAULT_RECIPE: CharacterRecipe = { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 };
const BASE = '/assets/source/MetroCity/';

export const AgentPortrait: React.FC<Props> = ({ recipe, size = 40 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const r = recipe || DEFAULT_RECIPE;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Keep the centered close-up: the 16×32 crop is twice as tall as it is wide.
    const width = Math.floor(size * 0.8);

    const cancelled = { value: false };
    drawRecipePreview({
      canvas,
      recipe: r,
      basePath: BASE,
      destinationSize: { width, height: width * 2 },
      background: 'transparent',
      cancelled,
    });
    return () => { cancelled.value = true; };
  }, [r.bodyIndex, r.hairIndex, r.outfitIndex, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className="agent-portrait"
    />
  );
};
