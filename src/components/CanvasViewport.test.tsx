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
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const left = this.classList.contains('office-viewport') ? 12 : 0;
    const top = this.classList.contains('office-viewport') ? 240 : 0;
    return { width, height, left, top, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  const ref = createRef<CanvasViewportHandle>();
  const element = (key: string) => <CanvasViewport ref={ref} width={768} height={512} interactionKey={key}><canvas /></CanvasViewport>;
  const result = render(element('view'));
  return { ref, rerender: (key: string) => result.rerender(element(key)), world: () => document.querySelector<HTMLElement>('.office-world')! };
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
    act(() => ref.current!.zoomAt(2, 256, 560));
    expect(screen.getByTitle('Office zoom relative to Fit')).toHaveTextContent('250%');
    expect(world().style.width).toBe('1920px');
    expect(world().style.left).toBe('calc(50% + 140px)');
    expect(world().style.top).toBe('calc(50% - 64px)');
    fireEvent.click(screen.getByRole('button', { name: 'Fit office' }));
    expect(world().style.width).toBe('768px');
  });

  it('supports keyboard pan and restores button focus on Escape', () => {
    const { world } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pan office' }));
    const pan = screen.getByRole('region', { name: 'Pan office view' });
    fireEvent.keyDown(pan, { key: 'ArrowRight' });
    expect(world().style.left).toBe('calc(50% + 48px)');
    fireEvent.keyDown(pan, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Pan office view' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pan office' })).toHaveFocus();
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

  it('supports two-finger zoom and midpoint translation in Pan mode', () => {
    const { world } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Pan office' }));
    const pan = screen.getByRole('region', { name: 'Pan office view' });
    fireEvent.pointerDown(pan, { pointerId: 1, clientX: 212, clientY: 440 });
    fireEvent.pointerDown(pan, { pointerId: 2, clientX: 412, clientY: 440 });
    fireEvent.pointerMove(pan, { pointerId: 2, clientX: 612, clientY: 440 });
    expect(world().style.width).toBe('1536px');
    expect(world().style.left).toBe('calc(50% + 184px)');
    expect(world().style.top).toBe('calc(50% + 56px)');
  });

  it('leaves Pan on a tool or layout change while preserving zoom and position', () => {
    const { rerender, world } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pan office' }));
    const pan = screen.getByRole('region', { name: 'Pan office view' });
    fireEvent.pointerDown(pan, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(pan, { pointerId: 1, clientX: 140, clientY: 100 });
    rerender('next-tool');
    expect(screen.queryByRole('region', { name: 'Pan office view' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pan office' })).toHaveAttribute('aria-pressed', 'false');
    expect(world().style.width).toBe('960px');
    expect(world().style.left).toBe('calc(50% + 40px)');
    fireEvent.click(screen.getByRole('button', { name: 'Pan office' }));
    fireEvent.pointerMove(screen.getByRole('region', { name: 'Pan office view' }), { pointerId: 1, clientX: 200, clientY: 100 });
    expect(world().style.left).toBe('calc(50% + 40px)');
  });

  it('suppresses the browser context menu on the Pan surface', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Pan office' }));
    expect(fireEvent.contextMenu(screen.getByRole('region', { name: 'Pan office view' }))).toBe(false);
  });

  it('consumes Escape before an enclosing keyboard handler', () => {
    const onKeyDown = vi.fn();
    render(<div onKeyDown={onKeyDown}><CanvasViewport width={768} height={512} interactionKey="view"><canvas /></CanvasViewport></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Pan office' }));
    expect(fireEvent.keyDown(screen.getByRole('region', { name: 'Pan office view' }), { key: 'Escape' })).toBe(false);
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('does not rewrite an unchanged activity reservation on resize', () => {
    const writes = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
    render(<div className="app"><header className="app-header" />
      <CanvasViewport width={768} height={512} interactionKey="view"><canvas /></CanvasViewport>
      <div className="activity-dock" style={{ bottom: '12px' }}><button className="activity-toggle">Activity</button></div>
    </div>);
    act(() => resize());
    act(() => resize());
    expect(writes.mock.calls.filter(([name]) => name === '--office-bottom')).toHaveLength(1);
  });
});
