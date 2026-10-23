import React, { StrictMode } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPortrait } from './AgentPortrait';

const drawImage = vi.fn();

beforeEach(() => {
  drawImage.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(), drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sidebar portrait source frames', () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7])('samples complete 32px frames for hairstyle %i', async hairIndex => {
    const bodyIndex = hairIndex % 6;
    render(<StrictMode><AgentPortrait recipe={{ bodyIndex, hairIndex, outfitIndex: 0 }} size={44} /></StrictMode>);

    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(3));
    // Scaling a small portrait must not change the source sheet's row stride.
    expect(drawImage.mock.calls[0].slice(1, 5)).toEqual([8, bodyIndex * 32, 16, 32]);
    expect(drawImage.mock.calls[1].slice(1, 5)).toEqual([8, 0, 16, 32]);
    expect(drawImage.mock.calls[2].slice(1, 5)).toEqual([8, hairIndex * 32, 16, 32]);
    // Keep the existing centered close-up framing at the canvas boundary.
    expect(drawImage.mock.calls[0].slice(5)).toEqual([4, -13, 35, 70]);
  });
});
