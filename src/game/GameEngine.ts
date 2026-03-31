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
  getSpriteFrame,
  getCachedCharacters,
  type LoadedCharacter,
  type LoadedFloor,
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

// Default seat positions for known agents
const DEFAULT_SEATS: Record<string, { x: number; y: number }> = {
  cybera: { x: 4, y: 5 },
  shodan: { x: 10, y: 5 },
  cyberlogis: { x: 16, y: 5 },
  descartes: { x: 4, y: 11 },
  sysauxilia: { x: 10, y: 11 },
};

// Assign distinct character palettes to known agents
const AGENT_PALETTES: Record<string, number> = {
  cybera: 0,
  shodan: 1,
  cyberlogis: 2,
  descartes: 3,
  sysauxilia: 4,
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
  private characters_sprites: LoadedCharacter[] = [];
  private floors: LoadedFloor[] = [];
  private zoom: number;

  constructor(canvas: HTMLCanvasElement, config: GameConfig) {
    this.canvas = canvas;
    this.config = config;
    this.ctx = canvas.getContext('2d')!;
    this.zoom = config.tileSize / 16; // base tile size is 16px (floor tiles)

    // Set canvas pixel dimensions
    canvas.width = config.gridWidth * config.tileSize;
    canvas.height = config.gridHeight * config.tileSize;

    // CSS scaling for crisp pixels
    canvas.style.imageRendering = 'pixelated';

    // Initialize default seats
    for (const [agentId, pos] of Object.entries(DEFAULT_SEATS)) {
      this.seats.set(agentId, pos);
    }

    // Start loading assets
    this.loadAssets();
  }

  private async loadAssets() {
    try {
      const { characters, floors } = await loadAllAssets();
      this.characters_sprites = characters;
      this.floors = floors;
      this.assetsLoaded = true;
      console.log(`Game engine: ${characters.length} character sprites, ${floors.length} floors loaded`);
    } catch (err) {
      console.error('Failed to load assets:', err);
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
    const { ctx, seats, assetsLoaded } = this;

    for (const [agentId, seat] of this.seats.entries()) {
      const px = seat.x * tileSize;
      const py = seat.y * tileSize;

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
  }

  private renderCharacter(char: Character, tileSize: number, zoom: number) {
    const { ctx, assetsLoaded, characters_sprites } = this;
    const px = char.x * tileSize;
    const py = char.y * tileSize;

    // Determine animation state
    const isWalking = Math.abs(char.targetX - char.x) > 0.1 || Math.abs(char.targetY - char.y) > 0.1;
    const animState: AnimState = this.activityToAnimState(char.state, isWalking);

    if (assetsLoaded && characters_sprites.length > 0) {
      // Render using actual sprite
      const paletteIdx = char.paletteIndex % characters_sprites.length;
      const sprite = characters_sprites[paletteIdx];
      const frameCanvas = getSpriteFrame(sprite, animState, char.direction, char.animFrame);

      // Scale sprite to tile size (sprite is 16×32, tile is 32×32)
      const scale = tileSize / 16; // 2x zoom
      const spriteW = 16 * scale;
      const spriteH = 32 * scale;

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        frameCanvas,
        px + (tileSize - spriteW) / 2,
        py + tileSize - spriteH,
        spriteW,
        spriteH,
      );
    } else {
      // Fallback: colored placeholder
      this.renderPlaceholderCharacter(char, px, py, tileSize);
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
