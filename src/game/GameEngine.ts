/**
 * PixelOffice Game Engine
 *
 * Canvas-based rendering engine for the pixel office.
 * Handles tile rendering, character sprites, animation, BFS pathfinding,
 * speech bubbles, sub-agent spawning, and editor-mode furniture placement.
 */

import {
  loadAllAssets,
  loadCharacters,
  getSpriteFrame,
  getCachedCharacters,
  getCachedFurniture,
  type LoadedCharacter,
  type LoadedFloor,
  type LoadedFurnitureItem,
  type AnimState,
  type Direction,
} from './SpriteLoader';
import { buildObstacleMap, bfsPathfind, type Point } from './Pathfinder';
import { sfx } from '../audio/SoundFX';
import type { PlacedFurniture } from '../../shared/types';

export interface GameConfig {
  tileSize: number;
  gridWidth: number;
  gridHeight: number;
}

export interface CharacterData {
  id: string;
  name: string;
  x: number;
  y: number;
  state: string;
  model?: string;
  spriteId?: string;
  lastMessage?: string;
  isSubAgent?: boolean;
  parentAgentId?: string;
}

interface Character extends CharacterData {
  targetX: number;
  targetY: number;
  animFrame: number;
  animTimer: number;
  direction: Direction;
  paletteIndex: number;
  // Pathfinding
  path: Point[];
  pathIndex: number;
  // Sub-agent lifecycle
  spawnTime: number;
  fadeAlpha: number;
  dying: boolean;
  // Audio state
  lastFootstepTile: number; // tile index of last footstep sound
  typingSoundTimer: number; // cooldown for typing sounds
  stateJustChanged: boolean; // true for one frame after state change
}

export interface EditorCallbacks {
  onPlaceFurniture: (type: string, gridX: number, gridY: number) => void;
  onSelectFurniture: (id: string | null) => void;
  onMoveFurniture: (id: string, gridX: number, gridY: number) => void;
}

export interface GameCallbacks {
  onCharacterClick: (agentId: string) => void;
}

const AGENT_PALETTES: Record<string, number> = {
  cybera: 0, shodan: 1, cyberlogis: 2, descartes: 3,
  chi: 4, cylena: 5, sysauxilia: 3, miku: 0,
};

const SUBAGENT_LIFETIME = 15000; // ms before sub-agents fade out
const SUBAGENT_FADE_DURATION = 2000; // fade animation length

// ── State Transition Visual Effects ────────────────────

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  color: string;
  size: number;
}

interface StateEffect {
  agentId: string;
  state: string;
  startTime: number;
  particles: Particle[];
  duration: number; // ms
}

// Per-state visual config
const STATE_VFX: Record<string, {
  color: string;
  icon?: string;
  particleCount: number;
  particleSpeed: number;
  glowColor: string;
  glowDuration: number; // ms
}> = {
  idle: { color: '#6688aa', particleCount: 0, particleSpeed: 0, glowColor: 'transparent', glowDuration: 0 },
  thinking: { color: '#a78bfa', icon: '💭', particleCount: 6, particleSpeed: 25, glowColor: 'rgba(167,139,250,0.15)', glowDuration: 800 },
  typing: { color: '#4ecca3', icon: '⌨', particleCount: 4, particleSpeed: 15, glowColor: 'rgba(78,204,163,0.12)', glowDuration: 500 },
  running_command: { color: '#fbbf24', icon: '⚡', particleCount: 5, particleSpeed: 30, glowColor: 'rgba(251,191,36,0.15)', glowDuration: 600 },
  waiting_input: { color: '#60a5fa', icon: '💬', particleCount: 8, particleSpeed: 20, glowColor: 'rgba(96,165,250,0.15)', glowDuration: 1000 },
  sleeping: { color: '#94a3b8', icon: '💤', particleCount: 0, particleSpeed: 0, glowColor: 'transparent', glowDuration: 0 },
  error: { color: '#ef4444', icon: '❌', particleCount: 10, particleSpeed: 40, glowColor: 'rgba(239,68,68,0.2)', glowDuration: 800 },
  reading: { color: '#34d399', icon: '📖', particleCount: 3, particleSpeed: 10, glowColor: 'rgba(52,211,153,0.1)', glowDuration: 400 },
};

// ── Day/Night Cycle ────────────────────────────────────

interface DayPhase {
  /** RGBA overlay color */
  overlay: string;
  /** Ambient light intensity 0-1 */
  light: number;
  /** Label */
  label: string;
}

interface ParsedDayPhase {
  r: number; g: number; b: number; a: number;
  light: number;
  label: string;
}

function parseRgbaStatic(s: string): [number, number, number, number] {
  const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (!m) return [0, 0, 0, 0];
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), m[4] !== undefined ? parseFloat(m[4]) : 1];
}

const DAY_PHASES: DayPhase[] = [
  { overlay: 'rgba(255, 200, 100, 0.06)', light: 0.95, label: 'Morning' },
  { overlay: 'rgba(255, 255, 240, 0.02)', light: 1.0, label: 'Midday' },
  { overlay: 'rgba(255, 160, 60, 0.08)', light: 0.9, label: 'Afternoon' },
  { overlay: 'rgba(255, 100, 30, 0.12)', light: 0.75, label: 'Sunset' },
  { overlay: 'rgba(60, 40, 120, 0.15)', light: 0.55, label: 'Dusk' },
  { overlay: 'rgba(10, 10, 50, 0.25)', light: 0.35, label: 'Night' },
  { overlay: 'rgba(15, 10, 40, 0.3)', light: 0.25, label: 'Late Night' },
];

const PARSED_PHASES: ParsedDayPhase[] = DAY_PHASES.map(p => {
  const [r, g, b, a] = parseRgbaStatic(p.overlay);
  return { r, g, b, a, light: p.light, label: p.label };
});

// ── Ambient Particles ──────────────────────────────────

interface AmbientParticle {
  x: number; y: number;
  vx: number; vy: number;
  size: number;
  alpha: number;
  maxAlpha: number;
  life: number;
  maxLife: number;
  type: 'dust' | 'steam' | 'sparkle';
  drift: number; // sinusoidal drift amplitude
  driftSpeed: number;
  driftPhase: number;
}

const AMBIENT_DUST_COUNT = 15;

// ── Idle Behaviors ─────────────────────────────────────

type IdleAction = 'stretch' | 'lookAround' | 'fidget' | 'sip' | 'none';

interface IdleBehavior {
  current: IdleAction;
  timer: number; // seconds remaining in current action
  phase: number; // animation phase 0-1
}

const IDLE_ACTIONS: IdleAction[] = ['stretch', 'lookAround', 'fidget', 'sip'];
const IDLE_ACTION_DURATION: Record<IdleAction, number> = {
  stretch: 1.2,
  lookAround: 1.5,
  fidget: 0.8,
  sip: 1.0,
  none: 2.0, // pause between actions
};
const IDLE_CHANCE = 0.15; // chance per second of starting an idle action

