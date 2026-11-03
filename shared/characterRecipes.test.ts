import { expect, it } from 'vitest';
import { getRecipe } from './characterRecipes';

it.each(['toString', 'valueOf', 'researcher'])('uses a real safe recipe for non-built-in %s', id => {
  expect(getRecipe(id)).toEqual({ bodyIndex: 0, hairIndex: 0, outfitIndex: 0 });
});
it('keeps built-in appearance and returns independent override values', () => {
  expect(getRecipe('main')).toEqual({ bodyIndex: 3, hairIndex: 0, outfitIndex: 2 });
  const recipe = getRecipe('main', { hairIndex: 8 }); recipe.bodyIndex = 0;
  expect(getRecipe('main')).toEqual({ bodyIndex: 3, hairIndex: 0, outfitIndex: 2 });
});
