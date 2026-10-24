import React, { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPortrait } from './AgentPortrait';
import { drawRecipePreview } from './recipePreview';
import { AgentSidebar } from './AgentSidebar';
import type { AgentState } from '../../shared/types';

const drawImage = vi.fn();

beforeEach(() => {
  drawImage.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(), fillRect: vi.fn(), drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    url = '';
    height = 0;
    set src(value: string) {
      this.url = value;
      this.height = value.includes('/Hair/') ? 256 : value.includes('/CharacterModel/') ? 192 : 32;
      queueMicrotask(() => this.onload?.());
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sidebar portrait source frames', () => {
  const agent = (id: string, name: string): AgentState => ({
    id, name, activity: 'sleeping', model: 'unknown', sessionKey: `agent:${id}:fixture`, active: false,
    lastActivity: 0, pixelEnabled: true, tags: [],
  });

  it('uses identity-specific office defaults in portraits when a saved recipe is absent', async () => {
    render(<AgentSidebar agents={[agent('main', 'Shodan'), agent('miku', 'Miku')]}
      onToggle={vi.fn()} onToggleAll={vi.fn()} onUpdateRecipe={vi.fn()} />);
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(6));
    const bodyRows = drawImage.mock.calls.filter(([image]) => image.url.includes('/CharacterModel/')).map(call => call[2]);
    const hairRows = drawImage.mock.calls.filter(([image]) => image.url.includes('/Hair/')).map(call => call[2]);
    expect(bodyRows).toEqual([96, 32]);
    expect(hairRows).toEqual([0, 192]);
  });

  it('opens the customizer with the same resolved appearance as the portrait and office', () => {
    render(<AgentSidebar agents={[agent('miku', 'Miku')]}
      onToggle={vi.fn()} onToggleAll={vi.fn()} onUpdateRecipe={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Customize appearance for Miku' }));
    expect(screen.getByRole('button', { name: 'Fair' })).toHaveClass('selected');
    expect(screen.getByRole('button', { name: 'Flowing' })).toHaveClass('selected');
    expect(screen.getByRole('button', { name: 'Shirt' })).toHaveClass('selected');
  });

  it.each([
    { bodyIndex: 3, hairIndex: 0, bodyY: 96, hairY: 0 },
    { bodyIndex: 4, hairIndex: 1, bodyY: 128, hairY: 32 },
    { bodyIndex: 5, hairIndex: 2, bodyY: 160, hairY: 64 },
    { bodyIndex: 0, hairIndex: 3, bodyY: 0, hairY: 96 },
    { bodyIndex: 1, hairIndex: 4, bodyY: 32, hairY: 128 },
    { bodyIndex: 2, hairIndex: 5, bodyY: 64, hairY: 160 },
    { bodyIndex: 3, hairIndex: 6, bodyY: 96, hairY: 192 },
    { bodyIndex: 4, hairIndex: 7, bodyY: 128, hairY: 224 },
    { bodyIndex: 5, hairIndex: 8, bodyY: 160, hairY: 224 },
  ])('samples full layers for body $bodyIndex and hairstyle $hairIndex', async ({ bodyIndex, hairIndex, bodyY, hairY }) => {
    render(<StrictMode><AgentPortrait recipe={{ bodyIndex, hairIndex, outfitIndex: 0 }} size={44} /></StrictMode>);

    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(3));
    // Scaling a small portrait must not change the source sheet's row stride.
    expect(drawImage.mock.calls[0][0].url).toContain('/CharacterModel/Character Model.png');
    expect(drawImage.mock.calls[1][0].url).toContain('/Outfits/Outfit1.png');
    expect(drawImage.mock.calls[2][0].url).toContain('/Hair/Hairs.png');
    expect(drawImage.mock.calls[0].slice(1, 5)).toEqual([8, bodyY, 16, 32]);
    expect(drawImage.mock.calls[1].slice(1, 5)).toEqual([8, 0, 16, 32]);
    expect(drawImage.mock.calls[2].slice(1, 5)).toEqual([8, hairY, 16, 32]);
    // Keep the existing centered close-up framing at the canvas boundary.
    expect(drawImage.mock.calls[0].slice(5)).toEqual([4, -13, 35, 70]);
  });

  it('keeps the customizer default centered at 24 by 48 pixels', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 112;
    await drawRecipePreview({ canvas, recipe: { bodyIndex: 3, hairIndex: 2, outfitIndex: 4 }, basePath: '/assets/source/MetroCity/' });
    expect(drawImage).toHaveBeenCalledTimes(3);
    expect(drawImage.mock.calls[0].slice(5)).toEqual([28, 32, 24, 48]);
  });
});
