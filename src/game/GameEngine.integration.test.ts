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
import { SUBAGENT_FADE_DURATION } from './SubAgentFSM';
import { getDayPhase } from './Schedule';
import type { Point } from './Pathfinder';
import type { ReadonlyLoadedCharacter } from './SpriteLoader';
import { sfx } from '../audio/SoundFX';

// Web Audio is unavailable in jsdom; replace the singleton with no-op spies
// that cover exactly the methods the production engine calls.
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
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  path: Point[];
  pathIndex: number;
  fadeAlpha: number;
  dying: boolean;
  spawnTime: number;
  isSubAgent?: boolean;
  [k: string]: unknown;
};

type TestGameEngine = {
  characters_sprites: readonly ReadonlyLoadedCharacter[];
  characters: Map<string, SubAgentCharacter>;
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
  updateCharacter(id: string, updates: Partial<{
    state: string;
  }>): void;
  setEditorMode(enabled: boolean): void;
  setSelectedFurnitureType(type: string | null): void;
  setSelectedFurnitureId(id: string | null): void;
  setEditorCallbacks(cb: EditorCallbacks): void;
  setGameCallbacks(cb: GameCallbacks): void;
  setLayout(furniture: PlacedFurniture[], seats?: Record<string, { x: number; y: number }>): void;
  getPlacedFurniture(): PlacedFurniture[];
  spawnSubAgent(parentId: string, subId: string, subName: string): void;
  killSubAgent(subId: string): void;
  reviveSubAgent(subId: string): void;
  isCharacterDying(id: string): boolean;
  setCharacterSprite(agentId: string, sprite: ReadonlyLoadedCharacter): void;
  start(): void;
  stop(): void;
};

// ── Recording 2D context + canvas harness ────────────────────────────────────

