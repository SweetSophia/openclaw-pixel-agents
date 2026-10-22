import type { AgentActivity, AgentState } from '../../shared/types';

export const activityGroups = ['Working', 'Needs attention', 'Idle', 'Inactive'] as const;
export type ActivityGroup = typeof activityGroups[number];

const labels: Record<AgentActivity, string> = {
  idle: 'Idle', thinking: 'Thinking', typing: 'Typing', reading: 'Reading',
  running_command: 'Running command', waiting_input: 'Waiting for input',
  sleeping: 'Sleeping', error: 'Error',
};

export function activityLabel(agent: Pick<AgentState, 'active' | 'activity'>): string {
  if (agent.activity === 'error' || agent.activity === 'waiting_input') return labels[agent.activity];
  return !agent.active ? 'Inactive' : labels[agent.activity];
}

export function activityGroup(agent: AgentState): ActivityGroup {
  if (agent.activity === 'error' || agent.activity === 'waiting_input') return 'Needs attention';
  if (!agent.active || agent.activity === 'sleeping') return 'Inactive';
  return agent.activity === 'idle' ? 'Idle' : 'Working';
}

export function ageLabel(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
