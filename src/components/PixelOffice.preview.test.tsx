import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PixelOffice } from './PixelOffice';
import { GameEngine } from '../game/GameEngine';
import { EditorController } from '../game/EditorController';
import { sfx } from '../audio/SoundFX';

// Real React adapter, engine and controller. Browser asset I/O deliberately
// stays pending; this exercises the real missing-sprite fallback before load.
describe('PixelOffice engine lifecycle and furniture preview status', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(sfx, 'place').mockImplementation(() => {});
    const ctx = new Proxy({}, { get: () => () => {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 768, height: 512 } as DOMRect);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('silently finishes cancelled initialization without refreshing or restarting a removed office', async () => {
    const responses: Array<(response: Response) => void> = [];
    let released = false;
    // Settle later requests too, so a cancellation regression fails assertions
    // rather than hanging if initialization incorrectly continues loading.
    vi.mocked(fetch).mockImplementation(() => released
      ? Promise.resolve(new Response('png'))
      : new Promise(resolve => { responses.push(resolve); }));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 16, height: 32, close: vi.fn() })));
    const initialization = vi.spyOn(GameEngine.prototype, 'init');
    const start = vi.spyOn(GameEngine.prototype, 'start');
    const stop = vi.spyOn(GameEngine.prototype, 'stop');
    const refresh = vi.spyOn(EditorController.prototype, 'refreshPreview');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<PixelOffice
      agents={[]} editorMode={false} deleteMode={false} activeLayout={null}
      selectedFurnitureType={null} onPlaceFurniture={vi.fn()} onMoveFurniture={vi.fn()}
      onSelectFurniture={vi.fn()} onRotateFurniture={vi.fn()}
    />);
    expect(responses).toHaveLength(2);
    const pending = initialization.mock.results[0].value;
    view.unmount();
    expect(stop).toHaveBeenCalledOnce();
    refresh.mockClear();
    await act(async () => {
      released = true;
      for (const resolve of responses) resolve(new Response('png'));
      await pending;
    });
    expect(error).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

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

  it('shares native editor pinch with zoom buttons and Fit through the real engine', () => {
    const view = render(<PixelOffice agents={[]} editorMode={false} deleteMode={false} activeLayout={null}
      selectedFurnitureType={null} onPlaceFurniture={vi.fn()} onMoveFurniture={vi.fn()}
      onSelectFurniture={vi.fn()} onRotateFurniture={vi.fn()} />);
    const canvas = view.container.querySelector('canvas')!;
    const touch = (type: string, distance: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: [{ clientX: 100, clientY: 100 }, { clientX: 100 + distance, clientY: 100 }] });
      fireEvent(canvas, event);
    };
    fireEvent.click(view.getByRole('button', { name: 'Zoom in' }));
    touch('touchstart', 100); touch('touchmove', 200);
    expect(view.getByTitle('Office zoom relative to Fit')).toHaveTextContent('250%');
    expect(canvas.style.transform).toBe('');
    fireEvent.click(view.getByRole('button', { name: 'Fit office' }));
    expect(view.getByTitle('Office zoom relative to Fit')).toHaveTextContent('100%');
    view.unmount();
  });

  it('maps native placement on an offset, zoomed canvas to the intended grid cell', () => {
    const place = vi.fn();
    const view = render(<PixelOffice agents={[]} editorMode={true} deleteMode={false} activeLayout={null}
      selectedFurnitureType="MISSING" onPlaceFurniture={place} onMoveFurniture={vi.fn()}
      onSelectFurniture={vi.fn()} onRotateFurniture={vi.fn()} />);
    const canvas = view.container.querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: -100, top: 20, width: 1536, height: 1024 } as DOMRect);
    fireEvent.mouseDown(canvas, { button: 0, clientX: -100 + 12.5 * 64, clientY: 20 + 8.5 * 64 });
    expect(place).toHaveBeenCalledWith('MISSING', 12, 8);
    view.unmount();
  });
});
