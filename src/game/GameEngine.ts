/**
 * PixelOffice Game Engine
 * 
 * Lightweight canvas-based rendering engine for the pixel office.
 * Handles: tile rendering, character sprites, pathfinding, animation loops.
 */

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
  direction: 'up' | 'down' | 'left' | 'right';
  speechBubble?: string;
}

// Default office layout: floor colors and furniture positions
const DEFAULT_SEATS: Record<string, { x: number; y: number }> = {
  cybera: { x: 4, y: 4 },
  shodan: { x: 10, y: 4 },
  cyberlogis: { x: 16, y: 4 },
  descartes: { x: 4, y: 10 },
  sysauxilia: { x: 10, y: 10 },
};

// Simple colors for different floor zones
const FLOOR_COLOR = '#1a1a2e';
const WALL_COLOR = '#0f3460';
const DESK_COLOR = '#533483';
const CHAIR_COLOR = '#4ecca3';

export class GameEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: GameConfig;
  private characters: Map<string, Character> = new Map();
  private seats: Map<string, { x: number; y: number }> = new Map();
  private running = false;
  private animFrameId: number = 0;
  private lastTime = 0;

  constructor(canvas: HTMLCanvasElement, config: GameConfig) {
    this.canvas = canvas;
    this.config = config;
    this.ctx = canvas.getContext('2d')!;

    // Set canvas size
    canvas.width = config.gridWidth * config.tileSize;
    canvas.height = config.gridHeight * config.tileSize;

    // Initialize default seats
    for (const [agentId, pos] of Object.entries(DEFAULT_SEATS)) {
      this.seats.set(agentId, pos);
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
      // Animate sprite frame
      char.animTimer += dt;
      if (char.animTimer > 0.2) {
        char.animTimer = 0;
        char.animFrame = (char.animFrame + 1) % 4;
      }

      // Move toward target if not there
      const dx = char.targetX - char.x;
      const dy = char.targetY - char.y;
      const speed = 3; // tiles per second

      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
        char.x += Math.sign(dx) * Math.min(speed * dt, Math.abs(dx));
        char.y += Math.sign(dy) * Math.min(speed * dt, Math.abs(dy));

        // Update direction
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

    // Clear
    ctx.fillStyle = FLOOR_COLOR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw floor grid
    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        const px = x * tileSize;
        const py = y * tileSize;

        // Floor tile pattern
        if ((x + y) % 2 === 0) {
          ctx.fillStyle = '#1e1e3a';
          ctx.fillRect(px, py, tileSize, tileSize);
        }

        // Grid lines (subtle)
        ctx.strokeStyle = '#0f0f23';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(px, py, tileSize, tileSize);
      }
    }

    // Draw walls (top and bottom rows)
    ctx.fillStyle = WALL_COLOR;
    for (let x = 0; x < gridWidth; x++) {
      ctx.fillRect(x * tileSize, 0, tileSize, tileSize);
      ctx.fillRect(x * tileSize, (gridHeight - 1) * tileSize, tileSize, tileSize);
    }

    // Draw desks at seat positions
    for (const [agentId, seat] of this.seats.entries()) {
      const char = this.characters.get(agentId);

      // Desk
      ctx.fillStyle = DESK_COLOR;
      ctx.fillRect(
        seat.x * tileSize + 2,
        seat.y * tileSize - tileSize + 2,
        tileSize * 2 - 4,
        tileSize - 4
      );

      // Monitor on desk
      ctx.fillStyle = '#0f3460';
      ctx.fillRect(
        seat.x * tileSize + 8,
        seat.y * tileSize - tileSize + 6,
        tileSize - 16,
        tileSize - 16
      );

      // Screen glow if agent is active
      if (char && char.state !== 'sleeping' && char.state !== 'idle') {
        ctx.fillStyle = '#4ecca340';
        ctx.fillRect(
          seat.x * tileSize + 10,
          seat.y * tileSize - tileSize + 8,
          tileSize - 20,
          tileSize - 20
        );
      }

      // Chair
      ctx.fillStyle = CHAIR_COLOR;
      ctx.fillRect(
        seat.x * tileSize + 8,
        seat.y * tileSize + 4,
        tileSize - 16,
        tileSize - 8
      );
    }

    // Draw characters
    for (const char of this.characters.values()) {
      this.renderCharacter(char);
    }
  }

  private renderCharacter(char: Character) {
    const { ctx, config } = this;
    const { tileSize } = config;

    const px = char.x * tileSize;
    const py = char.y * tileSize;

    // Character body (placeholder colored rectangle until sprites are loaded)
    const bodyColors: Record<string, string> = {
      cybera: '#e94560',
      shodan: '#4ecca3',
      cyberlogis: '#ffc107',
      descartes: '#17a2b8',
      sysauxilia: '#6c757d',
    };

    const color = bodyColors[char.id] || '#e94560';

    // Body
    ctx.fillStyle = color;
    const bodyW = tileSize * 0.5;
    const bodyH = tileSize * 0.7;
    const bodyX = px + (tileSize - bodyW) / 2;
    const bodyY = py + tileSize - bodyH;
    ctx.fillRect(bodyX, bodyY, bodyW, bodyH);

    // Head
    const headSize = tileSize * 0.4;
    ctx.fillStyle = '#f0d0a0';
    ctx.fillRect(
      px + (tileSize - headSize) / 2,
      bodyY - headSize * 0.6,
      headSize,
      headSize
    );

    // Activity indicator above head
    const activityIcons: Record<string, string> = {
      typing: '⌨',
      reading: '📖',
      thinking: '💭',
      waiting: '💬',
      running_command: '⚡',
      error: '❌',
    };

    const icon = activityIcons[char.state];
    if (icon) {
      ctx.font = `${tileSize * 0.4}px sans-serif`;
      ctx.fillText(icon, px + tileSize * 0.2, bodyY - headSize * 0.8);
    }

    // Name label
    ctx.font = `bold ${tileSize * 0.3}px monospace`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(char.name, px + tileSize / 2, py + tileSize + tileSize * 0.3);
    ctx.textAlign = 'left';

    // Typing animation: small bouncing dots
    if (char.state === 'typing' && char.animFrame % 2 === 0) {
      ctx.fillStyle = '#4ecca3';
      ctx.fillRect(px + 4, py - 4, 2, 2);
      ctx.fillRect(px + 8, py - 6, 2, 2);
      ctx.fillRect(px + 12, py - 3, 2, 2);
    }
  }

  // Public API

  addCharacter(data: CharacterData) {
    this.characters.set(data.id, {
      ...data,
      targetX: data.x,
      targetY: data.y,
      animFrame: 0,
      animTimer: 0,
      direction: 'down',
    });
  }

  removeCharacter(id: string) {
    this.characters.delete(id);
  }

  updateCharacter(id: string, updates: Partial<CharacterData>) {
    const char = this.characters.get(id);
    if (!char) return;
    Object.assign(char, updates);

    // If activity changed to typing/reading, move to seat
    if (updates.state && (updates.state === 'typing' || updates.state === 'reading')) {
      const seat = this.seats.get(id);
      if (seat) {
        char.targetX = seat.x;
        char.targetY = seat.y + 1; // Sit in chair (below desk)
      }
    }

    // Speech bubble for waiting state
    if (updates.state === 'waiting_input') {
      char.speechBubble = '...';
    } else {
      char.speechBubble = undefined;
    }
  }

  getCharacterIds(): string[] {
    return Array.from(this.characters.keys());
  }

  assignSeat(agentId: string): { x: number; y: number } {
    // Use predefined seat if available, otherwise find an empty spot
    if (this.seats.has(agentId)) {
      return this.seats.get(agentId)!;
    }

    // Find next available seat position
    const usedPositions = new Set(
      Array.from(this.seats.values()).map(p => `${p.x},${p.y}`)
    );

    for (let y = 3; y < this.config.gridHeight - 2; y += 3) {
      for (let x = 3; x < this.config.gridWidth - 3; x += 4) {
        if (!usedPositions.has(`${x},${y}`)) {
          this.seats.set(agentId, { x, y });
          return { x, y };
        }
      }
    }

    // Fallback
    const fallback = { x: Math.floor(this.config.gridWidth / 2), y: Math.floor(this.config.gridHeight / 2) };
    this.seats.set(agentId, fallback);
    return fallback;
  }
}
