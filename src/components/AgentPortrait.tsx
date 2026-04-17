/**
 * AgentPortrait — Small composed character portrait for sidebar
 *
 * Renders a static preview of the agent's composed sprite at a small scale.
 */

import React, { useEffect, useRef } from 'react';
import type { CharacterRecipe } from '../../shared/types';
import './AgentPortrait.css';

interface Props {
  recipe?: CharacterRecipe;
  size?: number;
}

const DEFAULT_RECIPE: CharacterRecipe = { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 };

const SHEET_CACHE = new Map<string, Promise<HTMLImageElement>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = SHEET_CACHE.get(src);
  if (cached) return cached;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => { SHEET_CACHE.delete(src); reject(new Error(`Failed to load ${src}`)); };
    img.src = src;
  });
  SHEET_CACHE.set(src, promise);
  return promise;
}

export const AgentPortrait: React.FC<Props> = ({ recipe, size = 40 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const r = recipe || DEFAULT_RECIPE;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const context = ctx; // local non-null reference for async closure
    context.imageSmoothingEnabled = false;
    let cancelled = false;

    async function render() {
      const BASE = '/assets/source/MetroCity/';
      const SRC = 32;
      // Scale to fit desired size while maintaining aspect ratio
      const scale = size / 20; // Base character is roughly 16x20 visible
      const dstW = Math.floor(16 * scale);
      const dstH = Math.floor(32 * scale);
      const offsetX = Math.floor((size - dstW) / 2);
      const offsetY = Math.floor((size - dstH) / 2) - 2; // Shift up slightly

      try {
        const [bodyImg, hairImg, outfitImg] = await Promise.all([
          loadImage(`${BASE}CharacterModel/Character Model.png`),
          loadImage(`${BASE}Hair/Hairs.png`),
          loadImage(`${BASE}Outfits/Outfit${r.outfitIndex + 1}.png`),
        ]);

        if (cancelled) return;

        context.clearRect(0, 0, size, size);

        // Transparent background (no checkerboard for cleaner sidebar look)
        context.fillStyle = 'transparent';
        context.fillRect(0, 0, size, size);

        const srcX = 0; // south idle frame
        const cropX = 8; // center 16px of 32px
        const cropW = 16;
        const cropH = 32;

        // Draw layers: body → outfit → hair
        context.drawImage(bodyImg, srcX + cropX, r.bodyIndex * SRC, cropW, cropH, offsetX, offsetY, dstW, dstH);
        context.drawImage(outfitImg, srcX + cropX, 0, cropW, cropH, offsetX, offsetY, dstW, dstH);
        context.drawImage(hairImg, srcX + cropX, r.hairIndex * SRC, cropW, cropH, offsetX, offsetY, dstW, dstH);

      } catch {
        if (cancelled) return;
        // Fallback: draw a simple colored circle
        context.fillStyle = '#4ecca3';
        context.beginPath();
        context.arc(size / 2, size / 2, size / 3, 0, Math.PI * 2);
        context.fill();
      }
    }

    render();
    return () => { cancelled = true; };
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
