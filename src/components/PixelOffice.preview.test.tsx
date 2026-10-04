import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PixelOffice } from './PixelOffice';
import { GameEngine } from '../game/GameEngine';

// Real React adapter, engine and controller. Browser asset I/O deliberately
// stays pending; this exercises the real missing-sprite fallback before load.
describe('PixelOffice furniture preview status', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const ctx = new Proxy({}, { get: () => () => {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 768, height: 512 } as DOMRect);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('registers one initially empty polite node before updates, retains its identity and clears on layout and cleanup', () => {
    const props = {
      agents: [], editorMode: true, deleteMode: false, selectedFurnitureType: 'MISSING',
      activeLayout: { id: 'room', name: 'Room', width: 24, height: 16, updatedAt: 1, furniture: [{ id: 'table', type: 'MISSING', x: 5, y: 5, rotation: 0 }], seats: {} },
      onPlaceFurniture: vi.fn(), onMoveFurniture: vi.fn(), onSelectFurniture: vi.fn(), onRotateFurniture: vi.fn(),
    };
    const view = render(<PixelOffice {...props} />);
    const node = view.getByRole('status'); expect(node).toHaveTextContent(''); expect(node).toHaveAttribute('aria-live', 'polite');
    const canvas = view.container.querySelector('canvas')!;
    fireEvent.mouseMove(canvas, { clientX: 176, clientY: 176 });
    expect(view.getByRole('status')).toBe(node); expect(node).toHaveTextContent('Overlaps furniture — placement is allowed.');
    fireEvent.mouseMove(canvas, { clientX: 180, clientY: 176 }); expect(view.getByRole('status')).toBe(node);
    view.rerender(<PixelOffice {...props} activeLayout={{ ...props.activeLayout, id: 'other' }} />); expect(node).toHaveTextContent('');
    fireEvent.mouseMove(canvas, { clientX: 176, clientY: 176 }); expect(node).toHaveTextContent('Overlaps furniture');
    act(() => fireEvent.mouseLeave(canvas)); expect(node).toHaveTextContent('');
    fireEvent.mouseMove(canvas, { clientX: 176, clientY: 176 });
    view.rerender(<PixelOffice {...props} activeLayout={null} />); expect(node).toHaveTextContent('');
    expect(view.getByRole('status')).toBe(node);
    const removal = vi.spyOn(GameEngine.prototype, 'setFurniturePreviewCallback'); view.unmount(); expect(removal).toHaveBeenCalledWith(null);
  });
});
