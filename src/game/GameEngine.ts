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

export class GameEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: GameConfig;
  private characters: Map<string, Character> = new Map();
  private running = false;
  private animFrameId = 0;
  private lastTime = 0;
  private assetsLoaded = false;
  private _renderDiagLogged = false;
  private characters_sprites: LoadedCharacter[] = [];
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

  // Editor state
  private editorMode = false;
  private selectedFurnitureType: string | null = null;
  private selectedFurnitureId: string | null = null;
  private dragging: { id: string; offsetX: number; offsetY: number } | null = null;
  private editorCallbacks: EditorCallbacks | null = null;
  private gameCallbacks: GameCallbacks | null = null;
  private mouseGridX = -1;
  private mouseGridY = -1;

  // Speech bubbles
  private speechBubbles: Map<string, { text: string; timer: number; alpha: number }> = new Map();

  constructor(canvas: HTMLCanvasElement, config: GameConfig, onAssetsLoaded?: () => void) {
    this.canvas = canvas;
    this.config = config;
    this.ctx = canvas.getContext('2d')!;
    this.zoom = config.tileSize / 16;
    this.onAssetsLoaded = onAssetsLoaded;

    canvas.width = config.gridWidth * config.tileSize;
    canvas.height = config.gridHeight * config.tileSize;
    canvas.style.imageRendering = 'pixelated';

    this.canvas.addEventListener('mousemove', this.handleMouseMove);
    this.canvas.addEventListener('mousedown', this.handleMouseDown);
    this.canvas.addEventListener('mouseup', this.handleMouseUp);
    this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
    this.canvas.addEventListener('contextmenu', this.handleContextMenu);
    // Character click (non-editor mode)
    this.canvas.addEventListener('click', this.handleClick);
  }

  async init(signal?: AbortSignal) {
    await this.loadAssets(signal);
    this.rebuildObstacles();
    this.spawnDemoAgents();
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
    } catch (err) {
      console.error('[GameEngine] Asset load failed:', err);
      try {
        this.characters_sprites = await loadCharacters(undefined, signal);
        this.assetsLoaded = true;
      } catch {}
    }
  }

  start() {
    this.running = true;
    this.lastTime = performance.now();
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    this.canvas.removeEventListener('mousemove', this.handleMouseMove);
    this.canvas.removeEventListener('mousedown', this.handleMouseDown);
    this.canvas.removeEventListener('mouseup', this.handleMouseUp);
    this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
    this.canvas.removeEventListener('click', this.handleClick);
  }

  private loop = () => {
    if (!this.running) return;
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    this.update(dt, now);
    this.render();
    this.animFrameId = requestAnimationFrame(this.loop);
  };

  // ── Obstacle map ─────────────────────────────────────

  private rebuildObstacles() {
    const furnitureRects = this.placedFurniture.map(f => {
      const sprite = this.furniture.get(f.type);
      const fw = sprite ? Math.ceil(sprite.width / 16) : 2;
      const fh = sprite ? Math.ceil(sprite.height / 16) : 1;
      return { x: f.x, y: f.y, w: fw, h: fh };
    });
    this.obstacleGrid = buildObstacleMap(this.config.gridWidth, this.config.gridHeight, furnitureRects);
    this.obstacleDirty = false;
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

  private update(dt: number, now: number) {
    for (const char of this.characters.values()) {
      // Sub-agent lifecycle
      if (char.isSubAgent) {
        const age = now - char.spawnTime;
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

      // State-change sound triggers
      if (char.stateJustChanged) {
        char.stateJustChanged = false;
        if (char.state === 'typing' || char.state === 'running_command') {
          sfx.typingBatch(3);
        } else if (char.state === 'waiting_input') {
          sfx.notify();
        } else if (char.state === 'error') {
          sfx.error();
        }
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

    ctx.fillStyle = '#0f0f23';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.renderFloor(gridWidth, gridHeight, tileSize, zoom);
    this.renderWalls(gridWidth, gridHeight, tileSize);
    this.renderFurniture(tileSize, zoom);
    this.renderCharacters(tileSize, zoom);
    this.renderSpeechBubbles(tileSize);

    if (this.editorMode) this.renderEditorOverlay(tileSize);
  }

  private renderFloor(gridW: number, gridH: number, tileSize: number, zoom: number) {
    const { ctx, floors } = this;
    const hasFloor = floors.length > 0 && this.assetsLoaded;
    for (let row = 0; row < gridH; row++) {
      for (let col = 0; col < gridW; col++) {
        const px = col * tileSize, py = row * tileSize;
        if (hasFloor) {
          const floor = floors[((col + row) % 2 === 0 ? 0 : 1) % floors.length];
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(floor.canvas, px, py, tileSize, tileSize);
        } else {
          ctx.fillStyle = (col + row) % 2 === 0 ? '#1a1a2e' : '#1e1e3a';
          ctx.fillRect(px, py, tileSize, tileSize);
        }
      }
    }
  }

  private renderWalls(gridW: number, gridH: number, tileSize: number) {
    const { ctx } = this;
    ctx.fillStyle = '#0f3460';
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
    // Sort by Y for depth (characters lower on screen render on top)
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

    ctx.save();

    // Sub-agent transparency
    if (char.isSubAgent && char.fadeAlpha < 1) {
      ctx.globalAlpha = char.fadeAlpha;
    }

    // Spawn glow effect for new sub-agents
    if (char.isSubAgent && (performance.now() - char.spawnTime) < 1000) {
      const glowAlpha = 1 - (performance.now() - char.spawnTime) / 1000;
      ctx.fillStyle = `rgba(78, 204, 163, ${glowAlpha * 0.4})`;
      ctx.beginPath();
      ctx.arc(px + tileSize / 2, py + tileSize / 2, tileSize, 0, Math.PI * 2);
      ctx.fill();
    }

    const sprites = this.characters_sprites;
    if (sprites == null || sprites.length === 0) {
      this.renderPlaceholderCharacter(char, px, py, tileSize);
    } else {
      const sprite = sprites[char.paletteIndex % sprites.length];
      if (!sprite) { this.renderPlaceholderCharacter(char, px, py, tileSize); }
      else {
        const frameCanvas = getSpriteFrame(sprite, animState, char.direction, char.animFrame);
        if (!frameCanvas) { this.renderPlaceholderCharacter(char, px, py, tileSize); }
        else {
          const scale = char.isSubAgent ? 1.5 : 2;
          const spriteW = 16 * scale, spriteH = 32 * scale;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(frameCanvas, px + (tileSize - spriteW) / 2, py + tileSize - spriteH, spriteW, spriteH);
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

    // Activity icon
    if (!char.isSubAgent) {
      const icon = this.getActivityIcon(char.state);
      if (icon) { ctx.font = `${tileSize * 0.45}px sans-serif`; ctx.fillText(icon, px + tileSize * 0.15, py - tileSize * 0.15); }
    }

    ctx.restore();
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

  private screenToGrid(e: MouseEvent): { gridX: number; gridY: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      gridX: Math.floor((e.clientX - rect.left) * scaleX / this.config.tileSize),
      gridY: Math.floor((e.clientY - rect.top) * scaleY / this.config.tileSize),
    };
  }

  private findFurnitureAt(gridX: number, gridY: number): PlacedFurniture | null {
    for (let i = this.placedFurniture.length - 1; i >= 0; i--) {
      const f = this.placedFurniture[i];
      const sprite = this.furniture.get(f.type);
      const fw = sprite ? Math.ceil(sprite.width / 16) : 2;
      const fh = sprite ? Math.ceil(sprite.height / 16) : 1;
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
    const { gridX, gridY } = this.screenToGrid(e);
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
      this.canvas.style.cursor = this.selectedFurnitureType
        ? 'crosshair'
        : this.findFurnitureAt(gridX, gridY)
          ? (this.dragging ? 'grabbing' : 'grab')
          : 'default';
    } else {
      // Non-editor: pointer on character hover
      this.canvas.style.cursor = this.findCharacterAt(gridX, gridY) ? 'pointer' : 'default';
    }
  };

  private handleMouseDown = (e: MouseEvent) => {
    if (!this.editorMode) return;
    const { gridX, gridY } = this.screenToGrid(e);
    if (e.button === 0) {
      if (this.selectedFurnitureType) {
        this.editorCallbacks?.onPlaceFurniture(this.selectedFurnitureType, gridX, gridY);
        sfx.place();
        return;
      }
      const hit = this.findFurnitureAt(gridX, gridY);
      if (hit) {
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
      const { gridX, gridY } = this.screenToGrid(e);
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
    const { gridX, gridY } = this.screenToGrid(e);
    const hit = this.findFurnitureAt(gridX, gridY);
    if (hit) hit.rotation = ((hit.rotation || 0) + 90) % 360;
  };

  private handleClick = (e: MouseEvent) => {
    if (this.editorMode) return;
    const { gridX, gridY } = this.screenToGrid(e);
    const charId = this.findCharacterAt(gridX, gridY);
    if (charId && !charId.startsWith('sub-')) {
      this.gameCallbacks?.onCharacterClick(charId);
    }
  };

  // ── Helpers ──────────────────────────────────────────

  private activityToAnimState(state: string, isWalking: boolean): AnimState {
    if (isWalking) return 'walk';
    switch (state) {
      case 'typing': case 'running_command': return 'typing';
      case 'reading': case 'thinking': return 'reading';
      default: return 'typing';
    }
  }

  private getActivityIcon(state: string): string {
    const icons: Record<string, string> = {
      typing: '⌨', reading: '📖', thinking: '💭',
      waiting_input: '💬', running_command: '⚡', error: '❌',
    };
    return icons[state] || '';
  }

  // ── Public API ──────────────────────────────────────────

  addCharacter(data: CharacterData) {
    const paletteIndex = AGENT_PALETTES[data.id] ?? Math.floor(Math.random() * 6);
    this.characters.set(data.id, {
      ...data, targetX: data.x, targetY: data.y,
      animFrame: 0, animTimer: 0, direction: 'down', paletteIndex,
      path: [], pathIndex: 0,
      spawnTime: performance.now(), fadeAlpha: 1, dying: false,
      lastFootstepTile: -1, typingSoundTimer: 0, stateJustChanged: false,
    });
  }

  removeCharacter(id: string) { this.characters.delete(id); }

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
    if (updates.state && ['typing', 'reading', 'thinking', 'running_command'].includes(updates.state)) {
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

    // Update speech bubble for waiting_input state
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
    const sx = Math.round(parent.x + Math.cos(offsetAngle) * offsetDist);
    const sy = Math.round(parent.y + Math.sin(offsetAngle) * offsetDist);

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
      spawnTime: performance.now(),
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
  setSelectedFurnitureType(type: string | null) { this.selectedFurnitureType = type; this.selectedFurnitureId = null; }
  setSelectedFurnitureId(id: string | null) { this.selectedFurnitureId = id; this.selectedFurnitureType = null; }

  setLayout(furniture: PlacedFurniture[], seats?: Record<string, { x: number; y: number }>) {
    this.placedFurniture = furniture;
    this.obstacleDirty = true;
    if (seats) {
      this.seats.clear();
      for (const [aid, pos] of Object.entries(seats)) this.seats.set(aid, pos);
    }
  }

  getPlacedFurniture(): PlacedFurniture[] { return [...this.placedFurniture]; }
}
