import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EditorController } from './EditorController';
import type {
  EditorCallbacks,
  EditorControllerHost,
  EditorControllerSounds,
  FurnitureHit,
} from './EditorController';

function touchEvent(type: string, points: Array<{ clientX: number; clientY: number }>): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, 'touches', { value: points });
  return event;
}

describe('EditorController', () => {
  let canvas: HTMLCanvasElement;
  let furniture: FurnitureHit | null;
  let host: EditorControllerHost;
  let sounds: EditorControllerSounds;
  let callbacks: EditorCallbacks;
  let nowMs: number;
  let controller: EditorController;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    furniture = null;
    nowMs = 1_000;
    host = {
      screenToGrid: vi.fn((x: number, y: number) => ({ gridX: x, gridY: y })),
      findFurnitureAt: vi.fn(() => furniture),
      previewFurnitureMove: vi.fn(),
      rotateFurnitureAt: vi.fn(() => furniture
        ? { id: furniture.id, rotation: 90 }
        : null),
      findCharacterAt: vi.fn(() => null),
      hasSelectedAgent: vi.fn(() => false),
      handleTouchGridTap: vi.fn(),
    };
    sounds = { place: vi.fn(), pickup: vi.fn() };
    callbacks = {
      onPlaceFurniture: vi.fn(),
      onSelectFurniture: vi.fn(),
      onMoveFurniture: vi.fn(),
      onRotateFurniture: vi.fn(),
    };
    controller = new EditorController(
      canvas,
      { gridWidth: 24, gridHeight: 16 },
      host,
      sounds,
      () => nowMs,
    );
    controller.setEditorCallbacks(callbacks);
  });

  it('attaches and detaches canvas listeners as one lifecycle unit', () => {
    controller.attach();
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 4, clientY: 5 }));
    expect(host.screenToGrid).toHaveBeenCalledTimes(1);

    controller.detach();
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 8, clientY: 9 }));
    expect(host.screenToGrid).toHaveBeenCalledTimes(1);
  });

  it('preserves GameEngine setter reset semantics', () => {
    controller.setSelectedFurnitureType('DESK');
    controller.setSelectedFurnitureId('desk-1');
    expect(controller.selectedFurnitureType).toBeNull();
    expect(controller.selectedFurnitureId).toBe('desk-1');

    controller.setEditorMode(true);
    expect(controller.editorMode).toBe(true);
    expect(controller.selectedFurnitureType).toBeNull();
    expect(controller.selectedFurnitureId).toBeNull();
    expect(canvas.style.cursor).toBe('default');
  });

  it('places selected furniture on primary mouse down', () => {
    controller.attach();
    controller.setEditorMode(true);
    controller.setSelectedFurnitureType('DESK');

    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 5, clientY: 6 }));

    expect(callbacks.onPlaceFurniture).toHaveBeenCalledWith('DESK', 5, 6);
    expect(sounds.place).toHaveBeenCalledOnce();
  });

  it('selects for deletion without starting a drag', () => {
    furniture = { id: 'desk-1', x: 3, y: 4 };
    controller.attach();
    controller.setEditorMode(true);
    controller.setDeleteMode(true);

    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 4, clientY: 5 }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 8, clientY: 9 }));

    expect(callbacks.onSelectFurniture).toHaveBeenCalledWith('desk-1');
    expect(callbacks.onMoveFurniture).not.toHaveBeenCalled();
    expect(sounds.pickup).not.toHaveBeenCalled();
  });

  it('preserves mouse drag clamping and its no-offset behavior', () => {
    furniture = { id: 'desk-1', x: 3, y: 4 };
    controller.attach();
    controller.setEditorMode(true);

    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 5, clientY: 7 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 99, clientY: 99 }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 99, clientY: 99 }));

    expect(host.previewFurnitureMove).toHaveBeenCalledWith('desk-1', 21, 13);
    expect(callbacks.onMoveFurniture).toHaveBeenCalledWith('desk-1', 21, 13);
    expect(sounds.pickup).toHaveBeenCalledOnce();
    expect(sounds.place).toHaveBeenCalledOnce();
  });

  it('reports the resulting context-menu rotation without adding sound', () => {
    furniture = { id: 'desk-1', x: 3, y: 4 };
    controller.attach();
    controller.setEditorMode(true);
    canvas.dispatchEvent(new MouseEvent('contextmenu', { clientX: 4, clientY: 5, cancelable: true }));

    expect(host.rotateFurnitureAt).toHaveBeenCalledWith(4, 5);
    expect(callbacks.onRotateFurniture).toHaveBeenCalledWith('desk-1', 90);
    expect(sounds.place).not.toHaveBeenCalled();
  });

  it('preserves touch drag grab offsets for preview and final placement', () => {
    furniture = { id: 'desk-1', x: 3, y: 4 };
    controller.attach();
    controller.setEditorMode(true);

    canvas.dispatchEvent(touchEvent('touchstart', [{ clientX: 5, clientY: 6 }]));
    canvas.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 12 }]));
    canvas.dispatchEvent(touchEvent('touchend', []));

    expect(host.previewFurnitureMove).toHaveBeenCalledWith('desk-1', 8, 10);
    expect(callbacks.onMoveFurniture).toHaveBeenCalledWith('desk-1', 8, 10);
    expect(sounds.place).toHaveBeenCalledOnce();
  });

  it('rotates furniture on a double tap and emits the existing place sound', () => {
    furniture = { id: 'desk-1', x: 3, y: 4 };
    controller.attach();
    controller.setEditorMode(true);
    controller.setDeleteMode(true);

    canvas.dispatchEvent(touchEvent('touchstart', [{ clientX: 4, clientY: 5 }]));
    canvas.dispatchEvent(touchEvent('touchend', []));
    nowMs = 1_200;
    canvas.dispatchEvent(touchEvent('touchstart', [{ clientX: 4, clientY: 5 }]));
    canvas.dispatchEvent(touchEvent('touchend', []));

    expect(host.rotateFurnitureAt).toHaveBeenCalledWith(4, 5);
    expect(callbacks.onRotateFurniture).toHaveBeenCalledWith('desk-1', 90);
    expect(sounds.place).toHaveBeenCalledOnce();
  });

  it('reinitializes a zero pinch distance and clamps zoom to four', () => {
    controller.attach();
    canvas.dispatchEvent(touchEvent('touchstart', [
      { clientX: 0, clientY: 0 },
      { clientX: 0, clientY: 0 },
    ]));
    canvas.dispatchEvent(touchEvent('touchmove', [
      { clientX: 0, clientY: 0 },
      { clientX: 100, clientY: 0 },
    ]));
    canvas.dispatchEvent(touchEvent('touchmove', [
      { clientX: 0, clientY: 0 },
      { clientX: 500, clientY: 0 },
    ]));

    expect(canvas.style.transform).toBe('scale(4)');
    expect(canvas.style.transformOrigin).toBe('center center');
  });

  it('delegates non-editor taps to the GameEngine host', () => {
    controller.attach();
    canvas.dispatchEvent(touchEvent('touchstart', [{ clientX: 7, clientY: 8 }]));
    canvas.dispatchEvent(touchEvent('touchend', []));

    expect(host.handleTouchGridTap).toHaveBeenCalledWith(7, 8);
  });

  it('cancels an active touch drag without finalizing placement', () => {
    furniture = { id: 'desk-1', x: 3, y: 4 };
    controller.attach();
    controller.setEditorMode(true);

    canvas.dispatchEvent(touchEvent('touchstart', [{ clientX: 5, clientY: 6 }]));
    canvas.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 12 }]));
    canvas.dispatchEvent(touchEvent('touchcancel', []));
    canvas.dispatchEvent(touchEvent('touchend', []));

    expect(host.previewFurnitureMove).toHaveBeenCalled();
    expect(callbacks.onMoveFurniture).not.toHaveBeenCalled();
  });

  it('keeps the exact 300ms interval outside the double-tap window', () => {
    furniture = { id: 'desk-1', x: 3, y: 4 };
    controller.attach();
    controller.setEditorMode(true);
    controller.setDeleteMode(true);

    canvas.dispatchEvent(touchEvent('touchstart', [{ clientX: 4, clientY: 5 }]));
    canvas.dispatchEvent(touchEvent('touchend', []));
    nowMs = 1_300;
    canvas.dispatchEvent(touchEvent('touchstart', [{ clientX: 4, clientY: 5 }]));
    canvas.dispatchEvent(touchEvent('touchend', []));

    expect(host.rotateFurnitureAt).not.toHaveBeenCalled();
    expect(sounds.place).not.toHaveBeenCalled();
  });

  it('preserves non-editor cursor precedence', () => {
    controller.attach();
    vi.mocked(host.hasSelectedAgent).mockReturnValue(true);
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 4, clientY: 5 }));
    expect(canvas.style.cursor).toBe('crosshair');

    vi.mocked(host.hasSelectedAgent).mockReturnValue(false);
    vi.mocked(host.findCharacterAt).mockReturnValue('agent-1');
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 4, clientY: 5 }));
    expect(canvas.style.cursor).toBe('pointer');

    vi.mocked(host.findCharacterAt).mockReturnValue(null);
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 4, clientY: 5 }));
    expect(canvas.style.cursor).toBe('default');
  });

  it('aborts an active mouse drag if mouseleave fires before mouseup', () => {
    furniture = { id: 'desk-1', x: 3, y: 4 };
    controller.attach();
    controller.setEditorMode(true);

    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 5, clientY: 7 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 99, clientY: 99 }));
    canvas.dispatchEvent(new MouseEvent('mouseleave'));

    expect(callbacks.onMoveFurniture).not.toHaveBeenCalled();
    expect(sounds.place).not.toHaveBeenCalled();

    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 99, clientY: 99 }));

    expect(callbacks.onMoveFurniture).not.toHaveBeenCalled();
    expect(sounds.place).not.toHaveBeenCalled();
  });

  it('does not finalize a drag on right-click mouseup', () => {
    furniture = { id: 'desk-1', x: 3, y: 4 };
    controller.attach();
    controller.setEditorMode(true);

    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 5, clientY: 7 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 99, clientY: 99 }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 2, clientX: 99, clientY: 99 }));

    expect(callbacks.onMoveFurniture).not.toHaveBeenCalled();
    expect(sounds.place).not.toHaveBeenCalled();

    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 99, clientY: 99 }));
    expect(callbacks.onMoveFurniture).toHaveBeenCalledWith('desk-1', 21, 13);
    expect(sounds.place).toHaveBeenCalledOnce();
  });

  it('places selected furniture on a single touch tap with no drag', () => {
    controller.attach();
    controller.setEditorMode(true);
    controller.setSelectedFurnitureType('DESK');

    canvas.dispatchEvent(touchEvent('touchstart', [{ clientX: 5, clientY: 6 }]));
    canvas.dispatchEvent(touchEvent('touchend', []));

    expect(callbacks.onPlaceFurniture).toHaveBeenCalledWith('DESK', 5, 6);
    expect(sounds.place).toHaveBeenCalledOnce();
  });
});
