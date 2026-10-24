import type { CharacterRecipe } from './types';

// Shared by the server, map sprites, portraits and editor. Saved recipes override these defaults.
export const DEFAULT_RECIPES: Readonly<Record<string, Readonly<CharacterRecipe>>> = {
  main:       { bodyIndex: 3, hairIndex: 0, outfitIndex: 2 },
  cybera:     { bodyIndex: 1, hairIndex: 2, outfitIndex: 0 },
  chi:        { bodyIndex: 2, hairIndex: 5, outfitIndex: 3 },
  descartes:  { bodyIndex: 4, hairIndex: 1, outfitIndex: 1 },
  cyberlogis: { bodyIndex: 0, hairIndex: 3, outfitIndex: 4 },
  cylena:     { bodyIndex: 5, hairIndex: 7, outfitIndex: 5 },
  sysauxilia: { bodyIndex: 2, hairIndex: 4, outfitIndex: 2 },
  miku:       { bodyIndex: 1, hairIndex: 6, outfitIndex: 0 },
};

export function getRecipe(agentId: string, overrides?: Partial<CharacterRecipe>): CharacterRecipe {
  const base = DEFAULT_RECIPES[agentId] ?? { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 };
  return { ...base, ...overrides };
}
