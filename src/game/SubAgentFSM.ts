/** SubAgentFSM — pure planner for sub-agent lifecycle ticks.
 * Encapsulates the per-frame state transitions for sub-agent characters
 * (age check, despawn trigger, fade-out, removal). Side effects (sound,
 * character deletion) are reported as actions for the caller to execute.
 */

export const SUBAGENT_LIFETIME = 15_000;
export const SUBAGENT_FADE_DURATION = 2_000;

export interface SubAgentInput {
  spawnTime: number;
  dying: boolean;
  fadeAlpha: number;
}

export type SubAgentAction = { kind: 'despawn-sound' };

const EMPTY_ACTIONS: SubAgentAction[] = [];

export interface SubAgentTick {
  fadeAlpha: number;
  dying: boolean;
  actions: SubAgentAction[];
  shouldRemove: boolean;
}

export function tickSubAgent(
  char: SubAgentInput,
  nowMs: number,
  dtSec: number,
): SubAgentTick {
  const age = nowMs - char.spawnTime;
  const dying = char.dying || age > SUBAGENT_LIFETIME;
  const justEnteredDying = dying && !char.dying;

  if (!dying) {
    // Preserve existing fadeAlpha — the original `if (char.isSubAgent)` block
    // in GameEngine had no else that reset it. Only dying agents fade.
    return { fadeAlpha: char.fadeAlpha, dying: false, actions: EMPTY_ACTIONS, shouldRemove: false };
  }

  const fadeAlpha = Math.max(0, char.fadeAlpha - dtSec / (SUBAGENT_FADE_DURATION / 1000));
  const shouldRemove = fadeAlpha <= 0;
  const actions: SubAgentAction[] = justEnteredDying ? [{ kind: 'despawn-sound' }] : EMPTY_ACTIONS;

  return { fadeAlpha, dying, actions, shouldRemove };
}
