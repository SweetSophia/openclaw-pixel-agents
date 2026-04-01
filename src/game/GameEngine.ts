/**
 * PixelOffice Game Engine
 *
 * Canvas-based rendering engine for the pixel office.
 * Handles tile rendering, character sprites, animation, pathfinding.
 *
 * Sprite layout per character (112×96 PNG):
 *   Row 0: down direction (7 frames × 16px wide × 32px tall)
 *   Row 1: up direction
 *   Row 2: right direction (left = right flipped)
 *
 * Frame mapping (per direction):
 *   0-2: walk (3 unique frames, ping-pong: 0→1→2→1)
 *   3-4: typing (2 frames)
 *   5-6: reading (2 frames)
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
}

interface Character extends CharacterData {
  targetX: number;
  targetY: number;
  animFrame: number;
  animTimer: number;
  direction: Direction;
  paletteIndex: number; // which character sprite to use (0-5)
}

// Default seat positions for known agents (2 rows of 4 desks)
const DEFAULT_SEATS: Record<string, { x: number; y: number }> = {
  cybera: { x: 3, y: 4 },
  shodan: { x: 9, y: 4 },
  cyberlogis: { x: 15, y: 4 },
  descartes: { x: 20, y: 4 },
  chi: { x: 3, y: 10 },
  cylena: { x: 9, y: 10 },
  sysauxilia: { x: 15, y: 10 },
  miku: { x: 20, y: 10 },
};

// Assign distinct character palettes to known agents
const AGENT_PALETTES: Record<string, number> = {
  cybera: 0,
  shodan: 1,
  cyberlogis: 2,
  descartes: 3,
  chi: 4,
  cylena: 5,
  sysauxilia: 3,
  miku: 0,
};

export class GameEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: GameConfig;
  private characters: Map<string, Character> = new Map();
  private seats: Map<string, { x: number; y: number }> = new Map();
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

  constructor(canvas: HTMLCanvasElement, config: GameConfig, onAssetsLoaded?: () => void) {
    this.canvas = canvas;
    this.config = config;
    this.ctx = canvas.getContext('2d')!;
    this.zoom = config.tileSize / 16;
    this.onAssetsLoaded = onAssetsLoaded;

    // Set canvas pixel dimensions
    canvas.width = config.gridWidth * config.tileSize;
    canvas.height = config.gridHeight * config.tileSize;
    canvas.style.imageRendering = 'pixelated';

    // Initialize default seats
    for (const [agentId, pos] of Object.entries(DEFAULT_SEATS)) {
      this.seats.set(agentId, pos);
    }
  }

  /** Call after construction. Loads assets and spawns demo agents. */
  async init(signal?: AbortSignal) {
    await this.loadAssets(signal);
    this.spawnDemoAgents();
  }

  /** Spawn demo agents for testing without a live gateway */
  private spawnDemoAgents() {
    const demoAgents = [
      { id: 'cybera', name: 'Cybera', state: 'typing' },
      { id: 'shodan', name: 'Shodan', state: 'thinking' },
      { id: 'cyberlogis', name: 'Cyberlogis', state: 'reading' },
      { id: 'descartes', name: 'Descartes', state: 'idle' },
      { id: 'chi', name: 'Chi', state: 'waiting_input' },
      { id: 'cylena', name: 'Cylena', state: 'sleeping' },
      { id: 'sysauxilia', name: 'Sysauxilia', state: 'idle' },
      { id: 'miku', name: 'Miku', state: 'reading' },
    ];

    for (const agent of demoAgents) {
      const seat = this.assignSeat(agent.id);
      this.addCharacter({
        id: agent.id,
        name: agent.name,
        x: seat.x,
        y: seat.y + 1,
        state: agent.state,
        spriteId: undefined,
      });
    }
  }

  private async loadAssets(signal?: AbortSignal) {
    try {
      console.log('[GameEngine] Loading assets...');
      const { characters, floors, furniture } = await loadAllAssets(signal);
      this.characters_sprites = characters;
      this.floors = floors;
      this.furniture = furniture;
      this.assetsLoaded = true;
      console.log(`[GameEngine] Assets loaded: ${characters.length} characters, ${floors.length} floors, ${furniture.size} furniture types`);
    } catch (err) {
      console.error('[GameEngine] Failed to load assets:', err);
      // Try to load just characters for a better fallback
      try {
        const chars = await loadCharacters(undefined, signal);
        this.characters_sprites = chars;
        this.assetsLoaded = true;
        console.log(`[GameEngine] Partial load: ${chars.length} characters (no floors/furniture)`);
      } catch (err2) {
        console.error('[GameEngine] Even character loading failed:', err2);
      }
    }
  }

  start() {
    this.running = true;
    this.lastTime = performance.now();
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
    }
  }

  private loop = () => {
    if (!this.running) return;

    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    this.update(dt);
    this.render();

    this.animFrameId = requestAnimationFrame(this.loop);
  };

  private update(dt: number) {
    for (const char of this.characters.values()) {
      // Animation timer
      char.animTimer += dt;

      // Update animation frame based on state
      const isWalking = Math.abs(char.targetX - char.x) > 0.05 || Math.abs(char.targetY - char.y) > 0.05;
      const frameDuration = isWalking ? 0.15 : 0.25;

      if (char.animTimer >= frameDuration) {
        char.animTimer = 0;
        char.animFrame++;
      }

      // Move toward target
      const dx = char.targetX - char.x;
      const dy = char.targetY - char.y;
      const speed = 3;

      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
        char.x += Math.sign(dx) * Math.min(speed * dt, Math.abs(dx));
        char.y += Math.sign(dy) * Math.min(speed * dt, Math.abs(dy));

        if (Math.abs(dx) > Math.abs(dy)) {
          char.direction = dx > 0 ? 'right' : 'left';
        } else {
          char.direction = dy > 0 ? 'down' : 'up';
        }
      }
    }
  }

  private render() {
    const { ctx, config } = this;

    // One-time diagnostic (log once, then replace this with a no-op)
    if (!this._renderDiagLogged) {
      this._renderDiagLogged = true;
      console.log(`[GameEngine DIAG] render() called. chars=${this.characters.size} assetsLoaded=${this.assetsLoaded} sprites=${this.characters_sprites?.length ?? 'null'}`);
      for (const [id, c] of this.characters.entries()) {
        console.log(`[GameEngine DIAG] char "${id}": x=${c.x.toFixed(1)} y=${c.y.toFixed(1)} palette=${c.paletteIndex} state=${c.state}`);
      }
    }

    const { tileSize, gridWidth, gridHeight } = config;
    const zoom = this.zoom;

    // Clear canvas
    ctx.fillStyle = '#0f0f23';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw floor
    this.renderFloor(gridWidth, gridHeight, tileSize, zoom);

    // Draw walls
    this.renderWalls(gridWidth, gridHeight, tileSize);

    // Draw desks and furniture
    this.renderFurniture(tileSize, zoom);

    // Draw characters
    for (const char of this.characters.values()) {
      this.renderCharacter(char, tileSize, zoom);
    }
  }

  private renderFloor(gridW: number, gridH: number, tileSize: number, zoom: number) {
    const { ctx, floors } = this;
    const hasFloor = floors.length > 0 && this.assetsLoaded;

    for (let row = 0; row < gridH; row++) {
      for (let col = 0; col < gridW; col++) {
        const px = col * tileSize;
        const py = row * tileSize;

        if (hasFloor) {
          // Use actual floor tile sprites (checkerboard with floor_0 and floor_1)
          const floorIdx = (col + row) % 2 === 0 ? 0 : 1;
          const floor = floors[floorIdx % floors.length];
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(floor.canvas, px, py, tileSize, tileSize);
        } else {
          // Fallback: colored rectangles
          ctx.fillStyle = (col + row) % 2 === 0 ? '#1a1a2e' : '#1e1e3a';
          ctx.fillRect(px, py, tileSize, tileSize);
        }
      }
    }
  }

  private renderWalls(gridW: number, gridH: number, tileSize: number) {
    const { ctx } = this;
    ctx.fillStyle = '#0f3460';

    // Top wall
    for (let col = 0; col < gridW; col++) {
      ctx.fillRect(col * tileSize, 0, tileSize, tileSize);
    }
    // Bottom wall
    for (let col = 0; col < gridW; col++) {
      ctx.fillRect(col * tileSize, (gridH - 1) * tileSize, tileSize, tileSize);
    }
    // Side walls
    for (let row = 1; row < gridH - 1; row++) {
      ctx.fillRect(0, row * tileSize, tileSize, tileSize);
      ctx.fillRect((gridW - 1) * tileSize, row * tileSize, tileSize, tileSize);
    }
  }

  private renderFurniture(tileSize: number, zoom: number) {
    const { ctx, seats, assetsLoaded, furniture } = this;

    // Pre-rendered office furniture layout (type, grid x, grid y)
    // Placed relative to each agent's desk position
    const officeFurniture: Array<{ type: string; offsetX: number; offsetY: number }> = [
      // Shared office furniture placed in fixed positions
      { type: 'LARGE_PLANT', offsetX: 1, offsetY: 1 },
      { type: 'COFFEE', offsetX: 22, offsetY: 1 },
      { type: 'WHITEBOARD', offsetX: 11, offsetY: 0 },
      { type: 'BOOKSHELF', offsetX: 1, offsetY: 8 },
      { type: 'LARGE_PAINTING', offsetX: 22, offsetY: 8 },
    ];

    // Draw shared office furniture
    for (const item of officeFurniture) {
      const px = item.offsetX * tileSize;
      const py = item.offsetY * tileSize;
      this.drawFurnitureItem(item.type, px, py, tileSize, zoom);
    }

    // Draw per-agent desk setups
    for (const [agentId, seat] of this.seats.entries()) {
      const px = seat.x * tileSize;
      const py = seat.y * tileSize;

      // Try to draw actual desk + PC sprites
      const deskItem = furniture.get('DESK');
      const pcItem = furniture.get('PC');
      const chairItem = furniture.get('CUSHIONED_CHAIR') || furniture.get('WOODEN_CHAIR');

      const hasSprites = assetsLoaded && (deskItem || pcItem);

      if (hasSprites) {
        // Draw desk sprite
        if (deskItem) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(
            deskItem.canvas,
            px,
            py - deskItem.height * zoom,
            deskItem.width * zoom,
            deskItem.height * zoom,
          );
        }

        // Draw PC on desk — animated if agent is active
        if (pcItem) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(
            pcItem.canvas,
            px + tileSize * 0.3,
            py - pcItem.height * zoom - (deskItem?.height ?? 0) * zoom * 0.5,
            pcItem.width * zoom,
            pcItem.height * zoom,
          );
        }

        // Draw chair
        if (chairItem) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(
            chairItem.canvas,
            px + tileSize * 0.2,
            py + tileSize * 0.1,
            chairItem.width * zoom,
            chairItem.height * zoom,
          );
        }
      } else {
        // Fallback: colored rectangles (original behavior)
        this.renderFallbackDesk(agentId, px, py, tileSize);
      }
    }
  }

  /** Draw a single furniture item from sprites or fallback */
  private drawFurnitureItem(type: string, px: number, py: number, tileSize: number, zoom: number) {
    const { ctx, furniture, assetsLoaded } = this;
    const item = furniture.get(type);

    if (assetsLoaded && item) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(item.canvas, px, py, item.width * zoom, item.height * zoom);
    } else {
      // Fallback: colored placeholder
      const colors: Record<string, string> = {
        LARGE_PLANT: '#2d6a4f',
        COFFEE: '#6f4e37',
        WHITEBOARD: '#e8e8e8',
        BOOKSHELF: '#8b4513',
        LARGE_PAINTING: '#daa520',
      };
      ctx.fillStyle = colors[type] || '#533483';
      ctx.fillRect(px, py, tileSize * 2, tileSize);
    }
  }

  /** Fallback desk rendering with colored rectangles */
  private renderFallbackDesk(agentId: string, px: number, py: number, tileSize: number) {
    const { ctx } = this;

    // Desk surface
    ctx.fillStyle = '#533483';
    ctx.fillRect(px + 2, py - tileSize * 0.4, tileSize * 1.8, tileSize * 0.5);

    // PC monitor
    ctx.fillStyle = '#0f3460';
    ctx.fillRect(px + tileSize * 0.3, py - tileSize * 0.6, tileSize * 0.6, tileSize * 0.4);

    // Monitor screen glow when agent is active
    const char = this.characters.get(agentId);
    if (char && char.state !== 'sleeping' && char.state !== 'idle') {
      ctx.fillStyle = char.state === 'error' ? '#e9456040' : '#4ecca340';
      ctx.fillRect(
        px + tileSize * 0.35,
        py - tileSize * 0.55,
        tileSize * 0.5,
        tileSize * 0.3,
      );
    }

    // Chair below desk
    ctx.fillStyle = '#2d6a4f';
    ctx.fillRect(px + tileSize * 0.2, py + tileSize * 0.1, tileSize * 0.6, tileSize * 0.5);
  }

  private renderCharacter(char: Character, tileSize: number, zoom: number) {
    const { ctx } = this;
    const px = char.x * tileSize;
    const py = char.y * tileSize;

    // Determine animation state
    const isWalking = Math.abs(char.targetX - char.x) > 0.1 || Math.abs(char.targetY - char.y) > 0.1;
    const animState: AnimState = this.activityToAnimState(char.state, isWalking);

    // Try to render with sprites — log once per character
    const sprites = this.characters_sprites;
    const hasSprites = sprites != null && sprites.length > 0;
    
    if (!hasSprites) {
      // No sprites loaded yet — render placeholder
      this.renderPlaceholderCharacter(char, px, py, tileSize);
    } else {
      const paletteIdx = char.paletteIndex % sprites.length;
      const sprite = sprites[paletteIdx];
      
      if (!sprite) {
        console.error(`[GameEngine] No sprite for palette index ${paletteIdx}`);
        this.renderPlaceholderCharacter(char, px, py, tileSize);
        return;
      }
      
      const frameCanvas = getSpriteFrame(sprite, animState, char.direction, char.animFrame);
      
      if (!frameCanvas) {
        console.error(`[GameEngine] No frame canvas returned`);
        this.renderPlaceholderCharacter(char, px, py, tileSize);
        return;
      }

      const frameW = 16;
      const frameH = 32;
      const scale = 2;
      const spriteW = frameW * scale;
      const spriteH = frameH * scale;

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        frameCanvas,
        px + (tileSize - spriteW) / 2,
        py + tileSize - spriteH,
        spriteW,
        spriteH,
      );
    }

    // Name label below character
    ctx.font = `bold ${Math.max(8, tileSize * 0.28)}px monospace`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(char.name, px + tileSize / 2, py + tileSize + tileSize * 0.35);
    ctx.textAlign = 'left';

    // Activity icon above head
    const icon = this.getActivityIcon(char.state);
    if (icon) {
      ctx.font = `${tileSize * 0.45}px sans-serif`;
      ctx.fillText(icon, px + tileSize * 0.15, py - tileSize * 0.15);
    }
  }

  private renderPlaceholderCharacter(
    char: Character,
    px: number,
    py: number,
    tileSize: number,
  ) {
    const { ctx } = this;
    const bodyColors: Record<string, string> = {
      cybera: '#e94560',
      shodan: '#4ecca3',
      cyberlogis: '#ffc107',
      descartes: '#17a2b8',
      sysauxilia: '#6c757d',
      chi: '#ff6b9d',
      cylena: '#a78bfa',
      miku: '#39ff14',
    };
    const color = bodyColors[char.id] || '#e94560';

    // Body
    const bodyW = tileSize * 0.5;
    const bodyH = tileSize * 0.7;
    ctx.fillStyle = color;
    ctx.fillRect(px + (tileSize - bodyW) / 2, py + tileSize - bodyH, bodyW, bodyH);

    // Head
    const headSize = tileSize * 0.4;
    ctx.fillStyle = '#f0d0a0';
    ctx.fillRect(
      px + (tileSize - headSize) / 2,
      py + tileSize - bodyH - headSize * 0.6,
      headSize,
      headSize,
    );
  }

  private activityToAnimState(state: string, isWalking: boolean): AnimState {
    if (isWalking) return 'walk';
    switch (state) {
      case 'typing':
      case 'running_command':
        return 'typing';
      case 'reading':
      case 'thinking':
        return 'reading';
      default:
        return 'typing'; // default seated pose
    }
  }

  private getActivityIcon(state: string): string {
    const icons: Record<string, string> = {
      typing: '⌨',
      reading: '📖',
      thinking: '💭',
      waiting_input: '💬',
      running_command: '⚡',
      error: '❌',
    };
    return icons[state] || '';
  }

  // ── Public API ──────────────────────────────────────────

  addCharacter(data: CharacterData) {
    const paletteIndex = AGENT_PALETTES[data.id] ?? Math.floor(Math.random() * 6);
    this.characters.set(data.id, {
      ...data,
      targetX: data.x,
      targetY: data.y,
      animFrame: 0,
      animTimer: 0,
      direction: 'down',
      paletteIndex,
    });
  }

  removeCharacter(id: string) {
    this.characters.delete(id);
  }

  updateCharacter(id: string, updates: Partial<CharacterData>) {
    const char = this.characters.get(id);
    if (!char) return;
    Object.assign(char, updates);

    // Move to seat when working
    if (updates.state && ['typing', 'reading', 'thinking', 'running_command'].includes(updates.state)) {
      const seat = this.seats.get(id);
      if (seat) {
        char.targetX = seat.x;
        char.targetY = seat.y;
      }
    }
  }

  getCharacterIds(): string[] {
    return Array.from(this.characters.keys());
  }

  assignSeat(agentId: string): { x: number; y: number } {
    if (this.seats.has(agentId)) {
      return this.seats.get(agentId)!;
    }

    const usedPositions = new Set(
      Array.from(this.seats.values()).map(p => `${p.x},${p.y}`),
    );

    for (let y = 3; y < this.config.gridHeight - 2; y += 3) {
      for (let x = 3; x < this.config.gridWidth - 3; x += 4) {
        if (!usedPositions.has(`${x},${y}`)) {
          this.seats.set(agentId, { x, y });
          return { x, y };
        }
      }
    }

    const fallback = { x: Math.floor(this.config.gridWidth / 2), y: Math.floor(this.config.gridHeight / 2) };
    this.seats.set(agentId, fallback);
    return fallback;
  }
}
