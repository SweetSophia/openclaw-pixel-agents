export interface AgentRosterEntry { id: string; name: string }
export interface AgentRosterDocument { version: 1; agents: AgentRosterEntry[] }
export const AGENT_ROSTER_LIMITS: Readonly<{ maxAgents: 50; maxBytes: 65536; maxIdLength: 64; maxNameLength: 128 }>;
export function parseAgentId(value: unknown): string;
export function parseAgentName(value: unknown): string;
export function parseAgentRoster(value: unknown): AgentRosterDocument;
export function createDefaultAgentRoster(): AgentRosterDocument;
