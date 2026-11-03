import { expect, it } from 'vitest';
import { serializeAgentPreferences } from './agentPreferences';
import type { PersistedPrefs } from './validation';

it('retains absent agents but lets current preferences win without storing labels', () => {
  const current: PersistedPrefs & { id: string; name: string } = { id: 'main', name: 'Not a preference', pixelEnabled: false, tags: ['coding'], recipe: { bodyIndex: 1, hairIndex: 2, outfitIndex: 3 } };
  const retained = new Map<string, PersistedPrefs>([['main', { pixelEnabled: true }], ['researcher', { pixelEnabled: false, tags: ['analysis'] }], ['toString', { pixelEnabled: true }]]);
  const result = JSON.parse(serializeAgentPreferences(new Map([['main', current]]), retained));
  expect(result).toEqual({ main: { pixelEnabled: false, tags: ['coding'], recipe: { bodyIndex: 1, hairIndex: 2, outfitIndex: 3 } }, researcher: { pixelEnabled: false, tags: ['analysis'] }, toString: { pixelEnabled: true } });
  expect(retained.get('main')).toEqual({ pixelEnabled: true });
});