export class GameEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: GameConfig;
  private characters: Map<string, Character> = new Map();
  private running = false;
  private animFrameId = 0;
  private lastTime = 0;
  private nowMs = 0;
  private floorCacheCanvas: HTMLCanvasElement | null = null;
  private floorCacheCtx: CanvasRenderingContext2D | null = null;
  private floorCacheValid = false;
  private assetsLoaded = false;
  private _renderDiagLogged = false;
  private _furnitureDiagLogged = false;
  private characters_sprites: LoadedCharacter[] = [];
  private characterSpriteOverrides: Map<string, LoadedCharacter> = new Map();
  private floors: LoadedFloor[] = [];
  private furniture: Map<string, LoadedFurnitureItem> = new Map();
  private zoom: number;
  private onAssetsLoaded?: () => void;

  // Layout data
  private placedFurniture: PlacedFurniture[] = [];
  private seats: Map<string, { x: number; y: number }> = new Map();

  // Pathfinding
  private obstacleGrid: boolean[][] | null = null;
  private obstacleDirty = true;
  private _obstacleRebuildScheduled = false;
  private _obstacleRebuildRafId: number | null = null;

  // Editor state
  private editorMode = false;
  private deleteMode = false;
  private selectedFurnitureType: string | null = null;
  private selectedFurnitureId: string | null = null;
  private dragging: { id: string; offsetX: number; offsetY: number } | null = null;
  private editorCallbacks: EditorCallbacks | null = null;
  private gameCallbacks: GameCallbacks | null = null;
  private mouseGridX = -1;
  private mouseGridY = -1;

  // Speech bubbles
  private speechBubbles: Map<string, { text: string; timer: number; alpha: number }> = new Map();
  private stateEffects: StateEffect[] = [];

  // Click-to-move selection
  private selectedAgentId: string | null = null;
  private selectionPulse = 0; // for animated ring

  // Touch state
  private touchStartPos: { x: number; y: number } | null = null;
  private touchCurrentPos: { x: number; y: number } | null = null;
  private lastTapTime = 0;
  private pinchStartDist = 0;
  private pinchStartZoom = 1;
  private cameraZoom = 1; // view-only zoom applied via CSS transform (independent of render zoom)
  private touchDragging: { id: string; offsetX: number; offsetY: number } | null = null;
  private touchMoved = false; // true once finger moves > threshold

  // Day/night cycle
  private dayPhase = 0; // 0-1, loops continuously
  private static readonly DAY_CYCLE_SECONDS = 120; // full cycle duration
  private _currentPhase: DayPhase = {
    overlay: 'rgba(255, 255, 240, 0.02)',
    light: 1.0,
    label: 'Midday',
  };

  // Ambient particles (dust motes, steam)
  private ambientParticles: AmbientParticle[] = [];

  // Idle behaviors
  private idleBehaviors: Map<string, IdleBehavior> = new Map();

  constructor(canvas: HTMLCanvasElement, config: GameConfig, onAssetsLoaded?: () => void) {
    this.canvas = canvas;
    this.config = config;
    this.ctx = canvas.getContext('2d')!;
    this.zoom = config.tileSize / 16;
    this.onAssetsLoaded = onAssetsLoaded;

    canvas.width = config.gridWidth * config.tileSize;
    canvas.height = config.gridHeight * config.tileSize;
    canvas.style.imageRendering = 'pixelated';
    canvas.tabIndex = 0; // enable keyboard focus for Escape key

    this.canvas.addEventListener('mousemove', this.handleMouseMove);
    this.canvas.addEventListener('mousedown', this.handleMouseDown);
    this.canvas.addEventListener('mouseup', this.handleMouseUp);
    this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
    this.canvas.addEventListener('contextmenu', this.handleContextMenu);
    // Character click (non-editor mode)
    this.canvas.addEventListener('click', this.handleClick);
    this.canvas.addEventListener('keydown', this.handleKeyDown);
    // Touch support
    this.canvas.addEventListener('touchstart', this.handleTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this.handleTouchEnd, { passive: false });
    this.canvas.addEventListener('touchcancel', this.handleTouchCancel, { passive: false });
  }

  async init(signal?: AbortSignal, debugDemo: boolean = false) {
    await this.loadAssets(signal);
    this.rebuildObstacles();
    if (debugDemo) {
      this.spawnDemoAgents();
    }
  }

  private spawnDemoAgents() {
    const demoAgents = [
      { id: 'cybera', name: 'Cybera', state: 'typing' },
      { id: 'shodan', name: 'Shodan', state: 'thinking' },
      { id: 'cyberlogis', name: 'Cyberlogis', state: 'reading' },
      { id: 'descartes', name: 'Descartes', state: 'idle' },
      { id: 'chi', name: 'Chi', state: 'waiting_input', lastMessage: 'Need input on the deploy config...' },
      { id: 'cylena', name: 'Cylena', state: 'sleeping' },
      { id: 'sysauxilia', name: 'Sysauxilia', state: 'idle' },
      { id: 'miku', name: 'Miku', state: 'reading' },
    ];

    for (const agent of demoAgents) {
      const seat = this.assignSeat(agent.id);
      this.addCharacter({
        id: agent.id, name: agent.name,
        x: seat.x, y: seat.y + 1,
        state: agent.state, spriteId: undefined,
        lastMessage: agent.lastMessage,
      });
    }
  }

  private async loadAssets(signal?: AbortSignal) {
    try {
      const { characters, floors, furniture } = await loadAllAssets(signal);
      this.characters_sprites = characters;
      this.floors = floors;
      this.furniture = furniture;
      this.assetsLoaded = true;
      this.floorCacheValid = false;
      console.log(`[GameEngine] Assets loaded: ${furniture.size} furniture types, ${characters.length} characters, ${floors.length} floors`);
    } catch (err) {
      console.error('[GameEngine] Asset load failed:', err);
      try {
        this.characters_sprites = await loadCharacters(undefined, signal);
        this.assetsLoaded = true;
        console.warn('[GameEngine] Fell back to characters-only; furniture sprites unavailable');
      } catch { }
    }
  }

  start() {
    this.running = true;
    this.nowMs = performance.now();
    this.lastTime = this.nowMs;
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
    if (this._obstacleRebuildRafId !== null) {
      cancelAnimationFrame(this._obstacleRebuildRafId);
      this._obstacleRebuildRafId = null;
      this._obstacleRebuildScheduled = false;
    }
    this.canvas.removeEventListener('mousemove', this.handleMouseMove);
    this.canvas.removeEventListener('mousedown', this.handleMouseDown);
    this.canvas.removeEventListener('mouseup', this.handleMouseUp);
    this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
    this.canvas.removeEventListener('click', this.handleClick);
    this.canvas.removeEventListener('keydown', this.handleKeyDown);
    this.canvas.removeEventListener('touchstart', this.handleTouchStart);
    this.canvas.removeEventListener('touchmove', this.handleTouchMove);
    this.canvas.removeEventListener('touchend', this.handleTouchEnd);
    this.canvas.removeEventListener('touchcancel', this.handleTouchCancel);
  }

  private loop = () => {
    if (!this.running) return;
    this.nowMs = performance.now();
    const dt = (this.nowMs - this.lastTime) / 1000;
    this.lastTime = this.nowMs;
    this.update(dt);
    this.render();
    this.animFrameId = requestAnimationFrame(this.loop);
  };

  // ── Obstacle map ─────────────────────────────────────

  private rebuildObstacles() {
    const furnitureRects = this.placedFurniture.map(f => {
      const sprite = this.furniture.get(f.type);
      const fw = sprite ? sprite.footprintW : 2;
      const fh = sprite ? sprite.footprintH : 1;
      return { x: f.x, y: f.y, w: fw, h: fh };
    });
    this.obstacleGrid = buildObstacleMap(this.config.gridWidth, this.config.gridHeight, furnitureRects);
    this.obstacleDirty = false;
    this._obstacleRebuildScheduled = false;
  }

  private scheduleObstacleRebuild() {
    if (this._obstacleRebuildScheduled) return;
    this._obstacleRebuildScheduled = true;
    this._obstacleRebuildRafId = requestAnimationFrame(() => {
      this._obstacleRebuildRafId = null;
      if (this.obstacleDirty) {
        this.rebuildObstacles();
      }
    });
  }

  private ensureObstacles() {
    if (this.obstacleDirty || !this.obstacleGrid) this.rebuildObstacles();
  }

  // ── Pathfinding ──────────────────────────────────────

  /** Compute a BFS path from current position to target, around obstacles */
  private computePath(char: Character): Point[] {
    this.ensureObstacles();
    if (!this.obstacleGrid) return [{ x: char.targetX, y: char.targetY }];

    return bfsPathfind(
      this.obstacleGrid,
      { x: Math.round(char.x), y: Math.round(char.y) },
      { x: Math.round(char.targetX), y: Math.round(char.targetY) },
      this.config.gridWidth,
      this.config.gridHeight,
    );
  }

  // ── Update ───────────────────────────────────────────

  private update(dt: number) {
    for (const char of this.characters.values()) {
      // Sub-agent lifecycle
      if (char.isSubAgent) {
        const age = this.nowMs - char.spawnTime;
        if (age > SUBAGENT_LIFETIME && !char.dying) {
          char.dying = true;
          sfx.despawn();
        }
        if (char.dying) {
          char.fadeAlpha = Math.max(0, char.fadeAlpha - dt / (SUBAGENT_FADE_DURATION / 1000));
          if (char.fadeAlpha <= 0) {
            this.characters.delete(char.id);
            continue;
          }
        }
      } else {
        char.fadeAlpha = 1;
      }

      // State-change triggers (sound + visual effects)
      if (char.stateJustChanged) {
        char.stateJustChanged = false;
        if (char.state === 'typing' || char.state === 'running_command') {
          sfx.typingBatch(3);
        } else if (char.state === 'waiting_input') {
          sfx.notify();
        } else if (char.state === 'error') {
          sfx.error();
        }
        // Spawn visual transition effect
        this.spawnStateEffect(char);
      }

      // Periodic typing sounds while typing
      if (char.state === 'typing' || char.state === 'running_command') {
        char.typingSoundTimer -= dt;
        if (char.typingSoundTimer <= 0) {
          sfx.typing();
          char.typingSoundTimer = 0.3 + Math.random() * 0.8; // randomized interval
        }
      }

      // Animation timing
      char.animTimer += dt;
      const isWalking = Math.abs(char.targetX - char.x) > 0.05 || Math.abs(char.targetY - char.y) > 0.05;
      if (char.animTimer >= (isWalking ? 0.15 : 0.25)) {
        char.animTimer = 0;
        char.animFrame++;
      }

      // Movement via pathfinding waypoints
      const dx = char.targetX - char.x;
      const dy = char.targetY - char.y;
      const speed = 3;

      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
        // If we have a path, follow waypoints
        if (char.path.length > 0 && char.pathIndex < char.path.length) {
          const wp = char.path[char.pathIndex];
          const wpDx = wp.x - char.x;
          const wpDy = wp.y - char.y;
          const wpDist = Math.sqrt(wpDx * wpDx + wpDy * wpDy);

          if (wpDist < 0.1) {
            char.pathIndex++;
            // Footstep sound at each waypoint
            const tileIdx = wp.y * this.config.gridWidth + wp.x;
            if (tileIdx !== char.lastFootstepTile) {
              sfx.footstep();
              char.lastFootstepTile = tileIdx;
            }
          } else {
            char.x += (wpDx / wpDist) * Math.min(speed * dt, wpDist);
            char.y += (wpDy / wpDist) * Math.min(speed * dt, wpDist);
            char.direction = Math.abs(wpDx) > Math.abs(wpDy)
              ? (wpDx > 0 ? 'right' : 'left')
              : (wpDy > 0 ? 'down' : 'up');
          }
        } else {
          // Straight line fallback (no path or path complete, still moving)
          char.x += Math.sign(dx) * Math.min(speed * dt, Math.abs(dx));
          char.y += Math.sign(dy) * Math.min(speed * dt, Math.abs(dy));
          char.direction = Math.abs(dx) > Math.abs(dy)
            ? (dx > 0 ? 'right' : 'left')
            : (dy > 0 ? 'down' : 'up');
        }
      } else if (char.path.length > 0) {
        // Arrived — clear path
        char.path = [];
        char.pathIndex = 0;
      }
    }

    // Update speech bubble timers
    for (const [id, bubble] of this.speechBubbles) {
      bubble.timer -= dt;
      if (bubble.timer <= 2) {
        bubble.alpha = Math.max(0, bubble.timer / 2);
      }
      if (bubble.timer <= 0) {
        this.speechBubbles.delete(id);
      }
    }

    // Update state transition effects
    for (const fx of this.stateEffects) {
      const elapsed = this.nowMs - fx.startTime;
      for (const p of fx.particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy -= 15 * dt; // slight upward drift
        p.life -= dt;
      }
      fx.particles = fx.particles.filter(p => p.life > 0);
    }
    this.stateEffects = this.stateEffects.filter(fx =>
      this.nowMs - fx.startTime < fx.duration || fx.particles.length > 0
    );

    // ── Day/night cycle update ──
    this.dayPhase = (this.dayPhase + dt / GameEngine.DAY_CYCLE_SECONDS) % 1;
    this._currentPhase = this.getDayPhase();

    // ── Ambient particles update ──
    this.updateAmbientParticles(dt);

    // ── Idle behaviors update ──
    this.updateIdleBehaviors(dt);
  }

  // ── Day/Night Cycle ──────────────────────────────────

  /** Get interpolated day phase data */
  private getDayPhase(): DayPhase {
    const idx = this.dayPhase * PARSED_PHASES.length;
    const i = Math.floor(idx) % PARSED_PHASES.length;
    const j = (i + 1) % PARSED_PHASES.length;
    const t = idx - Math.floor(idx);

    const a = PARSED_PHASES[i];
    const b = PARSED_PHASES[j];

    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const blue = Math.round(a.b + (b.b - a.b) * t);
    const alpha = +(a.a + (b.a - a.a) * t).toFixed(3);

    return {
      overlay: `rgba(${r}, ${g}, ${blue}, ${alpha})`,
      light: a.light + (b.light - a.light) * t,
      label: t < 0.5 ? a.label : b.label,
    };
  }

  /** Render day/night color overlay and monitor glow */
  private renderDayNight(tileSize: number) {
    const { ctx, config } = this;
    const phase = this._currentPhase;

    // Color overlay
    ctx.fillStyle = phase.overlay;
    ctx.fillRect(0, 0, config.gridWidth * tileSize, config.gridHeight * tileSize);

    // During night phases, add monitor glow around typing agents
    if (phase.light < 0.5) {
      const glowIntensity = (0.5 - phase.light) * 2; // 0-1 stronger at night
      for (const char of this.characters.values()) {
        if (char.state === 'typing' || char.state === 'running_command') {
          const px = char.x * tileSize + tileSize / 2;
          const py = char.y * tileSize + tileSize / 2;
          const radius = tileSize * 2.5;

          ctx.save();
          ctx.globalAlpha = glowIntensity * 0.2;
          const gradient = ctx.createRadialGradient(px, py - tileSize * 0.3, 0, px, py - tileSize * 0.3, radius);
          gradient.addColorStop(0, 'rgba(100, 180, 255, 0.4)');
          gradient.addColorStop(0.4, 'rgba(100, 180, 255, 0.1)');
          gradient.addColorStop(1, 'transparent');
          ctx.fillStyle = gradient;
          ctx.fillRect(px - radius, py - tileSize * 0.3 - radius, radius * 2, radius * 2);
          ctx.restore();
        }
      }
    }

    // Dim the whole scene based on light level
    if (phase.light < 0.8) {
      ctx.save();
      ctx.globalAlpha = (1 - phase.light) * 0.3;
      ctx.fillStyle = '#000008';
      ctx.fillRect(0, 0, config.gridWidth * tileSize, config.gridHeight * tileSize);
      ctx.restore();
    }
  }

  // ── Ambient Particles ────────────────────────────────

  private updateAmbientParticles(dt: number) {
    const { config } = this;
    const w = config.gridWidth;
    const h = config.gridHeight;

    // Count dust particles
    let dustCount = 0;
    for (const p of this.ambientParticles) {
      if (p.type === 'dust') dustCount++;
    }

    // Spawn new dust motes
    let dustToAdd = AMBIENT_DUST_COUNT - dustCount;
    while (dustToAdd-- > 0) {
      const life = 8 + Math.random() * 12;
      this.ambientParticles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.3,
        vy: -0.05 - Math.random() * 0.1, // slow upward drift
        size: 1 + Math.random() * 2,
        alpha: 0,
        maxAlpha: 0.15 + Math.random() * 0.25,
        life,
        maxLife: life,
        type: 'dust',
        drift: 0.3 + Math.random() * 0.5,
        driftSpeed: 1 + Math.random() * 2,
        driftPhase: Math.random() * Math.PI * 2,
      });
    }

    // Spawn steam near coffee cup furniture items
    for (const item of this.placedFurniture) {
      if (item.type.toLowerCase().includes('coffee') || item.type.toLowerCase().includes('cup')) {
        let steamCount = 0;
        for (const p of this.ambientParticles) {
          if (p.type === 'steam' && Math.abs(p.x - (item.x + 0.5)) < 1) steamCount++;
        }
        if (steamCount < 3 && Math.random() < dt * 0.5) {
          this.ambientParticles.push({
            x: item.x + 0.3 + Math.random() * 0.4,
            y: item.y,
            vx: (Math.random() - 0.5) * 0.05,
            vy: -0.2 - Math.random() * 0.3,
            size: 2 + Math.random() * 3,
            alpha: 0,
            maxAlpha: 0.2 + Math.random() * 0.15,
            life: 1.5 + Math.random() * 2,
            maxLife: 3.5,
            type: 'steam',
            drift: 0.2,
            driftSpeed: 2,
            driftPhase: Math.random() * Math.PI * 2,
          });
        }
      }
    }

    // Spawn sparkles near monitors (at night)
    const phase = this._currentPhase;
    if (phase.light < 0.5 && Math.random() < dt * 2) {
      const typingAgents = Array.from(this.characters.values()).filter(
        c => c.state === 'typing' || c.state === 'running_command'
      );
      if (typingAgents.length > 0) {
        const agent = typingAgents[Math.floor(Math.random() * typingAgents.length)];
        this.ambientParticles.push({
          x: agent.x + (Math.random() - 0.5) * 1.5,
          y: agent.y - 0.5 + Math.random() * 0.3,
          vx: (Math.random() - 0.5) * 0.1,
          vy: -0.1 - Math.random() * 0.2,
          size: 1 + Math.random(),
          alpha: 0,
          maxAlpha: 0.3 + Math.random() * 0.3,
          life: 0.5 + Math.random() * 1,
          maxLife: 1.5,
          type: 'sparkle',
          drift: 0.1,
          driftSpeed: 3,
          driftPhase: Math.random() * Math.PI * 2,
        });
      }
    }

    // Update all particles
    for (const p of this.ambientParticles) {
      p.life -= dt;
      p.driftPhase += p.driftSpeed * dt;

      // Sinusoidal horizontal drift
      p.x += (p.vx + Math.sin(p.driftPhase) * p.drift) * dt * 2;
      p.y += p.vy * dt;

      // Fade in/out
      const lifeRatio = p.life / p.maxLife;
      if (lifeRatio > 0.8) {
        p.alpha = p.maxAlpha * ((1 - lifeRatio) / 0.2); // fade in
      } else if (lifeRatio < 0.3) {
        p.alpha = p.maxAlpha * (lifeRatio / 0.3); // fade out
      } else {
        p.alpha = p.maxAlpha;
      }

      // Wrap around horizontally
      if (p.x < 0) p.x = config.gridWidth;
      if (p.x > config.gridWidth) p.x = 0;
    }

    // Remove dead particles (in-place to avoid GC pressure)
    let writeIdx = 0;
    for (let i = 0; i < this.ambientParticles.length; i++) {
      if (this.ambientParticles[i].life > 0) {
        this.ambientParticles[writeIdx++] = this.ambientParticles[i];
      }
    }
    this.ambientParticles.length = writeIdx;
  }

  private renderAmbientParticles(tileSize: number) {
    const { ctx } = this;
    const now = this.nowMs / 1000;

    for (const p of this.ambientParticles) {
      const px = p.x * tileSize;
      const py = p.y * tileSize;

      ctx.save();
      ctx.globalAlpha = p.alpha;

      switch (p.type) {
        case 'dust': {
          // Soft warm dot
          const flicker = 0.7 + Math.sin(now * 3 + p.driftPhase) * 0.3;
          ctx.globalAlpha = p.alpha * flicker;
          ctx.fillStyle = '#ffeedd';
          ctx.beginPath();
          ctx.arc(px, py, p.size, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'steam': {
          // Soft white-blue wisps
          ctx.globalAlpha = p.alpha * 0.6;
          ctx.fillStyle = 'rgba(200, 220, 255, 0.4)';
          ctx.beginPath();
          ctx.arc(px, py, p.size * (1 + (1 - p.life / p.maxLife) * 2), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'sparkle': {
          // Bright brief flash
          const twinkle = Math.sin(now * 10 + p.driftPhase * 5);
          if (twinkle > 0.3) {
            ctx.globalAlpha = p.alpha * twinkle;
            ctx.fillStyle = '#88ccff';
            ctx.beginPath();
            ctx.arc(px, py, p.size * 0.8, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        }
      }

      ctx.restore();
    }
  }

  // ── Idle Behaviors ───────────────────────────────────

  private updateIdleBehaviors(dt: number) {
    for (const char of this.characters.values()) {
      if (char.isSubAgent) continue;
      const isWalking = Math.abs(char.targetX - char.x) > 0.05 || Math.abs(char.targetY - char.y) > 0.05;
      const isIdle = !isWalking && (char.state === 'idle' || char.state === 'waiting_input');

      let behavior = this.idleBehaviors.get(char.id);
      if (!behavior) {
        behavior = { current: 'none', timer: 1, phase: 0 };
        this.idleBehaviors.set(char.id, behavior);
      }

      behavior.timer -= dt;
      behavior.phase = 1 - Math.max(0, behavior.timer) / IDLE_ACTION_DURATION[behavior.current];

      if (behavior.timer <= 0) {
        if (isIdle && behavior.current === 'none' && Math.random() < IDLE_CHANCE * dt) {
          // Start a random idle action
          behavior.current = IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)];
          behavior.timer = IDLE_ACTION_DURATION[behavior.current];
          behavior.phase = 0;
        } else {
          behavior.current = 'none';
          behavior.timer = IDLE_ACTION_DURATION.none;
          behavior.phase = 0;
        }
      }

      // Cancel idle behavior if agent is no longer idle
      if (!isIdle && behavior.current !== 'none') {
        behavior.current = 'none';
        behavior.timer = 0.5;
      }
    }
  }

  /** Get idle behavior animation offset for a character */
  private getIdleOffset(charId: string): { dx: number; dy: number; scaleX: number } {
    const behavior = this.idleBehaviors.get(charId);
    if (!behavior || behavior.current === 'none') return { dx: 0, dy: 0, scaleX: 1 };

    const t = behavior.phase; // 0-1 progress
    const ease = Math.sin(t * Math.PI); // smooth bell curve

    switch (behavior.current) {
      case 'stretch':
        return { dx: 0, dy: -ease * 0.15, scaleX: 1 + ease * 0.05 }; // stretch up + slight widen
      case 'lookAround':
        return { dx: Math.sin(t * Math.PI * 4) * 0.1, dy: 0, scaleX: 1 }; // sway left/right
      case 'fidget':
        return { dx: Math.sin(t * Math.PI * 6) * 0.05, dy: -Math.abs(Math.sin(t * Math.PI * 4)) * 0.08, scaleX: 1 }; // rapid jitter
      case 'sip':
        return { dx: 0.15, dy: -ease * 0.1, scaleX: 1 }; // lean right + up (sipping motion)
      default:
        return { dx: 0, dy: 0, scaleX: 1 };
    }
  }

  // ── Render ───────────────────────────────────────────

  private render() {
    const { ctx, config } = this;
    const { tileSize, gridWidth, gridHeight } = config;
    const zoom = this.zoom;

    if (!this._renderDiagLogged) {
      this._renderDiagLogged = true;
      console.log(`[GameEngine] ${gridWidth}x${gridHeight} grid, ts=${tileSize}, zoom=${zoom.toFixed(2)}`);
    }

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.renderFloor(gridWidth, gridHeight, tileSize, zoom);
    this.renderWalls(gridWidth, gridHeight, tileSize);
    this.renderFurniture(tileSize, zoom);
    this.renderCharacters(tileSize, zoom);
    this.renderSelectionRing(tileSize);
    this.renderMoveTargets(tileSize);
    this.renderStateEffects(tileSize);
    this.renderAmbientParticles(tileSize);
    this.renderSpeechBubbles(tileSize);
    this.renderDayNight(tileSize);

    if (this.editorMode) this.renderEditorOverlay(tileSize);
  }

  private renderFloor(gridW: number, gridH: number, tileSize: number, zoom: number) {
    const { ctx, floors } = this;
    const hasFloor = floors.length > 0 && this.assetsLoaded;
    const reqWidth = gridW * tileSize;
    const reqHeight = gridH * tileSize;

    if (!this.floorCacheCanvas) {
      this.floorCacheCanvas = document.createElement('canvas');
      this.floorCacheCtx = this.floorCacheCanvas.getContext('2d');
    }

    if (this.floorCacheCanvas.width !== reqWidth || this.floorCacheCanvas.height !== reqHeight) {
      this.floorCacheCanvas.width = reqWidth;
      this.floorCacheCanvas.height = reqHeight;
      this.floorCacheValid = false;
    }

    if (!this.floorCacheValid && this.floorCacheCtx) {
      const ftx = this.floorCacheCtx;
      for (let row = 0; row < gridH; row++) {
        for (let col = 0; col < gridW; col++) {
          const px = col * tileSize, py = row * tileSize;
          if (hasFloor) {
            const floor = floors[((col + row) % 2 === 0 ? 0 : 1) % floors.length];
            ftx.imageSmoothingEnabled = false;
            ftx.drawImage(floor.canvas, px, py, tileSize, tileSize);
          } else {
            ftx.fillStyle = (col + row) % 2 === 0 ? 'rgba(26, 26, 46, 0.3)' : 'rgba(30, 30, 58, 0.3)';
            ftx.fillRect(px, py, tileSize, tileSize);
          }
        }
      }
      this.floorCacheValid = true;
    }

    if (this.floorCacheCanvas && this.floorCacheValid) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.floorCacheCanvas, 0, 0);
    } else if (!this.floorCacheCtx) {
      // Fallback: render floor directly when OffscreenCanvas context unavailable
      for (let row = 0; row < gridH; row++) {
        for (let col = 0; col < gridW; col++) {
          const px = col * tileSize, py = row * tileSize;
          if (hasFloor) {
            const floor = floors[((col + row) % 2 === 0 ? 0 : 1) % floors.length];
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(floor.canvas, px, py, tileSize, tileSize);
          } else {
            ctx.fillStyle = (col + row) % 2 === 0 ? 'rgba(26, 26, 46, 0.3)' : 'rgba(30, 30, 58, 0.3)';
            ctx.fillRect(px, py, tileSize, tileSize);
          }
        }
      }
    }
  }

  private renderWalls(gridW: number, gridH: number, tileSize: number) {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0, 240, 255, 0.15)'; // use glowing cyan translucent color for boundaries
    for (let col = 0; col < gridW; col++) {
      ctx.fillRect(col * tileSize, 0, tileSize, tileSize);
      ctx.fillRect(col * tileSize, (gridH - 1) * tileSize, tileSize, tileSize);
    }
    for (let row = 1; row < gridH - 1; row++) {
      ctx.fillRect(0, row * tileSize, tileSize, tileSize);
      ctx.fillRect((gridW - 1) * tileSize, row * tileSize, tileSize, tileSize);
    }
  }

  private renderFurniture(tileSize: number, zoom: number) {
    const { ctx, assetsLoaded, furniture } = this;
    if (!this._furnitureDiagLogged && this.placedFurniture.length > 0) {
      this._furnitureDiagLogged = true;
      const types = this.placedFurniture.map(f => f.type);
      const found = types.filter(t => furniture.has(t));
      console.log(`[GameEngine] renderFurniture: assetsLoaded=${assetsLoaded}, furnitureMapSize=${furniture.size}, placedTypes=[${types}], found=[${found}]`);
    }

    if (this.placedFurniture.length > 0) {
      for (const item of this.placedFurniture) {
        const px = item.x * tileSize;
        const py = item.y * tileSize;
        const isSelected = this.editorMode && this.selectedFurnitureId === item.id;

        ctx.save();
        if (item.rotation) {
          const cx = px + tileSize / 2, cy = py + tileSize / 2;
          ctx.translate(cx, cy);
          ctx.rotate((item.rotation * Math.PI) / 180);
          ctx.translate(-cx, -cy);
        }

        const spriteItem = furniture.get(item.type);
        if (assetsLoaded && spriteItem) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(spriteItem.canvas, px, py, spriteItem.width * zoom, spriteItem.height * zoom);
        } else {
          const colors: Record<string, string> = {
            DESK: '#533483', PC: '#0f3460', LARGE_PLANT: '#2d6a4f',
            COFFEE: '#6f4e37', WHITEBOARD: '#e8e8e8', BOOKSHELF: '#8b4513',
            LARGE_PAINTING: '#daa520',
          };
          ctx.fillStyle = colors[item.type] || '#533483';
          ctx.fillRect(px, py, tileSize * 2, tileSize);
        }
        ctx.restore();

        if (isSelected) {
          ctx.strokeStyle = '#4ecca3';
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(px - 2, py - 2, tileSize * 2 + 4, tileSize * 1.5 + 4);
          ctx.setLineDash([]);
        }
      }
    } else {
      this.renderLegacyFurniture(tileSize, zoom);
    }
  }

  private renderLegacyFurniture(tileSize: number, zoom: number) {
    const { ctx, seats, assetsLoaded, furniture } = this;
    const officeFurniture = [
      { type: 'LARGE_PLANT', x: 1, y: 1 },
      { type: 'COFFEE', x: 22, y: 1 },
      { type: 'WHITEBOARD', x: 11, y: 0 },
      { type: 'BOOKSHELF', x: 1, y: 8 },
      { type: 'LARGE_PAINTING', x: 22, y: 8 },
    ];
    for (const item of officeFurniture) {
      this.drawFurnitureItem(item.type, item.x * tileSize, item.y * tileSize, tileSize, zoom);
    }
    for (const [agentId, seat] of seats.entries()) {
      const px = seat.x * tileSize, py = seat.y * tileSize;
      const deskItem = furniture.get('DESK');
      const pcItem = furniture.get('PC');
      const chairItem = furniture.get('CUSHIONED_CHAIR') || furniture.get('WOODEN_CHAIR');
      if (assetsLoaded && (deskItem || pcItem)) {
        if (deskItem) { ctx.imageSmoothingEnabled = false; ctx.drawImage(deskItem.canvas, px, py - deskItem.height * zoom, deskItem.width * zoom, deskItem.height * zoom); }
        if (pcItem) { ctx.imageSmoothingEnabled = false; ctx.drawImage(pcItem.canvas, px + tileSize * 0.3, py - pcItem.height * zoom - (deskItem?.height ?? 0) * zoom * 0.5, pcItem.width * zoom, pcItem.height * zoom); }
        if (chairItem) { ctx.imageSmoothingEnabled = false; ctx.drawImage(chairItem.canvas, px + tileSize * 0.2, py + tileSize * 0.1, chairItem.width * zoom, chairItem.height * zoom); }
      } else {
        this.renderFallbackDesk(agentId, px, py, tileSize);
      }
    }
  }

  private drawFurnitureItem(type: string, px: number, py: number, tileSize: number, zoom: number) {
    const { ctx, furniture, assetsLoaded } = this;
    const item = furniture.get(type);
    if (assetsLoaded && item) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(item.canvas, px, py, item.width * zoom, item.height * zoom);
    } else {
      const colors: Record<string, string> = {
        LARGE_PLANT: '#2d6a4f', COFFEE: '#6f4e37', WHITEBOARD: '#e8e8e8',
        BOOKSHELF: '#8b4513', LARGE_PAINTING: '#daa520',
      };
      ctx.fillStyle = colors[type] || '#533483';
      ctx.fillRect(px, py, tileSize * 2, tileSize);
    }
  }

  private renderFallbackDesk(agentId: string, px: number, py: number, tileSize: number) {
    const { ctx } = this;
    ctx.fillStyle = '#533483';
    ctx.fillRect(px + 2, py - tileSize * 0.4, tileSize * 1.8, tileSize * 0.5);
    ctx.fillStyle = '#0f3460';
    ctx.fillRect(px + tileSize * 0.3, py - tileSize * 0.6, tileSize * 0.6, tileSize * 0.4);
    const char = this.characters.get(agentId);
    if (char && char.state !== 'sleeping' && char.state !== 'idle') {
      ctx.fillStyle = char.state === 'error' ? '#e9456040' : '#4ecca340';
      ctx.fillRect(px + tileSize * 0.35, py - tileSize * 0.55, tileSize * 0.5, tileSize * 0.3);
    }
    ctx.fillStyle = '#2d6a4f';
    ctx.fillRect(px + tileSize * 0.2, py + tileSize * 0.1, tileSize * 0.6, tileSize * 0.5);
  }

  private renderCharacters(tileSize: number, zoom: number) {
    const sorted = Array.from(this.characters.values()).sort((a, b) => a.y - b.y);
    for (const char of sorted) {
      this.renderCharacter(char, tileSize, zoom);
    }
  }

  private renderCharacter(char: Character, tileSize: number, zoom: number) {
    const { ctx } = this;
    const px = char.x * tileSize, py = char.y * tileSize;
    const isWalking = Math.abs(char.targetX - char.x) > 0.1 || Math.abs(char.targetY - char.y) > 0.1;
    const animState: AnimState = this.activityToAnimState(char.state, isWalking);

    // Idle breathing: subtle Y bob when stationary and idle
    const isIdle = !isWalking && (char.state === 'idle' || char.state === 'waiting_input' || char.state === 'error');
    const breathOffset = isIdle ? Math.sin(this.nowMs / 800) * tileSize * 0.04 : 0;

    // Idle behavior animation offset
    const idleOff = this.getIdleOffset(char.id);
    const totalDx = idleOff.dx * tileSize;
    const totalDy = (breathOffset + idleOff.dy * tileSize);

    ctx.save();

    // Apply idle scaleX for stretch (inside save/restore so it can't leak)
    if (idleOff.scaleX !== 1) {
      ctx.translate(px + tileSize / 2, 0);
      ctx.scale(idleOff.scaleX, 1);
      ctx.translate(-(px + tileSize / 2), 0);
    }

    // Sub-agent transparency
    if (char.isSubAgent && char.fadeAlpha < 1) {
      ctx.globalAlpha = char.fadeAlpha;
    }

    // Spawn glow effect for new sub-agents
    if (char.isSubAgent && (this.nowMs - char.spawnTime) < 1000) {
      const glowAlpha = 1 - (this.nowMs - char.spawnTime) / 1000;
      ctx.fillStyle = `rgba(78, 204, 163, ${glowAlpha * 0.4})`;
      ctx.beginPath();
      ctx.arc(px + tileSize / 2, py + tileSize / 2, tileSize, 0, Math.PI * 2);
      ctx.fill();
    }

    const sprites = this.characters_sprites;
    if (sprites == null || sprites.length === 0) {
      this.renderPlaceholderCharacter(char, px, py, tileSize);
    } else {
      const override = this.characterSpriteOverrides.get(char.id);
      const sprite = override ?? sprites[char.paletteIndex % sprites.length];
      if (!sprite) { this.renderPlaceholderCharacter(char, px, py, tileSize); }
      else {
        const frameCanvas = getSpriteFrame(sprite, animState, char.direction, char.animFrame);
        if (!frameCanvas) { this.renderPlaceholderCharacter(char, px, py, tileSize); }
        else {
          const scale = char.isSubAgent ? 1.5 : 2;
          const spriteW = 16 * scale, spriteH = 32 * scale;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(frameCanvas, px + (tileSize - spriteW) / 2 + totalDx, py + tileSize - spriteH + totalDy, spriteW, spriteH);
        }
      }
    }

    // Name label
    const fontSize = char.isSubAgent
      ? Math.max(6, tileSize * 0.2)
      : Math.max(8, tileSize * 0.28);
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.fillStyle = char.isSubAgent ? '#4ecca3' : '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(char.name, px + tileSize / 2, py + tileSize + tileSize * 0.35);
    ctx.textAlign = 'left';

    // Activity icon (animated)
    if (!char.isSubAgent) {
      this.renderActivityIcon(char, px + totalDx, py + totalDy, tileSize);
    }

    // Idle behavior indicator
    if (!char.isSubAgent) {
      const behavior = this.idleBehaviors.get(char.id);
      if (behavior && behavior.current !== 'none') {
        const icons: Record<IdleAction, string> = {
          stretch: '🫸', lookAround: '👀', fidget: '💫', sip: '☕', none: '',
        };
        const icon = icons[behavior.current];
        if (icon) {
          ctx.save();
          ctx.globalAlpha = 0.7 * (1 - Math.abs(behavior.phase - 0.5) * 0.4); // fade in/out
          ctx.font = `${tileSize * 0.3}px sans-serif`;
          ctx.fillText(icon, px + totalDx + tileSize * 0.7, py + totalDy - tileSize * 0.3);
          ctx.restore();
        }
      }
    }

    ctx.restore();
  }

  /** Render animated activity icon above character */
  private renderActivityIcon(char: Character, px: number, py: number, tileSize: number) {
    const { ctx } = this;
    const vfx = STATE_VFX[char.state];
    if (!vfx) return;

    const now = this.nowMs;
    const iconSize = tileSize * 0.45;

    // Thinking: 3 bouncing dots
    if (char.state === 'thinking') {
      const dotR = tileSize * 0.06;
      const baseY = py - tileSize * 0.3;
      for (let i = 0; i < 3; i++) {
        const phase = (now / 400 + i * 0.7) % (Math.PI * 2);
        const bounceY = Math.sin(phase) * tileSize * 0.08;
        ctx.fillStyle = vfx.color;
        ctx.globalAlpha = 0.6 + Math.sin(phase) * 0.3;
        ctx.beginPath();
        ctx.arc(
          px + tileSize / 2 + (i - 1) * tileSize * 0.15,
          baseY - bounceY,
          dotR, 0, Math.PI * 2
        );
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }

    // Waiting_input: pulsing speech icon
    if (char.state === 'waiting_input') {
      const pulse = 1 + Math.sin(now / 300) * 0.15;
      ctx.save();
      ctx.translate(px + tileSize * 0.15, py - tileSize * 0.15);
      ctx.scale(pulse, pulse);
      ctx.font = `${iconSize}px sans-serif`;
      ctx.fillText('💬', 0, 0);
      ctx.restore();
      return;
    }

    // Error: shake
    if (char.state === 'error') {
      const shake = Math.sin(now / 50) * tileSize * 0.04;
      ctx.font = `${iconSize}px sans-serif`;
      ctx.fillText('❌', px + tileSize * 0.15 + shake, py - tileSize * 0.15);
      return;
    }

    // Running_command: spinning bolt
    if (char.state === 'running_command') {
      const rotation = (now / 200) % (Math.PI * 2);
      ctx.save();
      ctx.translate(px + tileSize * 0.4, py - tileSize * 0.15);
      ctx.rotate(rotation);
      ctx.font = `${iconSize * 0.8}px sans-serif`;
      ctx.fillText('⚡', -iconSize * 0.4, iconSize * 0.3);
      ctx.restore();
      return;
    }

    // Default: static icon with subtle bob
    const bob = Math.sin(now / 600) * tileSize * 0.03;
    const icon = vfx.icon || this.getActivityIcon(char.state);
    if (icon) {
      ctx.font = `${iconSize}px sans-serif`;
      ctx.fillText(icon, px + tileSize * 0.15, py - tileSize * 0.15 + bob);
    }
  }

  // ── Speech Bubbles ───────────────────────────────────

  private renderSpeechBubbles(tileSize: number) {
    const { ctx } = this;

    for (const [agentId, bubble] of this.speechBubbles) {
      const char = this.characters.get(agentId);
      if (!char || char.state !== 'waiting_input') continue;

      const px = char.x * tileSize + tileSize / 2;
      const py = char.y * tileSize - tileSize * 0.8;

      ctx.save();
      ctx.globalAlpha = bubble.alpha;

      // Measure text
      const maxW = tileSize * 4;
      const fontSize = Math.max(9, tileSize * 0.3);
      ctx.font = `${fontSize}px monospace`;
      const text = this.truncateText(bubble.text, 40);
      const textW = Math.min(ctx.measureText(text).width + 12, maxW);
      const textH = fontSize + 10;
      const bx = px - textW / 2;
      const by = py - textH;

      // Bubble background
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#333333';
      ctx.lineWidth = 1;
      this.roundRect(ctx, bx, by, textW, textH, 4);
      ctx.fill();
      ctx.stroke();

      // Triangle pointer
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(px - 4, by + textH);
      ctx.lineTo(px + 4, by + textH);
      ctx.lineTo(px, by + textH + 5);
      ctx.closePath();
      ctx.fill();

      // Text
      ctx.fillStyle = '#222222';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, px, by + textH / 2);

      ctx.restore();
    }
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  private truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + '…';
  }

  private renderPlaceholderCharacter(char: Character, px: number, py: number, tileSize: number) {
    const { ctx } = this;
    const colors: Record<string, string> = {
      cybera: '#e94560', shodan: '#4ecca3', cyberlogis: '#ffc107',
      descartes: '#17a2b8', sysauxilia: '#6c757d', chi: '#ff6b9d',
      cylena: '#a78bfa', miku: '#39ff14',
    };
    const color = char.isSubAgent ? '#4ecca3' : (colors[char.id] || '#e94560');
    const bodyW = tileSize * (char.isSubAgent ? 0.35 : 0.5);
    const bodyH = tileSize * (char.isSubAgent ? 0.5 : 0.7);
    ctx.fillStyle = color;
    ctx.fillRect(px + (tileSize - bodyW) / 2, py + tileSize - bodyH, bodyW, bodyH);
    const headSize = tileSize * (char.isSubAgent ? 0.3 : 0.4);
    ctx.fillStyle = '#f0d0a0';
    ctx.fillRect(px + (tileSize - headSize) / 2, py + tileSize - bodyH - headSize * 0.6, headSize, headSize);
  }

  private renderEditorOverlay(tileSize: number) {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(78, 204, 163, 0.15)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= this.config.gridWidth; x++) {
      ctx.beginPath(); ctx.moveTo(x * tileSize, 0); ctx.lineTo(x * tileSize, this.canvas.height); ctx.stroke();
    }
    for (let y = 0; y <= this.config.gridHeight; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * tileSize); ctx.lineTo(this.canvas.width, y * tileSize); ctx.stroke();
    }
    if (this.mouseGridX >= 0 && this.mouseGridY >= 0) {
      const px = this.mouseGridX * tileSize, py = this.mouseGridY * tileSize;
      if (this.selectedFurnitureType) {
        ctx.fillStyle = 'rgba(78, 204, 163, 0.25)';
        ctx.fillRect(px, py, tileSize * 2, tileSize);
        ctx.strokeStyle = '#4ecca3'; ctx.lineWidth = 2;
        ctx.strokeRect(px, py, tileSize * 2, tileSize);
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.fillRect(px, py, tileSize, tileSize);
      }
    }
  }

  // ── Mouse handlers ───────────────────────────────────

  private screenToGrid(e: MouseEvent): { gridX: number; gridY: number } | null;
  private screenToGrid(clientX: number, clientY: number): { gridX: number; gridY: number } | null;
  private screenToGrid(eOrX: MouseEvent | number, maybeY?: number): { gridX: number; gridY: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const canvas = this.canvas;

    // When object-fit: contain is used, the CSS box (rect) may be larger than
    // the actual rendered canvas area due to pillarboxing/letterboxing.
    // We need to compute the actual rendered dimensions to get correct scales.
    const cssRatio = rect.width / rect.height;
    const canvasRatio = canvas.width / canvas.height;

    let renderedWidth: number, renderedHeight: number, offsetX: number, offsetY: number;

    if (cssRatio > canvasRatio) {
      // Pillarboxing: bars on left/right
      renderedWidth = (canvas.width / canvas.height) * rect.height;
      renderedHeight = rect.height;
      offsetX = rect.left + (rect.width - renderedWidth) / 2;
      offsetY = rect.top;
    } else {
      // Letterboxing: bars on top/bottom
      renderedWidth = rect.width;
      renderedHeight = (canvas.height / canvas.width) * rect.width;
      offsetX = rect.left;
      offsetY = rect.top + (rect.height - renderedHeight) / 2;
    }

    // Use unified scale - both dimensions should have the same ratio with object-fit: contain
    const scale = canvas.width / renderedWidth;

    const clientX = typeof eOrX === 'number' ? eOrX : eOrX.clientX;
    const clientY = typeof eOrX === 'number' ? maybeY! : eOrX.clientY;

    // Check if click falls within the rendered canvas area (not in letterbox/pillarbox)
    if (clientX < offsetX || clientX > offsetX + renderedWidth ||
      clientY < offsetY || clientY > offsetY + renderedHeight) {
      return null;
    }

    return {
      gridX: Math.floor((clientX - offsetX) * scale / this.config.tileSize),
      gridY: Math.floor((clientY - offsetY) * scale / this.config.tileSize),
    };
  }

  private findFurnitureAt(gridX: number, gridY: number): PlacedFurniture | null {
    for (let i = this.placedFurniture.length - 1; i >= 0; i--) {
      const f = this.placedFurniture[i];
      const sprite = this.furniture.get(f.type);
      const fw = sprite ? sprite.footprintW : 2;
      const fh = sprite ? sprite.footprintH : 1;
      if (gridX >= f.x && gridX < f.x + fw && gridY >= f.y && gridY < f.y + fh) return f;
    }
    return null;
  }

  private findCharacterAt(gridX: number, gridY: number): string | null {
    for (const char of this.characters.values()) {
      const cx = Math.round(char.x);
      const cy = Math.round(char.y);
      if (gridX >= cx && gridX <= cx + 1 && gridY >= cy && gridY <= cy + 1) {
        return char.id;
      }
    }
    return null;
  }

  private handleMouseMove = (e: MouseEvent) => {
    const result = this.screenToGrid(e);
    if (!result) return;
    const { gridX, gridY } = result;
    this.mouseGridX = gridX;
    this.mouseGridY = gridY;
    if (this.dragging) {
      const item = this.placedFurniture.find(f => f.id === this.dragging!.id);
      if (item) {
        item.x = Math.max(1, Math.min(this.config.gridWidth - 3, gridX));
        item.y = Math.max(1, Math.min(this.config.gridHeight - 3, gridY));
      }
    }
    if (this.editorMode) {
      if (this.selectedFurnitureType) {
        this.canvas.style.cursor = 'crosshair';
      } else {
        const overFurniture = this.findFurnitureAt(gridX, gridY);
        this.canvas.style.cursor = overFurniture
          ? (this.deleteMode ? 'pointer' : this.dragging ? 'grabbing' : 'grab')
          : 'default';
      }
    } else {
      // Non-editor: pointer on character hover, crosshair if agent is selected
      if (this.selectedAgentId) {
        this.canvas.style.cursor = 'crosshair';
      } else {
        this.canvas.style.cursor = this.findCharacterAt(gridX, gridY) ? 'pointer' : 'default';
      }
    }
  };

  private handleMouseDown = (e: MouseEvent) => {
    if (!this.editorMode) return;
    const result = this.screenToGrid(e);
    if (!result) return;
    const { gridX, gridY } = result;
    if (e.button === 0) {
      if (this.selectedFurnitureType) {
        this.editorCallbacks?.onPlaceFurniture(this.selectedFurnitureType, gridX, gridY);
        sfx.place();
        return;
      }
      const hit = this.findFurnitureAt(gridX, gridY);
      if (hit) {
        if (this.deleteMode) {
          // In delete mode: just notify React, skip drag/pickup
          this.editorCallbacks?.onSelectFurniture(hit.id);
          return;
        }
        this.selectedFurnitureId = hit.id;
        this.editorCallbacks?.onSelectFurniture(hit.id);
        this.dragging = { id: hit.id, offsetX: gridX - hit.x, offsetY: gridY - hit.y };
        sfx.pickup();
      } else {
        this.selectedFurnitureId = null;
        this.editorCallbacks?.onSelectFurniture(null);
      }
    }
  };

  private handleMouseUp = (e: MouseEvent) => {
    if (!this.editorMode) return;
    if (this.dragging) {
      const result = this.screenToGrid(e);
      if (!result) return;
      const { gridX, gridY } = result;
      this.editorCallbacks?.onMoveFurniture(
        this.dragging.id,
        Math.max(1, Math.min(this.config.gridWidth - 3, gridX)),
        Math.max(1, Math.min(this.config.gridHeight - 3, gridY)),
      );
      sfx.place();
      this.dragging = null;
    }
  };

  private handleMouseLeave = () => {
    this.mouseGridX = -1; this.mouseGridY = -1; this.dragging = null;
    this.canvas.style.cursor = 'default';
  };

  private handleContextMenu = (e: MouseEvent) => {
    if (!this.editorMode) return;
    e.preventDefault();
    const result = this.screenToGrid(e);
    if (!result) return;
    const { gridX, gridY } = result;
    const hit = this.findFurnitureAt(gridX, gridY);
    if (hit) hit.rotation = ((hit.rotation || 0) + 90) % 360;
  };

  private handleClick = (e: MouseEvent) => {
    if (this.editorMode) return;
    const result = this.screenToGrid(e);
    if (!result) return;
    const { gridX, gridY } = result;
    const charId = this.findCharacterAt(gridX, gridY);

    if (charId && !charId.startsWith('sub-')) {
      // Click on agent → select them
      this.selectedAgentId = charId;
      this.selectionPulse = 0;
      sfx.click(); // satisfying selection click
      this.gameCallbacks?.onCharacterClick(charId);
      this.canvas.style.cursor = 'pointer';
    } else if (this.selectedAgentId) {
      // Click on empty tile → move selected agent there
      const char = this.characters.get(this.selectedAgentId);
      if (char) {
        // Check if tile is walkable
        this.ensureObstacles();
        if (this.obstacleGrid && gridY >= 0 && gridY < this.config.gridHeight && gridX >= 0 && gridX < this.config.gridWidth) {
          if (!this.obstacleGrid[gridY][gridX]) {
            char.targetX = gridX;
            char.targetY = gridY;
            char.path = this.computePath(char);
            char.pathIndex = 0;
            sfx.footstep(); // move-command sound
          }
        }
      }
      // Deselect after move command (or click invalid tile)
      this.selectedAgentId = null;
      this.canvas.style.cursor = 'default';
    }
  };

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.selectedAgentId) {
      this.selectedAgentId = null;
      this.canvas.style.cursor = 'default';
    }
  };

  // ── Touch Event Handlers ─────────────────────────────

  private static readonly TAP_THRESHOLD = 12; // px movement before it's a drag, not a tap
  private static readonly DOUBLE_TAP_MS = 300; // max interval between double-tap

  private handleTouchStart = (e: TouchEvent) => {
    e.preventDefault(); // prevent mouse event synthesis & scroll

    if (e.touches.length === 2) {
      // Pinch-to-zoom start: cancel any active one-finger drag/tap state so that
      // lifting all fingers after a pinch cannot accidentally finalize a furniture drag.
      this.touchDragging = null;
      this.touchStartPos = null;
      this.touchCurrentPos = null;
      this.touchMoved = true;
      this.pinchStartDist = this.touchDistance(e.touches[0], e.touches[1]);
      this.pinchStartZoom = this.cameraZoom;
      return;
    }

    const t = e.touches[0];
    this.touchStartPos = { x: t.clientX, y: t.clientY };
    this.touchCurrentPos = { x: t.clientX, y: t.clientY };
    this.touchMoved = false;

    const result1 = this.screenToGrid(t.clientX, t.clientY);
    if (!result1) return;
    const { gridX: gridX1, gridY: gridY1 } = result1;
    this.mouseGridX = gridX1;
    this.mouseGridY = gridY1;

    // Editor mode: start dragging furniture immediately on touch
    if (this.editorMode && e.touches.length === 1) {
      if (this.selectedFurnitureType) {
        // Will place on touchend if not moved
      } else {
        const hit = this.findFurnitureAt(gridX1, gridY1);
        if (hit) {
          if (this.deleteMode) {
            // In delete mode: just notify React, skip drag
            this.editorCallbacks?.onSelectFurniture(hit.id);
          } else {
            this.touchDragging = { id: hit.id, offsetX: gridX1 - hit.x, offsetY: gridY1 - hit.y };
            this.selectedFurnitureId = hit.id;
            this.editorCallbacks?.onSelectFurniture(hit.id);
          }
        }
      }
    }
  };

  private handleTouchMove = (e: TouchEvent) => {
    e.preventDefault();

    // Pinch-to-zoom
    if (e.touches.length === 2) {
      const dist = this.touchDistance(e.touches[0], e.touches[1]);

      // Guard against zero/invalid starting distance (e.g., both fingers started at the
      // same pixel): reinitialize from the first valid distance seen during move.
      if (!this.pinchStartDist || this.pinchStartDist <= 0) {
        if (dist <= 0) return;
        this.pinchStartDist = dist;
        this.pinchStartZoom = this.cameraZoom;
      }

      const scale = dist / this.pinchStartDist;
      const newZoom = Math.max(1, Math.min(4, this.pinchStartZoom * scale));
      this.cameraZoom = newZoom;
      this.canvas.style.transform = `scale(${this.cameraZoom})`;
      this.canvas.style.transformOrigin = 'center center';
      return;
    }

    if (!this.touchStartPos) return;
    const t = e.touches[0];
    const dx = t.clientX - this.touchStartPos.x;
    const dy = t.clientY - this.touchStartPos.y;

    if (Math.abs(dx) > GameEngine.TAP_THRESHOLD || Math.abs(dy) > GameEngine.TAP_THRESHOLD) {
      this.touchMoved = true;
    }

    // Track the latest finger position so handleTouchEnd can use the drop location
    this.touchCurrentPos = { x: t.clientX, y: t.clientY };

    const result2 = this.screenToGrid(t.clientX, t.clientY);
    if (!result2) return;
    const { gridX: gridX2, gridY: gridY2 } = result2;
    this.mouseGridX = gridX2;
    this.mouseGridY = gridY2;

    // Editor mode: drag furniture (subtract grab offset to keep furniture under finger)
    if (this.editorMode && this.touchDragging) {
      const item = this.placedFurniture.find(f => f.id === this.touchDragging!.id);
      if (item) {
        item.x = Math.max(1, Math.min(this.config.gridWidth - 3, gridX2 - this.touchDragging.offsetX));
        item.y = Math.max(1, Math.min(this.config.gridHeight - 3, gridY2 - this.touchDragging.offsetY));
      }
    }
  };

  private handleTouchEnd = (e: TouchEvent) => {
    e.preventDefault();

    // Pinch-to-zoom end — nothing extra to do
    if (e.touches.length > 0) return;

    // Editor mode: finish furniture drag, place, or double-tap rotate
    if (this.editorMode) {
      if (this.touchDragging) {
        // touchCurrentPos is always set alongside touchStartPos in handleTouchStart and kept
        // up-to-date in handleTouchMove, so it reliably reflects the finger's final position.
        // Subtract the grab offset so the drop position matches what was shown during the drag.
        const resultDrag = this.screenToGrid(this.touchCurrentPos!.x, this.touchCurrentPos!.y);
        if (resultDrag) {
          this.editorCallbacks?.onMoveFurniture(
            this.touchDragging.id,
            Math.max(1, Math.min(this.config.gridWidth - 3, resultDrag.gridX - this.touchDragging.offsetX)),
            Math.max(1, Math.min(this.config.gridHeight - 3, resultDrag.gridY - this.touchDragging.offsetY)),
          );
          sfx.place();
        }
        this.touchDragging = null;
      } else if (!this.touchMoved && this.touchStartPos) {
        const resultTap = this.screenToGrid(this.touchStartPos.x, this.touchStartPos.y);
        if (!resultTap) {
          this.touchStartPos = null;
          this.touchCurrentPos = null;
          return;
        }
        const { gridX, gridY } = resultTap;
        const now = Date.now();

        // Double-tap furniture → rotate (mirrors desktop right-click in editor mode)
        if (now - this.lastTapTime < GameEngine.DOUBLE_TAP_MS) {
          const hit = this.findFurnitureAt(gridX, gridY);
          if (hit) {
            hit.rotation = ((hit.rotation || 0) + 90) % 360;
            sfx.place();
            this.lastTapTime = 0;
            this.touchStartPos = null;
            this.touchCurrentPos = null;
            return;
          }
        }
        this.lastTapTime = now;

        // Single tap to place furniture
        if (this.selectedFurnitureType) {
          this.editorCallbacks?.onPlaceFurniture(this.selectedFurnitureType, gridX, gridY);
          sfx.place();
        }
      }
      this.touchStartPos = null;
      this.touchCurrentPos = null;
      return;
    }

    // ── Non-editor: tap interactions ──
    if (this.touchMoved || !this.touchStartPos) {
      this.touchStartPos = null;
      this.touchCurrentPos = null;
      return; // was a drag or pinch, not a tap
    }

    const resultTap2 = this.screenToGrid(this.touchStartPos.x, this.touchStartPos.y);
    if (!resultTap2) {
      this.touchStartPos = null;
      this.touchCurrentPos = null;
      return;
    }
    const { gridX, gridY } = resultTap2;

    const charId = this.findCharacterAt(gridX, gridY);

    if (charId && !charId.startsWith('sub-')) {
      // Tap agent → select
      this.selectedAgentId = charId;
      this.selectionPulse = 0;
      sfx.click();
      this.gameCallbacks?.onCharacterClick(charId);
    } else if (this.selectedAgentId) {
      // Tap empty tile → move selected agent
      const char = this.characters.get(this.selectedAgentId);
      if (char) {
        this.ensureObstacles();
        if (this.obstacleGrid && gridY >= 0 && gridY < this.config.gridHeight
          && gridX >= 0 && gridX < this.config.gridWidth
          && !this.obstacleGrid[gridY][gridX]) {
          char.targetX = gridX;
          char.targetY = gridY;
          char.path = this.computePath(char);
          char.pathIndex = 0;
          sfx.footstep();
        }
      }
      this.selectedAgentId = null;
    } else {
      // Tap empty tile, no agent selected → deselect
      this.selectedAgentId = null;
    }

    this.touchStartPos = null;
    this.touchCurrentPos = null;
  };

  private handleTouchCancel = () => {
    this.touchStartPos = null;
    this.touchCurrentPos = null;
    this.touchDragging = null;
    this.touchMoved = false;
    this.mouseGridX = -1;
    this.mouseGridY = -1;
  };

  /** Euclidean distance between two touch points */
  private touchDistance(a: Touch, b: Touch): number {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ── Helpers ──────────────────────────────────────────

  private activityToAnimState(state: string, isWalking: boolean): AnimState {
    if (isWalking) return 'walk';
    switch (state) {
      case 'typing': case 'running_command': return 'typing';
      case 'reading': case 'thinking': return 'reading';
      case 'waiting_input': return 'idle';
      case 'error': return 'idle';
      default: return 'idle';
    }
  }

  // ── State Transition Effects ─────────────────────────

  /** Render animated selection ring around selected agent */
  private renderSelectionRing(tileSize: number) {
    if (!this.selectedAgentId) return;
    const char = this.characters.get(this.selectedAgentId);
    if (!char) { this.selectedAgentId = null; return; }

    const { ctx } = this;
    this.selectionPulse += 0.04;

    const px = char.x * tileSize + tileSize / 2;
    const py = char.y * tileSize + tileSize / 2;
    const baseRadius = tileSize * 0.9;
    const pulse = Math.sin(this.selectionPulse) * tileSize * 0.08;
    const radius = baseRadius + pulse;

    ctx.save();

    // Outer glow
    ctx.strokeStyle = '#4ecca3';
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.4 + Math.sin(this.selectionPulse * 1.5) * 0.15;
    ctx.shadowColor = '#4ecca3';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Inner dashed ring
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -this.selectionPulse * 8; // rotating dash
    ctx.beginPath();
    ctx.arc(px, py, radius - 3, 0, Math.PI * 2);
    ctx.stroke();

    // Name label
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#0f0f23';
    ctx.font = `bold ${tileSize * 0.35}px monospace`;
    const labelWidth = ctx.measureText(char.name).width;
    const labelX = px - labelWidth / 2 - 4;
    const labelY = py - radius - 14;
    ctx.fillRect(labelX, labelY, labelWidth + 8, tileSize * 0.4);
    ctx.fillStyle = '#4ecca3';
    ctx.fillText(char.name, px - labelWidth / 2, labelY + tileSize * 0.32);

    ctx.restore();
  }

  private spawnStateEffect(char: Character) {
    const vfx = STATE_VFX[char.state];
    if (!vfx || vfx.particleCount === 0) return;

    const particles: Particle[] = [];
    for (let i = 0; i < vfx.particleCount; i++) {
      const angle = (Math.PI * 2 * i) / vfx.particleCount + Math.random() * 0.5;
      const speed = vfx.particleSpeed * (0.5 + Math.random() * 0.5);
      particles.push({
        x: char.x,
        y: char.y - 0.3, // slightly above character center
        vx: Math.cos(angle) * speed * 0.01,
        vy: Math.sin(angle) * speed * 0.01 - 0.02, // upward bias
        life: 0.6 + Math.random() * 0.4,
        maxLife: 1.0,
        color: vfx.color,
        size: 2 + Math.random() * 3,
      });
    }

    this.stateEffects.push({
      agentId: char.id,
      state: char.state,
      startTime: this.nowMs,
      particles,
      duration: vfx.glowDuration,
    });
  }

  /** Show a small fading target marker on walking agents' destinations */
  private renderMoveTargets(tileSize: number) {
    const { ctx } = this;
    const now = this.nowMs;

    for (const char of this.characters.values()) {
      const isWalking = Math.abs(char.targetX - char.x) > 0.05 || Math.abs(char.targetY - char.y) > 0.05;
      if (!isWalking) continue;

      const tx = char.targetX * tileSize + tileSize / 2;
      const ty = char.targetY * tileSize + tileSize / 2;
      const size = tileSize * 0.2;

      // Pulsing crosshair
      const pulse = Math.sin(now / 200) * 0.15 + 0.85;
      ctx.save();
      ctx.globalAlpha = 0.5 * pulse;
      ctx.strokeStyle = '#4ecca3';
      ctx.lineWidth = 1.5;

      // X marker
      ctx.beginPath();
      ctx.moveTo(tx - size, ty - size);
      ctx.lineTo(tx + size, ty + size);
      ctx.moveTo(tx + size, ty - size);
      ctx.lineTo(tx - size, ty + size);
      ctx.stroke();

      // Small circle around target
      ctx.beginPath();
      ctx.arc(tx, ty, size * 1.5, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    }
  }

  private renderStateEffects(tileSize: number) {
    const { ctx } = this;
    const nowMs = this.nowMs;

    for (const fx of this.stateEffects) {
      const char = this.characters.get(fx.agentId);
      if (!char) continue;

      const vfx = STATE_VFX[fx.state];
      if (!vfx) continue;

      const elapsed = nowMs - fx.startTime;
      const progress = Math.min(1, elapsed / fx.duration);

      // Render glow behind character
      if (progress < 1 && vfx.glowColor !== 'transparent') {
        const px = char.x * tileSize + tileSize / 2;
        const py = char.y * tileSize + tileSize / 2;
        const glowAlpha = (1 - progress) * parseFloat(vfx.glowColor.match(/[\d.]+(?=\))/)?.[0] ?? '0.15');
        const radius = tileSize * (1.2 + progress * 0.5);

        ctx.save();
        ctx.globalAlpha = glowAlpha;
        const gradient = ctx.createRadialGradient(px, py, 0, px, py, radius);
        gradient.addColorStop(0, vfx.color);
        gradient.addColorStop(1, 'transparent');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Render particles
      for (const p of fx.particles) {
        const px = p.x * tileSize + tileSize / 2;
        const py = p.y * tileSize + tileSize / 2;
        const alpha = Math.max(0, p.life / p.maxLife);

        ctx.save();
        ctx.globalAlpha = alpha * 0.8;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(px, py, p.size * (1 - (1 - alpha) * 0.5), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  private getActivityIcon(state: string): string {
    const icons: Record<string, string> = {
      typing: '⌨', reading: '📖', thinking: '💭',
      waiting_input: '💬', sleeping: '💤', error: '❌',
    };
    return icons[state] || '';
  }

  // ── Public API ──────────────────────────────────────────

  /** Replace the sprite for a specific agent (e.g. after recipe change). */
  setCharacterSprite(agentId: string, sprite: LoadedCharacter) {
    this.characterSpriteOverrides.set(agentId, sprite);
  }

  addCharacter(data: CharacterData) {
    const paletteIndex = AGENT_PALETTES[data.id] ?? Math.floor(Math.random() * 6);
    this.characters.set(data.id, {
      ...data, targetX: data.x, targetY: data.y,
      animFrame: 0, animTimer: 0, direction: 'down', paletteIndex,
      path: [], pathIndex: 0,
      spawnTime: this.nowMs, fadeAlpha: 1, dying: false,
      lastFootstepTile: -1, typingSoundTimer: 0, stateJustChanged: false,
    });

    // Create speech bubble if agent starts in waiting state with a message
    if (data.state === 'waiting_input' && data.lastMessage) {
      this.speechBubbles.set(data.id, {
        text: data.lastMessage,
        timer: 30,
        alpha: 1,
      });
    }
  }

  removeCharacter(id: string) {
    this.characters.delete(id);
    this.idleBehaviors.delete(id);
    this.seats.delete(id);
  }

  updateCharacter(id: string, updates: Partial<CharacterData>) {
    const char = this.characters.get(id);
    if (!char) return;

    // Detect state change
    const oldState = char.state;
    const hadTarget = { x: char.targetX, y: char.targetY };
    Object.assign(char, updates);

    if (updates.state && updates.state !== oldState) {
      char.stateJustChanged = true;
    }

    // When activity changes to a desk activity, route to seat
    if (updates.state && ['typing', 'reading', 'running_command', 'thinking'].includes(updates.state)) {
      const seat = this.seats.get(id);
      if (seat) {
        char.targetX = seat.x;
        char.targetY = seat.y;
      }
    }

    // Recompute path if target changed
    if (Math.abs(char.targetX - hadTarget.x) > 0.1 || Math.abs(char.targetY - hadTarget.y) > 0.1) {
      char.path = this.computePath(char);
      char.pathIndex = 0;
    }

    // Update speech bubble for waiting state
    if (updates.state === 'waiting_input' && updates.lastMessage) {
      this.speechBubbles.set(id, {
        text: updates.lastMessage,
        timer: 30, // 30 seconds visible
        alpha: 1,
      });
    }
  }

  /** Spawn a sub-agent character near a parent agent */
  spawnSubAgent(parentId: string, subId: string, subName: string) {
    const parent = this.characters.get(parentId);
    if (!parent) return;

    const offsetAngle = Math.random() * Math.PI * 2;
    const offsetDist = 2;
    const sx = Math.max(1, Math.min(this.config.gridWidth - 2,
      Math.round(parent.x + Math.cos(offsetAngle) * offsetDist)));
    const sy = Math.max(1, Math.min(this.config.gridHeight - 2,
      Math.round(parent.y + Math.sin(offsetAngle) * offsetDist)));

    const sub: Character = {
      id: subId,
      name: subName,
      x: sx, y: sy,
      targetX: sx, targetY: sy,
      state: 'typing',
      model: undefined,
      spriteId: undefined,
      animFrame: 0, animTimer: 0,
      direction: 'down',
      paletteIndex: parent.paletteIndex,
      path: [], pathIndex: 0,
      spawnTime: this.nowMs,
      fadeAlpha: 1,
      dying: false,
      isSubAgent: true,
      parentAgentId: parentId,
      lastFootstepTile: -1,
      typingSoundTimer: 0,
      stateJustChanged: false,
    };

    this.characters.set(subId, sub);
    sfx.spawn();
  }

  /** Mark a sub-agent as dying (will fade out) */
  killSubAgent(subId: string) {
    const sub = this.characters.get(subId);
    if (sub?.isSubAgent) sub.dying = true;
  }

  getCharacterIds(): string[] { return Array.from(this.characters.keys()); }

  assignSeat(agentId: string): { x: number; y: number } {
    if (this.seats.has(agentId)) return this.seats.get(agentId)!;
    const used = new Set(Array.from(this.seats.values()).map(p => `${p.x},${p.y}`));
    for (let y = 3; y < this.config.gridHeight - 2; y += 3) {
      for (let x = 3; x < this.config.gridWidth - 3; x += 4) {
        if (!used.has(`${x},${y}`)) { this.seats.set(agentId, { x, y }); return { x, y }; }
      }
    }
    const fb = { x: Math.floor(this.config.gridWidth / 2), y: Math.floor(this.config.gridHeight / 2) };
    this.seats.set(agentId, fb);
    return fb;
  }

  // ── Editor API ──────────────────────────────────────────

  setEditorMode(enabled: boolean) {
    this.editorMode = enabled;
    this.selectedFurnitureType = null;
    this.selectedFurnitureId = null;
    this.canvas.style.cursor = 'default';
  }

  setEditorCallbacks(cb: EditorCallbacks) { this.editorCallbacks = cb; }
  setGameCallbacks(cb: GameCallbacks) { this.gameCallbacks = cb; }
  setDeleteMode(enabled: boolean) { this.deleteMode = enabled; }
  setSelectedFurnitureType(type: string | null) { this.selectedFurnitureType = type; this.selectedFurnitureId = null; }
  setSelectedFurnitureId(id: string | null) { this.selectedFurnitureId = id; this.selectedFurnitureType = null; }

  setLayout(furniture: PlacedFurniture[], seats?: Record<string, { x: number; y: number }>) {
    this.placedFurniture = furniture;
    this.obstacleDirty = true;
    // Schedule deferred rebuild to avoid blocking during rapid updates
    this.scheduleObstacleRebuild();
    if (seats) {
      this.seats.clear();
      for (const [aid, pos] of Object.entries(seats)) this.seats.set(aid, pos);
    }
  }

  getPlacedFurniture(): PlacedFurniture[] { return [...this.placedFurniture]; }
}
