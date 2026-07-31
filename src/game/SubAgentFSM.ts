/** SubAgentFSM — pure planner for sub-agent fade-out ticks.
 *
 * Lifecycle authority: the server-reported sub-agent status is the sole
 * owner of a sub-agent's lifetime (issue #102). PixelOffice reconciles that
 * status into `killSubAgent()` / `reviveSubAgent()` calls; this planner only
 * runs the fade-out once a character is dying and reports when it should be
 * removed. There is intentionally NO age-based expiry: a sub-agent whose
 * status stays `running` lives indefinitely.
 */

export const SUBAGENT_FADE_DURATION = 2_000;

export interface SubAgentInput {
  dying: boolean;
  fadeAlpha: number;
}

export interface SubAgentTick {
  fadeAlpha: number;
  dying: boolean;
  shouldRemove: boolean;
}

// `Readonly<SubAgentInput>` makes the pure-planner contract compiler-enforced:
// tickSubAgent reads its input and returns a fresh tick, never mutating the
// caller's character (issue #82).
export function tickSubAgent(
  char: Readonly<SubAgentInput>,
  dtSec: number,
): SubAgentTick {
  if (!char.dying) {
    // Preserve existing fadeAlpha — only dying agents fade.
    return { fadeAlpha: char.fadeAlpha, dying: false, shouldRemove: false };
  }

  const fadeAlpha = Math.max(0, char.fadeAlpha - dtSec / (SUBAGENT_FADE_DURATION / 1000));
  return { fadeAlpha, dying: true, shouldRemove: fadeAlpha <= 0 };
}
