import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasViewport, type CanvasViewportHandle } from './CanvasViewport';

let resize: () => void;
let width = 768;
let height = 512;
beforeEach(() => {
  width = 768; height = 512;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width, height, left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {},
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  const ref = createRef<CanvasViewportHandle>();
  const click = vi.fn();
  render(<CanvasViewport ref={ref} width={768} height={512} interactionKey="view"><canvas onClick={click} /></CanvasViewport>);
  return { ref, click, world: () => document.querySelector<HTMLElement>('.office-world')! };
}

describe('office canvas controls', () => {
  it('starts fitted and exposes named controls with bounded zoom', () => {
    const { world } = setup();
    expect(world().style.width).toBe('768px');
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(world().style.width).toBe('960px');
    expect(screen.getByTitle('Office zoom relative to Fit')).toHaveTextContent('125%');
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    expect(world().style.width).toBe('3072px');
  });

  it('Fit recenters, exits Pan and adapts to resized available space', () => {
    const { world } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pan office' }));
    expect(screen.getByRole('button', { name: 'Pan office' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Fit office' }));
    expect(screen.getByRole('button', { name: 'Pan office' })).toHaveAttribute('aria-pressed', 'false');
    width = 320; height = 600;
    act(() => resize());
    expect(world().style.width).toBe('320px');
    expect(world().style.left).toBe('50%');
  });

  it('shares pinch zoom with toolbar zoom and Fit', () => {
    const { ref, world } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    act(() => ref.current!.zoomAt(2, 384, 256));
    expect(screen.getByTitle('Office zoom relative to Fit')).toHaveTextContent('250%');
    expect(world().style.width).toBe('1920px');
    fireEvent.click(screen.getByRole('button', { name: 'Fit office' }));
    expect(world().style.width).toBe('768px');
  });

  it('supports keyboard pan and Escape without forwarding clicks to the canvas', () => {
    const { world, click } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pan office' }));
    const pan = screen.getByRole('region', { name: 'Pan office view' });
    fireEvent.keyDown(pan, { key: 'ArrowRight' });
    expect(world().style.left).toBe('calc(50% + 48px)');
    fireEvent.click(pan);
    expect(click).not.toHaveBeenCalled();
    fireEvent.keyDown(pan, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Pan office view' })).toBeNull();
  });

  it('ends captured drags on cancellation and window blur', () => {
    const { world } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pan office' }));
    const pan = screen.getByRole('region', { name: 'Pan office view' });
    fireEvent.pointerDown(pan, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(pan, { pointerId: 1, clientX: 120, clientY: 100 });
    expect(world().style.left).toBe('calc(50% + 20px)');
    fireEvent.pointerCancel(pan, { pointerId: 1 });
    fireEvent.pointerMove(pan, { pointerId: 1, clientX: 150, clientY: 100 });
    expect(world().style.left).toBe('calc(50% + 20px)');
    fireEvent.pointerDown(pan, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent(window, new Event('blur'));
    fireEvent.pointerMove(pan, { pointerId: 2, clientX: 150, clientY: 100 });
    expect(world().style.left).toBe('calc(50% + 20px)');
  });

  it('supports two-finger zoom in Pan mode without forwarding canvas gestures', () => {
    const { world, click } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Pan office' }));
    const pan = screen.getByRole('region', { name: 'Pan office view' });
    fireEvent.pointerDown(pan, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerDown(pan, { pointerId: 2, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(pan, { pointerId: 2, clientX: 600, clientY: 200 });
    expect(world().style.width).toBe('1536px');
    expect(world().style.left).toBe('calc(50% + 184px)');
    expect(world().style.top).toBe('calc(50% + 56px)');
    expect(click).not.toHaveBeenCalled();
  });
});
