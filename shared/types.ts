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
