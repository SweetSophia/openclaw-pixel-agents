import type { AgentState } from "../shared/types";

export interface AgentSnapshotApplyResult {
  applied: boolean;
  snapshot: AgentState[];
}

function snapshotAgents(agentStates: Map<string, AgentState>): AgentState[] {
  return Array.from(agentStates.values()).map((agent) => structuredClone(agent));
}

/**
 * Atomically applies a new agent snapshot unless the source failed.
 *
 * On source errors, keep the previous non-empty snapshot so transient upstream
 * failures do not make every agent flash to sleeping/disconnected in the UI.
 */
export function applyAgentSnapshot(
  agentStates: Map<string, AgentState>,
  nextAgents?: Map<string, AgentState>,
  options: { sourceError?: boolean } = {},
): AgentSnapshotApplyResult {
  if (options.sourceError && agentStates.size > 0) {
    return { applied: false, snapshot: snapshotAgents(agentStates) };
  }

  agentStates.clear();
  for (const agent of nextAgents?.values() ?? []) {
    agentStates.set(agent.id, agent);
  }

  return { applied: true, snapshot: snapshotAgents(agentStates) };
}