function makeRecordingContext(onDrawImage: (...args: unknown[]) => void = () => {}): RecordingContext {
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
    drawImage(...args: unknown[]) { onDrawImage(...args); },
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
    fill() {},
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

function makeCanvasWithStubbedContext(
  onDrawImage?: (...args: unknown[]) => void,
): {
  canvas: HTMLCanvasElement;
  recorded: RecordingContext;
} {
  const canvas = document.createElement('canvas');
  const recorded = makeRecordingContext(onDrawImage);

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

function makeCharacterSprite(canvas: HTMLCanvasElement): ReadonlyLoadedCharacter {
  const frames = Array.from({ length: 7 }, () => ({ canvas, width: 16, height: 32 }));
  return { down: frames, up: frames, right: frames, left: frames };
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
      onRotateFurniture: vi.fn(),
    };
    gameCallbacks = { onCharacterClick: vi.fn() };

    engine = new GameEngine(canvas, GRID) as unknown as TestGameEngine;
    engine.setEditorCallbacks(editorCallbacks);
    engine.setGameCallbacks(gameCallbacks);
  });

  afterEach(() => {
    engine.stop();
    vi.restoreAllMocks();
    vi.clearAllMocks();
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

  it('keeps caller layout immutable while dragging and rotating through the host closure', () => {
    const callerFurniture: PlacedFurniture[] = [
      { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 0 },
    ];
    Object.freeze(callerFurniture[0]);
    Object.freeze(callerFurniture);
    engine.setLayout(callerFurniture);
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
    expect(callerFurniture[0]).toEqual({
      id: 'desk-1',
      type: 'DESK',
      x: 3,
      y: 4,
      rotation: 0,
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
    expect(callerFurniture[0].rotation).toBe(0);
    expect(editorCallbacks.onRotateFurniture).toHaveBeenCalledWith('desk-1', 90);
  });
});

describe('GameEngine integration: obstacle-aware movement', () => {
  let engine: TestGameEngine;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    const made = makeCanvasWithStubbedContext();
    canvas = made.canvas;
    engine = new GameEngine(canvas, GRID) as unknown as TestGameEngine;
  });

  afterEach(() => {
    engine.stop();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const clickGrid = (gridX: number, gridY: number) => {
    const target = clientCenterOf(gridX, gridY);
    canvas.dispatchEvent(new MouseEvent('click', { clientX: target.x, clientY: target.y }));
  };

  it('routes around the rendered footprint of rotated fallback furniture', () => {
    // Missing furniture sprites intentionally use the conservative 2x1
    // footprint. At 90 degrees that occupies (4,3) and (4,4), not (5,3).
    engine.setLayout([
      { id: 'rotated-fallback', type: 'MISSING_SPRITE', x: 4, y: 3, rotation: 90 },
    ]);
    engine.addCharacter({ id: 'walker', name: 'Walker', x: 2, y: 4, state: 'idle' });

    clickGrid(2, 4);
    clickGrid(6, 4);

    const character = engine.characters.get('walker')!;
    const rotatedObstacleTiles = new Set(['4,3', '4,4']);
    expect(character.path.every(({ x, y }) => !rotatedObstacleTiles.has(`${x},${y}`)))
      .toBe(true);

    for (let step = 0; step < 100; step++) {
      engine.update(0.1);
      expect(rotatedObstacleTiles.has(`${Math.round(character.x)},${Math.round(character.y)}`))
        .toBe(false);
      if (Math.abs(character.x - 6) < 0.05 && Math.abs(character.y - 4) < 0.05) break;
    }
    expect(character.x).toBeCloseTo(6, 1);
    expect(character.y).toBeCloseTo(4, 1);
  });

  it('stops at the expanded-ring destination instead of entering blocked furniture', () => {
    const boxedTarget: PlacedFurniture[] = [5, 6, 7].flatMap(y => [5, 7].map(x => ({
      id: `box-${x}-${y}`,
      type: 'MISSING_SPRITE',
      x,
      y,
      rotation: 0,
    })));
    engine.setLayout(boxedTarget, { walker: { x: 6, y: 6 } });
    engine.addCharacter({ id: 'walker', name: 'Walker', x: 2, y: 6, state: 'idle' });

    engine.updateCharacter('walker', { state: 'typing' });

    const character = engine.characters.get('walker')!;
    expect(character.path[character.path.length - 1]).toEqual({ x: 4, y: 6 });
    expect({ x: character.targetX, y: character.targetY }).toEqual({ x: 4, y: 6 });

    const obstacleTiles = new Set(
      boxedTarget.flatMap(({ x, y }) => [`${x},${y}`, `${x + 1},${y}`]),
    );
    for (let step = 0; step < 100; step++) {
      engine.update(0.1);
      expect(obstacleTiles.has(`${Math.round(character.x)},${Math.round(character.y)}`))
        .toBe(false);
    }
    expect(character.x).toBeCloseTo(4, 1);
    expect(character.y).toBeCloseTo(6, 1);
  });

  it('does not use straight-line movement when no path exists through a solid wall', () => {
    const wall: PlacedFurniture[] = Array.from({ length: 14 }, (_, index) => ({
      id: `wall-${index + 1}`,
      type: 'MISSING_SPRITE',
      x: 12,
      y: index + 1,
      rotation: 0,
    }));
    engine.setLayout(wall);
    engine.addCharacter({ id: 'walker', name: 'Walker', x: 4, y: 8, state: 'idle' });

    clickGrid(4, 8);
    clickGrid(18, 8);

    const character = engine.characters.get('walker')!;
    for (let step = 0; step < 100; step++) {
      engine.update(0.1);
      expect(character.x).toBeLessThan(12);
    }

    expect(character.x).toBeCloseTo(4, 5);
    expect(character.y).toBeCloseTo(8, 5);
  });

  it('closes a safe sub-tile gap when BFS needs no waypoints', () => {
    engine.setLayout([], { walker: { x: 2, y: 4 } });
    engine.addCharacter({ id: 'walker', name: 'Walker', x: 2.4, y: 4, state: 'idle' });

    engine.updateCharacter('walker', { state: 'typing' });

    const character = engine.characters.get('walker')!;
    expect(character.path).toEqual([]);
    for (let step = 0; step < 10; step++) engine.update(0.1);

    expect(character.x).toBeCloseTo(2, 5);
    expect(character.y).toBeCloseTo(4, 5);
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
    vi.clearAllMocks();
  });

  /** Advance `seconds` of simulated time in 100ms update steps. */
  const advance = (seconds: number) => {
    const stepMs = 100;
    const steps = Math.ceil((seconds * 1000) / stepMs);
    for (let i = 0; i < steps; i++) {
      engine.nowMs += stepMs;
      engine.update(stepMs / 1000);
    }
  };

  /** Drain a dying sub-agent's fade-out to removal.
   *  Bounded on the FSM constant (not a magic iteration count), so the loop
   *  stays correct — and terminates — if SUBAGENT_FADE_DURATION changes. */
  const fadeOutCompletely = (subId: string) => {
    const fadeSteps = Math.ceil(SUBAGENT_FADE_DURATION / 100) + 1;
    for (let i = 0; i < fadeSteps; i++) {
      if (!engine.characters.has(subId)) break;
      engine.nowMs += 100;
      engine.update(0.1);
    }
  };

  it('keeps a running sub-agent alive and stable through 60 simulated seconds (issue #102)', () => {
    const spawnSpy = vi.mocked(sfx.spawn);
    const despawnSpy = vi.mocked(sfx.despawn);

    engine.nowMs = 1_000;
    engine.spawnSubAgent('parent', 'sub-1', 'SubOne');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const identity = engine.characters.get('sub-1');

    // 60 simulated seconds — 4x the removed 15s presentation lifetime.
    advance(60);

    // Stable identity, no fade, no despawn: server status still `running`.
    expect(engine.characters.get('sub-1')).toBe(identity);
    expect(engine.isCharacterDying('sub-1')).toBe(false);
    expect(engine.characters.get('sub-1')!.fadeAlpha).toBe(1);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(despawnSpy).not.toHaveBeenCalled();
  });

  it('killSubAgent: exactly one despawn sound, monotonic fade, removal', () => {
    const despawnSpy = vi.mocked(sfx.despawn);

    engine.nowMs = 1_000;
    engine.spawnSubAgent('parent', 'sub-1', 'SubOne');
    expect(engine.isCharacterDying('sub-1')).toBe(false);

    // Completion reconciliation kills the sub-agent: one sound, fade starts.
    engine.killSubAgent('sub-1');
    expect(despawnSpy).toHaveBeenCalledTimes(1);
    expect(engine.isCharacterDying('sub-1')).toBe(true);

    // Repeated kills are idempotent — the sound must not replay.
    engine.killSubAgent('sub-1');
    expect(despawnSpy).toHaveBeenCalledTimes(1);

    engine.update(0.05);
    const fadeAfterFirstTick = engine.characters.get('sub-1')!.fadeAlpha;
    expect(fadeAfterFirstTick).toBeLessThan(1);
    expect(despawnSpy).toHaveBeenCalledTimes(1);

    // Fade decays monotonically and MUST NOT re-emit the sound.
    engine.nowMs += 100;
    engine.update(0.1);
    expect(engine.characters.get('sub-1')!.fadeAlpha).toBeLessThan(fadeAfterFirstTick);
    expect(despawnSpy).toHaveBeenCalledTimes(1);

    // Exhaust the fade window.
    fadeOutCompletely('sub-1');

    expect(engine.characters.has('sub-1')).toBe(false);
    expect(despawnSpy).toHaveBeenCalledTimes(1);
  });

  it('reviveSubAgent cancels a mid-fade kill without replaying any sound (issue #102)', () => {
    const spawnSpy = vi.mocked(sfx.spawn);
    const despawnSpy = vi.mocked(sfx.despawn);

    engine.nowMs = 1_000;
    engine.spawnSubAgent('parent', 'sub-1', 'SubOne');
    engine.killSubAgent('sub-1');
    engine.update(0.5);
    expect(engine.isCharacterDying('sub-1')).toBe(true);
    expect(engine.characters.get('sub-1')!.fadeAlpha).toBeLessThan(1);
    expect(despawnSpy).toHaveBeenCalledTimes(1);

    // Server status flips back to `running` mid-fade: revive in place.
    engine.reviveSubAgent('sub-1');
    expect(engine.isCharacterDying('sub-1')).toBe(false);
    expect(engine.characters.get('sub-1')!.fadeAlpha).toBe(1);

    // Still alive and stable long past the former presentation lifetime,
    // with no replayed spawn or despawn sound.
    advance(60);
    expect(engine.characters.has('sub-1')).toBe(true);
    expect(engine.isCharacterDying('sub-1')).toBe(false);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(despawnSpy).toHaveBeenCalledTimes(1);
  });

  it('plays the spawn sound again only for a genuinely new appearance after removal', () => {
    const spawnSpy = vi.mocked(sfx.spawn);

    engine.nowMs = 1_000;
    engine.spawnSubAgent('parent', 'sub-1', 'SubOne');
    engine.killSubAgent('sub-1');

    fadeOutCompletely('sub-1');
    expect(engine.characters.has('sub-1')).toBe(false);
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    // The sub-agent fully faded out, so a later `running` reconciliation is
    // a genuinely new visual appearance — the spawn sound is justified.
    engine.spawnSubAgent('parent', 'sub-1', 'SubOne');
    expect(spawnSpy).toHaveBeenCalledTimes(2);
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
    vi.clearAllMocks();
  });

  it('wraps dayPhase modulo 1 and feeds the recomputed phase into renderDayNight', () => {
    // Drive the schedule through the same `dt` clamp production uses in `loop()`
    // (Math.min(rawDt, 0.1)). A single `update(12)` would only prove the modulo
    // arithmetic and let a future `if (dt < 1) skip` gate regress in silence.
    engine.dayPhase = 0.99;
    const phaseBefore = getDayPhase(0.99).overlay;

    // 120 × 0.1s ticks = 12s of in-game time. dayPhase: 0.99 → 0.99 + 0.1 = 1.09 → 0.09.
    for (let i = 0; i < 120; i++) engine.update(0.1);
    expect(engine.dayPhase).toBeCloseTo(0.09, 5);

    // Internal _currentPhase must track the same interpolated values as the
    // pure Schedule module (no parallel/duplicated logic). Cache the expected
    // phase once for symmetry across label / overlay / light (Sourcery).
    const expected = getDayPhase(engine.dayPhase);
    expect(engine._currentPhase.label).toBe(expected.label);
    expect(engine._currentPhase.overlay).toBe(expected.overlay);
    expect(engine._currentPhase.light).toBeCloseTo(expected.light, 5);

    // renderDayNight uses the FIRST fillRect to paint the day/night overlay
    // across the whole grid; its fillStyle must equal the recomputed overlay.
    recorded.fills.length = 0;
    engine.renderDayNight(GRID.tileSize);

    const w = GRID.gridWidth * GRID.tileSize;
    const h = GRID.gridHeight * GRID.tileSize;
    const fullOverlayFill = recorded.fills.find(
      (f) => f.x === 0 && f.y === 0 && f.w === w && f.h === h,
    );
    expect(fullOverlayFill?.style).toBe(expected.overlay);
    expect(fullOverlayFill?.style).not.toBe(phaseBefore);
  });
});

describe('GameEngine integration: render fault tolerance (issue #172)', () => {
  let engine: TestGameEngine | null;
  let pendingFrames: FrameRequestCallback[];

  beforeEach(() => {
    engine = null;
    pendingFrames = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    engine?.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the placeholder instead of drawing a zero-size override canvas', () => {
    const drawnSources: unknown[] = [];
    const made = makeCanvasWithStubbedContext((source) => {
      if (source instanceof HTMLCanvasElement && (source.width === 0 || source.height === 0)) {
        throw new DOMException('Canvas has no image data', 'InvalidStateError');
      }
      drawnSources.push(source);
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(made.recorded.ctx);
    const frameErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    engine = new GameEngine(made.canvas, GRID) as unknown as TestGameEngine;

    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = 16;
    baseCanvas.height = 32;
    const zeroSizeCanvas = document.createElement('canvas');
    zeroSizeCanvas.width = 0;
    zeroSizeCanvas.height = 0;
    engine.characters_sprites = [makeCharacterSprite(baseCanvas)];
    engine.setCharacterSprite('cybera', makeCharacterSprite(zeroSizeCanvas));
    engine.addCharacter({ id: 'cybera', name: 'Cybera', x: 2, y: 2, state: 'idle' });

    expect(() => engine!.start()).not.toThrow();
    expect(drawnSources).not.toContain(zeroSizeCanvas);
    expect(made.recorded.fills.some(fill => fill.style === '#e94560')).toBe(true);
    expect(frameErrorSpy).not.toHaveBeenCalled();
  });

  it('reschedules before a render error so a subsequent good frame still renders', () => {
    const badCanvas = document.createElement('canvas');
    badCanvas.width = 16;
    badCanvas.height = 32;
    const goodCanvas = document.createElement('canvas');
    goodCanvas.width = 16;
    goodCanvas.height = 32;
    const frameFailure = new DOMException('Bad sprite frame', 'InvalidStateError');
    const drawnSources: unknown[] = [];
    const made = makeCanvasWithStubbedContext((source) => {
      drawnSources.push(source);
      if (source === badCanvas) throw frameFailure;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(made.recorded.ctx);
    const frameErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    engine = new GameEngine(made.canvas, GRID) as unknown as TestGameEngine;
    engine.characters_sprites = [makeCharacterSprite(goodCanvas)];
    engine.setCharacterSprite('cybera', makeCharacterSprite(badCanvas));
    engine.addCharacter({ id: 'cybera', name: 'Cybera', x: 2, y: 2, state: 'idle' });

    engine.start();
    expect(frameErrorSpy).toHaveBeenCalledWith('[GameEngine] render error', frameFailure);
    expect(pendingFrames).toHaveLength(1);

    engine.setCharacterSprite('cybera', makeCharacterSprite(goodCanvas));
    const nextFrame = pendingFrames.shift();
    expect(nextFrame).toBeDefined();
    nextFrame!(performance.now());

    expect(drawnSources).toContain(goodCanvas);
    expect(pendingFrames).toHaveLength(1);
  });

  it('skips the render but keeps the loop alive when update throws, then recovers', () => {
    const made = makeCanvasWithStubbedContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(made.recorded.ctx);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    engine = new GameEngine(made.canvas, GRID) as unknown as TestGameEngine;
    engine.addCharacter({ id: 'cybera', name: 'Cybera', x: 2, y: 2, state: 'idle' });

    const updateFailure = new Error('bad state');
    const realUpdate = engine.update.bind(engine);
    let shouldThrow = true;
    engine.update = ((dt: number) => {
      if (shouldThrow) { throw updateFailure; }
      realUpdate(dt);
    }) as typeof engine.update;

    engine.start();
    expect(errorSpy).toHaveBeenCalledWith('[GameEngine] update error', updateFailure);
    expect(pendingFrames).toHaveLength(1); // loop rescheduled despite the update failure
    // Render skipped for the failed frame: partial update state never drawn.
    expect(made.recorded.fills.length).toBe(0);

    // Recovery: state fixed, next frame updates and renders normally.
    shouldThrow = false;
    const nextFrame = pendingFrames.shift();
    expect(nextFrame).toBeDefined();
    nextFrame!(performance.now());
    expect(made.recorded.fills.length).toBeGreaterThan(0);
    expect(pendingFrames).toHaveLength(1);
  });
});
