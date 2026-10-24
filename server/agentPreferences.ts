import type { PersistedPrefs } from './validation';

export type PreferenceSaveResult = { saved: true } | { saved: false; error: unknown };

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
