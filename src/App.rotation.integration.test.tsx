import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { GameEngine } from './game/GameEngine';
import type { LayoutDoc } from './hooks/useLayoutStore';

const TILE_SIZE = 32;
const DESK_GRID_X = 3;
const DESK_GRID_Y = 4;
const DESK_CENTER_X = (DESK_GRID_X + 0.5) * TILE_SIZE;
const DESK_CENTER_Y = (DESK_GRID_Y + 0.5) * TILE_SIZE;

vi.mock('./hooks/useAgentStore', () => ({
  useAgentStore: () => ({
    agents: [],
    connected: true,
    toggleAgent: vi.fn(),
    toggleAll: vi.fn(),
    updateTags: vi.fn(),
    updateRecipe: vi.fn(),
    activeRoomId: 'default',
    setActiveRoomId: vi.fn(),
    roomAgents: [],
  }),
}));

vi.mock('./components/AgentSidebar', () => ({ AgentSidebar: () => null }));
vi.mock('./components/AgentDetailPanel', () => ({ AgentDetailPanel: () => null }));
vi.mock('./components/SoundControls', () => ({ SoundControls: () => null }));
vi.mock('./components/RoomSwitcher', () => ({ RoomSwitcher: () => null }));
vi.mock('./components/MessageTicker', () => ({ default: () => null }));
vi.mock('./components/LayoutEditor', () => ({
  LayoutEditor: ({ activeLayout }: { activeLayout: LayoutDoc | null }) => (
    <output data-testid="persisted-rotation">
      {activeLayout?.furniture[0]?.rotation ?? 'none'}
    </output>
  ),
}));

describe('App furniture rotation roundtrip', () => {
  let persistedLayout: LayoutDoc;
  let putBodies: LayoutDoc[];

  beforeEach(() => {
    persistedLayout = {
      id: 'default',
      name: 'Default',
      width: 24,
      height: 16,
      furniture: [{ id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 0 }],
      seats: {},
      updatedAt: 1_000,
    };
    putBodies = [];

    vi.spyOn(GameEngine.prototype, 'init').mockResolvedValue(undefined);
    vi.spyOn(GameEngine.prototype, 'start').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 768,
      height: 512,
      right: 768,
      bottom: 512,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();

      if (url.endsWith('/api/layouts/default') && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as LayoutDoc;
        putBodies.push(body);
        persistedLayout = body;
        return new Response(JSON.stringify({ layout: body }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/layouts/default')) {
        return new Response(JSON.stringify(persistedLayout), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/layouts')) {
        return new Response(JSON.stringify({ layouts: [persistedLayout] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/furniture-catalog')) {
        return new Response(JSON.stringify({ types: ['DESK'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('persists a canvas context-menu rotation and reloads the saved angle', async () => {
    const firstRender = render(<App />);
    await waitFor(() => expect(firstRender.container.querySelector('canvas')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '✏️ Editor' }));
    await waitFor(() => expect(screen.getByTestId('persisted-rotation')).toHaveTextContent('0'));

    vi.useFakeTimers();

    // These coordinates land at the fixture desk's center and exercise the
    // real grid-to-screen mapping instead of calling the callback directly.
    fireEvent.contextMenu(firstRender.container.querySelector('canvas')!, {
      clientX: DESK_CENTER_X,
      clientY: DESK_CENTER_Y,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('persisted-rotation')).toHaveTextContent('90');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(putBodies).toHaveLength(1);
    expect(putBodies[0].furniture[0].rotation).toBe(90);

    vi.useRealTimers();
    firstRender.unmount();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '✏️ Editor' }));
    await waitFor(() => expect(screen.getByTestId('persisted-rotation')).toHaveTextContent('90'));
  });
});
