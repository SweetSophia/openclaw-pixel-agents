// Agent state types shared between server and client

export type AgentActivity = 
  | 'idle' 
  | 'thinking' 
  | 'typing' 
  | 'reading' 
  | 'running_command' 
  | 'waiting_input' 
  | 'sleeping'
  | 'error';

export interface AgentTokens {
  used: number;
  limit: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentState {
  /** Agent ID (e.g. "cybera", "shodan") */
  id: string;
  /** Display name */
  name: string;
  /** Current activity */
  activity: AgentActivity;
  /** Current model being used */
  model: string;
  /** Session key */
  sessionKey: string;
  /** Whether this agent has an active session */
  active: boolean;
  /** Timestamp of last activity */
  lastActivity: number;
  /** Token usage if available */
  tokens?: AgentTokens;
  /** Custom character sprite ID */
  characterSpriteId?: string;
  /** Whether pixel visualization is enabled for this agent */
  pixelEnabled: boolean;
  /** User-assigned tags for room routing and categorization */
  tags: string[];
  /** Current room ID (set by server based on tag routing) */
  roomId?: string;
  /** Sub-agents spawned by this agent */
  subAgents?: SubAgentInfo[];
  /** Last message sent by this agent (truncated) */
  lastMessage?: string;
  /** Uptime in seconds for this session */
  sessionUptime?: number;
}

export interface SubAgentInfo {
  id: string;
  name: string;
  task?: string;
  spawnedAt: number;
  status: 'running' | 'completed' | 'failed';
}

export interface OfficeLayout {
  /** Grid width in tiles */
  width: number;
  /** Grid height in tiles */
  height: number;
  /** Floor tile data */
  floors: Record<string, string>;  // "x,y" -> color
  /** Wall tile data */
  walls: Record<string, string>;   // "x,y" -> type
  /** Placed furniture */
  furniture: PlacedFurniture[];
  /** Agent seat assignments */
  seats: Record<string, { x: number; y: number }>;  // agentId -> position
}

export interface PlacedFurniture {
  id: string;
  type: string;       // e.g. "desk", "chair", "plant", "monitor"
  x: number;
  y: number;
  rotation: number;   // 0, 90, 180, 270
  state?: string;     // e.g. "on", "off"
}

export interface CharacterSprite {
  id: string;
  name: string;
  /** Base path to sprite sheet */
  spriteSheet: string;
  /** Animation frame count per direction */
  frames: number;
  /** Directions available */
  directions: ('up' | 'down' | 'left' | 'right')[];
}

export interface GatewayStatus {
  connected: boolean;
  agentCount: number;
  uptime: number;
  version: string;
}

// ── Tags & Rooms ───────────────────────────────────────

/** Preset tag categories for agent classification */
export type AgentTag =
  | 'coding'
  | 'research'
  | 'monitoring'
  | 'infrastructure'
  | 'orchestration'
  | 'creative'
  | 'analysis'
  | 'logic'
  | 'frontend'
  | 'media';

/** All available tags for the tag picker UI */
export const ALL_TAGS: AgentTag[] = [
  'coding', 'research', 'monitoring', 'infrastructure',
  'orchestration', 'creative', 'analysis', 'logic',
  'frontend', 'media',
];

/** Tag colors for UI badges */
export const TAG_COLORS: Record<AgentTag, string> = {
  coding: '#4ecca3',
  research: '#a78bfa',
  monitoring: '#fbbf24',
  infrastructure: '#6b7280',
  orchestration: '#f472b6',
  creative: '#fb923c',
  analysis: '#60a5fa',
  logic: '#34d399',
  frontend: '#c084fc',
  media: '#f87171',
};

/** A room definition — agents are routed to rooms by tag */
export interface Room {
  /** Unique room ID (e.g. "office", "lab", "server-room") */
  id: string;
  /** Display name */
  name: string;
  /** Primary tag — agents with this tag route here */
  primaryTag: AgentTag;
  /** Optional secondary tags — agents with these also route here */
  secondaryTags?: AgentTag[];
  /** Room background color (fallback if no floor tiles) */
  backgroundColor?: string;
  /** Icon for the room switcher */
  icon: string;
  /** Sort order (lower = first) */
  order: number;
}

/** Default room definitions */
export const DEFAULT_ROOMS: Room[] = [
  { id: 'office', name: 'Office', primaryTag: 'coding', secondaryTags: ['frontend', 'logic'], icon: '🏢', order: 0 },
  { id: 'lab', name: 'Research Lab', primaryTag: 'research', secondaryTags: ['analysis'], icon: '🔬', order: 1 },
  { id: 'server-room', name: 'Server Room', primaryTag: 'infrastructure', secondaryTags: ['monitoring'], icon: '🖥️', order: 2 },
  { id: 'lounge', name: 'Lounge', primaryTag: 'creative', secondaryTags: ['orchestration', 'media'], icon: '🎨', order: 3 },
];

// ── Message Ticker ─────────────────────────────────────

export interface TickerMessage {
  /** Unique message ID (from __openclaw.id or synthetic) */
  id: string;
  /** Agent ID that sent/received this message */
  agentId: string;
  /** Agent display name */
  agentName: string;
  /** 'user' or 'assistant' */
  role: 'user' | 'assistant';
  /** Truncated text content (max ~150 chars) */
  text: string;
  /** Timestamp (ms epoch) */
  timestamp: number;
}
