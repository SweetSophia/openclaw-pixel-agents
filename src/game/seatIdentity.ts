import type { Point } from './Pathfinder';

/** Resolve the historical alias for rendering only; saved keys remain literal. */
export function resolveConfiguredSeats(seats: Readonly<Record<string, Point>>, registeredAgentIds: ReadonlySet<string>): Map<string, Point> {
  const effective = new Map(Object.entries(seats).map(([id, point]) => [id, { ...point }]));
  const legacy = effective.get('shodan');
  if (!effective.has('main') && !registeredAgentIds.has('shodan') && legacy) {
    effective.delete('shodan');
    effective.set('main', legacy);
  }
  return effective;
}
