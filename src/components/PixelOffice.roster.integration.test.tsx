import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentState } from '../../shared/types';
import type { LayoutDoc } from '../hooks/useLayoutStore';
import { PixelOffice } from './PixelOffice';
import { GameEngine } from '../game/GameEngine';
import { getAgentCharacter } from '../game/SpriteLoader';
import deskManifest from '../../public/assets/furniture/DESK/manifest.json';

vi.mock('../audio/SoundFX', () => ({ sfx: {
  click: vi.fn(), place: vi.fn(), pickup: vi.fn(), typing: vi.fn(), typingBatch: vi.fn(),
  notify: vi.fn(), error: vi.fn(), spawn: vi.fn(), despawn: vi.fn(), footstep: vi.fn(),
} }));

const agent = (id: string): AgentState => ({ id, name: '研究 Assistant', activity: 'typing', model: 'test', sessionKey: `agent:${id}:fixture`, active: true, lastActivity: 1, pixelEnabled: true, tags: [], recipe: { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 } });
const layout: LayoutDoc = { id: 'default', name: 'Default', width: 24, height: 16, updatedAt: 1, furniture: [], seats: { shodan: { x: 9, y: 4 } } };
const base = { editorMode: false, deleteMode: false, selectedFurnitureType: null, onPlaceFurniture: vi.fn(), onSelectFurniture: vi.fn(), onMoveFurniture: vi.fn(), onRotateFurniture: vi.fn() };

beforeEach(() => {
  vi.stubEnv('DEV', false); vi.stubGlobal('__ASSET_BUILD_ID__', 'a'.repeat(32));
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    if (String(input).includes('/furniture/DESK/manifest.json')) return Response.json(deskManifest);
    return String(input).includes('/manifest.json') ? new Response('', { status: 404 }) : new Response('png');
  }));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 768, height: 288, close: vi.fn() })));
  const context = new Proxy({ measureText: (text: string) => ({ width: text.length * 6 }), createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }) }, { get: (target, property) => Reflect.get(target, property) ?? (() => {}) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 768, height: 512 } as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('keeps a sub-prefixed ordinary agent alive and selectable across updates', async () => {
  const add = vi.spyOn(GameEngine.prototype, 'addCharacter'); const click = vi.fn();
  const ordinary = agent('sub-worker');
  const view = render(<PixelOffice {...base} agents={[ordinary]} registeredAgentIds={['sub-worker']} activeLayout={{ ...layout, seats: { 'sub-worker': { x: 7, y: 7 } } }} onCharacterClick={click} />);
  await waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: 'sub-worker' })));
  const engine = add.mock.contexts[0] as GameEngine;
  const canvas = view.container.querySelector('canvas')!;
  fireEvent.click(canvas, { clientX: 7.5 * 32, clientY: 7.5 * 32 });
  expect(click).toHaveBeenLastCalledWith('sub-worker');
  click.mockClear();
  fireEvent.touchStart(canvas, { touches: [{ clientX: 7.5 * 32, clientY: 7.5 * 32 }] });
  fireEvent.touchEnd(canvas, { touches: [], changedTouches: [{ clientX: 7.5 * 32, clientY: 7.5 * 32 }] });
  expect(click).toHaveBeenLastCalledWith('sub-worker');
  view.rerender(<PixelOffice {...base} agents={[{ ...ordinary, name: 'Renamed' }]} registeredAgentIds={['sub-worker']} activeLayout={{ ...layout, seats: { 'sub-worker': { x: 7, y: 7 } } }} onCharacterClick={click} />);
  expect(engine.getCharacterIds()).toEqual(['sub-worker']);
  expect(engine.isCharacterDying('sub-worker')).toBe(false);
  expect(engine.isSubAgent('sub-worker')).toBe(false);
  expect(getAgentCharacter('sub-worker')?.down[0].canvas.width).toBeGreaterThan(0);
});
it('retains actual sub-agents with non-prefixed identities and does not select them', async () => {
  // Spawn right of the parent; diagonal rounding can overlap its inclusive pick box.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const add = vi.spyOn(GameEngine.prototype, 'addCharacter'); const click = vi.fn();
  const child = { id: 'agent:main:subagent:fixture', name: 'Child', spawnedAt: 1, status: 'running' as const };
  const parent = { ...agent('main'), subAgents: [child] };
  const props = { ...base, registeredAgentIds: ['main'], activeLayout: { ...layout, seats: { main: { x: 9, y: 4 } } }, onCharacterClick: click };
  const view = render(<PixelOffice {...props} agents={[parent]} />);
  await waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: 'main' })));
  const engine = add.mock.contexts[0] as GameEngine;
  expect(engine.isSubAgent(child.id)).toBe(true);
  view.rerender(<PixelOffice {...props} agents={[{ ...parent, name: 'Updated' }]} />);
  expect(engine.getCharacterIds()).toContain(child.id);
  expect(engine.isCharacterDying(child.id)).toBe(false);
  const internal = engine as unknown as { characters: Map<string, { x: number; y: number }> };
  const position = internal.characters.get(child.id)!;
  fireEvent.click(view.container.querySelector('canvas')!, { clientX: (position.x + 0.5) * 32, clientY: (position.y + 0.5) * 32 });
  expect(click).not.toHaveBeenCalled();
});
it('uses legacy seat coordinates without writing an alias into the input layout', async () => {
  const add = vi.spyOn(GameEngine.prototype, 'addCharacter'); const before = JSON.stringify(layout);
  render(<PixelOffice {...base} agents={[agent('main')]} registeredAgentIds={['main']} activeLayout={layout} />);
  await waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: 'main', x: 9, y: 4 })));
  const engine = add.mock.contexts[0] as GameEngine;
  engine.setRegisteredAgentIds(new Set(['main']));
  expect(engine.assignSeat('main')).toEqual({ x: 9, y: 4 });
  expect(JSON.stringify(layout)).toBe(before);
});
it.each(['layout-first', 'roster-first'])('does not borrow another-room/disabled shodan seat (%s)', async order => {
  const add = vi.spyOn(GameEngine.prototype, 'addCharacter');
  const view = render(<PixelOffice {...base} agents={[]} registeredAgentIds={order === 'roster-first' ? ['main', 'shodan'] : []} activeLayout={order === 'layout-first' ? layout : null} />);
  // shodan remains in full membership although it is absent from visible room agents.
  view.rerender(<PixelOffice {...base} agents={[agent('main')]} registeredAgentIds={['main', 'shodan']} activeLayout={layout} />);
  await waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: 'main' })));
  const engine = add.mock.contexts[0] as GameEngine;
  expect(engine.assignSeat('main')).not.toEqual({ x: 9, y: 4 });
  expect(layout.seats).toEqual({ shodan: { x: 9, y: 4 } });
});
