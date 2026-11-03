import type { PersistedPrefs } from './validation';

export type PreferenceSaveResult = { saved: true } | { saved: false; error: unknown };

/** Roster membership is not a request to erase an absent agent's preferences. */
export function serializeAgentPreferences(
  registry: ReadonlyMap<string, PersistedPrefs>,
  retained: ReadonlyMap<string, PersistedPrefs>,
): string {
  const prefs: Record<string, PersistedPrefs> = Object.create(null);
  for (const [id, agent] of [...retained, ...registry]) {
    prefs[id] = { pixelEnabled: agent.pixelEnabled, characterSpriteId: agent.characterSpriteId, tags: agent.tags, recipe: agent.recipe };
  }
  return JSON.stringify(prefs, null, 2);
}

/** Keep registry and published state consistent with the preference file's replacement boundary. */
export function updateAgentPreferences(
  known: PersistedPrefs,
  state: PersistedPrefs | undefined,
  patch: PersistedPrefs,
  persist: (onReplaced: () => void) => void,
): PreferenceSaveResult {
  const records = state ? [known, state] : [known];
  const previous = records.map(record => ({ ...record }));
  for (const record of records) Object.assign(record, patch);
  let replaced = false;
  try {
    persist(() => { replaced = true; });
    return { saved: true };
  } catch (error) {
    // The file already contains the patch; keep memory in agreement and report uncertainty.
    if (replaced) return { saved: false, error };
    for (const [index, record] of records.entries()) {
      const original = previous[index];
      for (const key of Object.keys(patch) as (keyof PersistedPrefs)[]) {
        if (!Object.prototype.hasOwnProperty.call(original, key)) delete record[key];
      }
      Object.assign(record, original);
    }
    throw error;
  }
}
