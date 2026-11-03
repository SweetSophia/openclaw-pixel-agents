import { expect, it } from 'vitest';
import { resolveConfiguredSeats } from './seatIdentity';

it('derives a legacy main lookup without mutating or double-reserving literal seats', () => {
  const point = Object.freeze({ x: 9, y: 4 }); const seats = Object.freeze({ shodan: point });
  const effective = resolveConfiguredSeats(seats, new Set(['main']));
  expect([...effective]).toEqual([['main', { x: 9, y: 4 }]]);
  expect(seats).toEqual({ shodan: { x: 9, y: 4 } });
  expect(effective.get('main')).not.toBe(point);
});
it('keeps a registered shodan literal even if main has no seat', () => {
  expect([...resolveConfiguredSeats({ shodan: { x: 9, y: 4 } }, new Set(['main', 'shodan']))]).toEqual([['shodan', { x: 9, y: 4 }]]);
});
it('preserves both exact identities with explicit main taking precedence', () => {
  expect([...resolveConfiguredSeats({ shodan: { x: 9, y: 4 }, main: { x: 5, y: 6 } }, new Set(['main']))]).toEqual([
    ['shodan', { x: 9, y: 4 }], ['main', { x: 5, y: 6 }],
  ]);
});
