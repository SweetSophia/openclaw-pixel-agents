/**
 * Bounded integration tests for `GameEngine`'s post-#51 adapter seams.
 *
 * Why this file exists (issue #80): the editor/sub-agent/schedule seams were
 * introduced and refactored across PRs #51 and #79. The pure helpers
 * (`tickSubAgent`, `getDayPhase`, `screenToGrid`, `EditorController`) already
 * have dedicated unit suites. This file exercises only the composition with
 * `GameEngine` itself, using real `MouseEvent` dispatch on the live canvas,
 * real `engine.update` / `engine.renderDayNight` invocations, and real
 * `tickSubAgent` / `Schedule.getDayPhase` modules — never mocked.
 *
 * Boundaries stubbed (jsdom + Vitest don't supply these):
 *   • `requestAnimationFrame` / `cancelAnimationFrame` — prevent the engine's
 *     internal frame driver from leaking callbacks after `stop()`.
 *   • `SoundFX` singleton — Web Audio is unavailable under jsdom.
 *   • `HTMLCanvasElement.prototype.getContext('2d')` — return a recording
 *     2D context; the engine reads `this.ctx = canvas.getContext('2d')!` in
 *     its constructor.
 *   • `HTMLCanvasElement.prototype.getBoundingClientRect()` — deterministic
 *     so editor adapter assertions can land on exact grid cells.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GameEngine } from './GameEngine';
import type { GameCallbacks } from './GameEngine';
import type { EditorCallbacks } from './EditorController';
import type { PlacedFurniture } from '../../shared/types';
import {
  SUBAGENT_FADE_DURATION,
  SUBAGENT_LIFETIME,
} from './SubAgentFSM';
import { getDayPhase } from './Schedule';

// Web Audio is unavailable in jsdom; ship no-op spies in place of the singleton.
vi.mock('../audio/SoundFX', () => ({
  sfx: {
    click: vi.fn(),
    place: vi.fn(),
    pickup: vi.fn(),
    typing: vi.fn(),
    typingBatch: vi.fn(),
    notify: vi.fn(),
    error: vi.fn(),
    spawn: vi.fn(),
    despawn: vi.fn(),
    footstep: vi.fn(),
    movement: vi.fn(),
  },
}));

// ── Types ───────────────────────────────────────────────────────────────────

type RecordingContext = {
  fills: Array<{ style: string; x: number; y: number; w: number; h: number }>;
  texts: Array<{ text: string; x: number; y: number }>;
  ctx: CanvasRenderingContext2D;
};

// Narrow access bridge — declared as a standalone structural type (NOT an
// intersection with `GameEngine`) so TS does NOT collapse it to `never` over
// the private `characters` / `placedFurniture` fields. Runtime reads/writes
// proceed normally because TS `private` is a compile-time annotation only.
type SubAgentCharacter = {
  id: string;
  fadeAlpha: number;
  dying: boolean;
  spawnTime: number;
  isSubAgent?: boolean;
  [k: string]: unknown;
};

type TestGameEngine = {
  characters: Map<string, SubAgentCharacter>;
  placedFurniture: PlacedFurniture[];
  nowMs: number;
  dayPhase: number;
  _currentPhase: ReturnType<typeof getDayPhase>;
  update(dt: number): void;
  renderDayNight(tileSize: number): void;
  addCharacter(data: {
    id: string;
    name: string;
    x: number;
    y: number;
    state: string;
    lastMessage?: string;
  }): void;
  setEditorMode(enabled: boolean): void;
  setSelectedFurnitureType(type: string | null): void;
  setSelectedFurnitureId(id: string | null): void;
  setEditorCallbacks(cb: EditorCallbacks): void;
  setGameCallbacks(cb: GameCallbacks): void;
  setLayout(furniture: PlacedFurniture[]): void;
  getPlacedFurniture(): PlacedFurniture[];
  spawnSubAgent(parentId: string, subId: string, subName: string): void;
  isCharacterDying(id: string): boolean;
  stop(): void;
};

// ── Recording 2D context + canvas harness ────────────────────────────────────

function makeRecordingContext(): RecordingContext {
  const fills: RecordingContext['fills'] = [];
  const texts: RecordingContext['texts'] = [];
  const stub = {
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ style: stub.fillStyle, x, y, w, h });
    },
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y });
    },
    clearRect() {},
    drawImage() {},
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    quadraticCurveTo() {},
    translate() {},
    rotate() {},
    scale() {},
    setLineDash() {},
    stroke() {},
    strokeRect() {},
    measureText(text: string) {
      return { width: text.length * 6 };
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
    get globalAlpha() { return stub._alpha; },
    set globalAlpha(v: number) { stub._alpha = v; },
    _alpha: 1,
    fillStyle: '',
    font: '',
    strokeStyle: '',
    imageSmoothingEnabled: false,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineWidth: 1,
    lineDashOffset: 0,
    shadowBlur: 0,
    shadowColor: '',
  };
  return {
    fills,
    texts,
    ctx: stub as unknown as CanvasRenderingContext2D,
  };
}

const GRID = { tileSize: 16, gridWidth: 24, gridHeight: 16 };

function makeCanvasWithStubbedContext(): {
  canvas: HTMLCanvasElement;
  recorded: RecordingContext;
} {
  const canvas = document.createElement('canvas');
  const recorded = makeRecordingContext();

  // The engine constructor calls `canvas.getContext('2d')!` immediately, so
  // install the recording 2D context BEFORE constructing it.
  vi.spyOn(canvas, 'getContext').mockReturnValue(recorded.ctx);

  // Deterministic CSS rect equal to the internal canvas size — keeps the
  // ratio identical so letterbox math is trivial and grid cells map exactly.
  const w = GRID.gridWidth * GRID.tileSize;
  const h = GRID.gridHeight * GRID.tileSize;
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: w,
    height: h,
    x: 0,
    y: 0,
    right: w,
    bottom: h,
    toJSON() { return {}; },
  } as DOMRect);

  return { canvas, recorded };
}

function clientCenterOf(gridX: number, gridY: number): { x: number; y: number } {
  return {
    x: (gridX + 0.5) * GRID.tileSize,
    y: (gridY + 0.5) * GRID.tileSize,
  };
}

// ── Editor adapter describe ──────────────────────────────────────────────────

describe('GameEngine integration: editor adapters', () => {
  let engine: TestGameEngine;
  let canvas: HTMLCanvasElement;
  let recorded: RecordingContext;
  let editorCallbacks: EditorCallbacks;
  let gameCallbacks: GameCallbacks;

  beforeEach(() => {
    const made = makeCanvasWithStubbedContext();
    canvas = made.canvas;
    recorded = made.recorded;
    editorCallbacks = {
      onPlaceFurniture: vi.fn(),
      onSelectFurniture: vi.fn(),
      onMoveFurniture: vi.fn(),
    };
    gameCallbacks = { onCharacterClick: vi.fn() };

    engine = new GameEngine(canvas, GRID) as unknown as TestGameEngine;
    engine.setEditorCallbacks(editorCallbacks);
    engine.setGameCallbacks(gameCallbacks);
  });

  afterEach(() => {
    engine.stop();
    vi.restoreAllMocks();
  });

  it('routes numeric screenToGrid + editor placement through the host closure', () => {
    engine.setEditorMode(true);
    engine.setSelectedFurnitureType('DESK');

    const target = clientCenterOf(4, 5);
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: target.x, clientY: target.y }),
    );

    expect(editorCallbacks.onPlaceFurniture).toHaveBeenCalledWith('DESK', 4, 5);
  });

  it('routes MouseEvent screenToGrid via canvas click into gameCallbacks.onCharacterClick', () => {
    engine.addCharacter({
      id: 'test-agent',
      name: 'Tester',
      x: 6,
      y: 4,
      state: 'idle',
    });

    const target = clientCenterOf(6, 4);
    canvas.dispatchEvent(
      new MouseEvent('click', { clientX: target.x, clientY: target.y }),
    );

    expect(gameCallbacks.onCharacterClick).toHaveBeenCalledWith('test-agent');
  });

  it('drags, places, and rotates furniture through the full host adapter closure', () => {
    engine.setLayout([{ id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 0 }]);
    engine.setEditorMode(true);

    const start = clientCenterOf(3, 4);
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: start.x, clientY: start.y }),
    );
    expect(editorCallbacks.onSelectFurniture).toHaveBeenLastCalledWith('desk-1');

    const moved = clientCenterOf(8, 9);
    canvas.dispatchEvent(
      new MouseEvent('mousemove', { clientX: moved.x, clientY: moved.y }),
    );
    // previewFurnitureMove mutates the placed-furniture list in place before
    // the React layer finalises the move through the `onMoveFurniture` callback.
    expect(engine.getPlacedFurniture()[0]).toMatchObject({
      id: 'desk-1',
      x: 8,
      y: 9,
    });
    expect(editorCallbacks.onMoveFurniture).not.toHaveBeenCalled();

    canvas.dispatchEvent(
      new MouseEvent('mouseup', { button: 0, clientX: moved.x, clientY: moved.y }),
    );
    expect(editorCallbacks.onMoveFurniture).toHaveBeenCalledWith('desk-1', 8, 9);

    canvas.dispatchEvent(
      new MouseEvent('contextmenu', {
        clientX: moved.x,
        clientY: moved.y,
        cancelable: true,
        bubbles: true,
      }),
    );
    expect(engine.getPlacedFurniture()[0].rotation).toBe(90);
  });
});

// ── Sub-agent lifecycle describe ─────────────────────────────────────────────

describe('GameEngine integration: sub-agent lifecycle', () => {
  let engine: TestGameEngine;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    const made = makeCanvasWithStubbedContext();
    canvas = made.canvas;
    engine = new GameEngine(canvas, GRID) as unknown as TestGameEngine;
    engine.addCharacter({ id: 'parent', name: 'Parent', x: 5, y: 5, state: 'idle' });
  });

  afterEach(() => {
    engine.stop();
    vi.restoreAllMocks();
  });

  it('applies the tickSubAgent plan: transition sound, monotonic fade, removal', async () => {
    const { sfx } = await import('../audio/SoundFX');
    const despawnSpy = (sfx as unknown as { despawn: ReturnType<typeof vi.fn> }).despawn;

    // Pin `nowMs` so the sub-agent spawn time is known deterministically.
    engine.nowMs = 1_000;
    engine.spawnSubAgent('parent', 'sub-1', 'SubOne');
    expect(engine.characters.has('sub-1')).toBe(true);
    expect(engine.isCharacterDying('sub-1')).toBe(false);

    // Frame that crosses SUBAGENT_LIFETIME: should fire exactly one despawn-sound
    // and apply the first fade decrement.
    engine.nowMs = 1_000 + SUBAGENT_LIFETIME + 50;
    engine.update(0.05);

    expect(engine.isCharacterDying('sub-1')).toBe(true);
    expect(despawnSpy).toHaveBeenCalledTimes(1);
    const fadeAfterFirstDyingTick = engine.characters.get('sub-1')!.fadeAlpha;
    expect(fadeAfterFirstDyingTick).toBeLessThan(1);

    // Subsequent dying ticks decay fade monotonically and MUST NOT re-emit the sound.
    const fadeStepMs = 100;
    const fadeDecayPerStep = fadeStepMs / SUBAGENT_FADE_DURATION;
    engine.nowMs += fadeStepMs;
    engine.update(fadeStepMs / 1000);
    expect(despawnSpy).toHaveBeenCalledTimes(1);
    expect(engine.characters.get('sub-1')!.fadeAlpha).toBeLessThan(fadeAfterFirstDyingTick);

    // Exhaust the fade window; engine must drop the character from its map.
    for (let i = 0; i < 30; i++) {
      if (!engine.characters.has('sub-1')) break;
      engine.nowMs += fadeStepMs;
      engine.update(fadeStepMs / 1000);
    }

    expect(engine.characters.has('sub-1')).toBe(false);
    expect(despawnSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Schedule progression describe ────────────────────────────────────────────

describe('GameEngine integration: schedule progression and overlay render', () => {
  let engine: TestGameEngine;
  let canvas: HTMLCanvasElement;
  let recorded: RecordingContext;

  beforeEach(() => {
    const made = makeCanvasWithStubbedContext();
    canvas = made.canvas;
    recorded = made.recorded;
    engine = new GameEngine(canvas, GRID) as unknown as TestGameEngine;
  });

  afterEach(() => {
    engine.stop();
    vi.restoreAllMocks();
  });

  it('wraps dayPhase modulo 1 and feeds the recomputed phase into renderDayNight', () => {
    // 0.99 + 0.1 cycle (= 12s of the 120s cycle) → wrap to ~0.09.
    engine.dayPhase = 0.99;
    const phaseBefore = getDayPhase(0.99).overlay;

    engine.update(12);
    expect(engine.dayPhase).toBeCloseTo(0.09, 5);

    // Internal _currentPhase must track the same interpolated values as the
    // pure Schedule module (no parallel/duplicated logic).
    expect(engine._currentPhase.label).toBe(getDayPhase(engine.dayPhase).label);
    expect(engine._currentPhase.overlay).toBe(getDayPhase(engine.dayPhase).overlay);

    // renderDayNight uses the FIRST fillRect to paint the day/night overlay
    // across the whole grid; its fillStyle must equal the recomputed overlay.
    recorded.fills.length = 0;
    engine.renderDayNight(GRID.tileSize);

    const w = GRID.gridWidth * GRID.tileSize;
    const h = GRID.gridHeight * GRID.tileSize;
    const fullOverlayFill = recorded.fills.find(
      (f) => f.x === 0 && f.y === 0 && f.w === w && f.h === h,
    );
    expect(fullOverlayFill?.style).toBe(getDayPhase(engine.dayPhase).overlay);
    expect(fullOverlayFill?.style).not.toBe(phaseBefore);
  });
});
