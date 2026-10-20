import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROOMS, type AgentState } from '../../shared/types';
import type { LayoutDoc } from '../hooks/useLayoutStore';
import deskManifest from '../../public/assets/furniture/DESK/manifest.json';

// Exercise the real React adapter, room switcher, loader and engine. Only
// browser asset/network, canvas, audio and frame-scheduling boundaries are stubbed.
vi.mock('../audio/SoundFX', () => ({ sfx: {
  click: vi.fn(), place: vi.fn(), pickup: vi.fn(), typing: vi.fn(), typingBatch: vi.fn(),
  notify: vi.fn(), error: vi.fn(), spawn: vi.fn(), despawn: vi.fn(), footstep: vi.fn(),
} }));

describe('PixelOffice room changes with the real GameEngine', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DEV', false);
    vi.stubGlobal('__ASSET_BUILD_ID__', 'a'.repeat(32));
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/rooms') return Response.json({ rooms: DEFAULT_ROOMS });
      if (url.includes('/furniture/DESK/manifest.json')) return Response.json(deskManifest);
      if (url.includes('/manifest.json')) return new Response('', { status: 404 });
      return new Response('png');
    }));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 768, height: 288, close: vi.fn() })));
    const context = new Proxy({
      measureText: (text: string) => ({ width: text.length * 6 }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createLinearGradient: () => ({ addColorStop() {} }),
    }, {
      get: (target, property) => Reflect.get(target, property) ?? (() => {}),
    }) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 768, height: 512,
    } as DOMRect);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('keeps returning agents selectable at their resolved desk-floor positions after real room clicks', async () => {
    const { PixelOffice } = await import('./PixelOffice');
    const { RoomSwitcher } = await import('./RoomSwitcher');
    const agents: AgentState[] = [
      { id: 'main', name: 'Shodan', activity: 'typing', model: 'test', sessionKey: 'main',
        active: true, lastActivity: 1, pixelEnabled: true, tags: ['coding'], roomId: 'office' },
      { id: 'miku', name: 'Miku', activity: 'reading', model: 'test', sessionKey: 'miku',
        active: true, lastActivity: 1, pixelEnabled: true, tags: ['research'], roomId: 'lab' },
    ];
    const activeLayout: LayoutDoc = {
      id: 'default', name: 'Default', width: 24, height: 16, updatedAt: 1,
      furniture: [
        { id: 'desk-main', type: 'DESK', x: 9, y: 4, rotation: 0 },
        { id: 'desk-miku', type: 'DESK', x: 15, y: 4, rotation: 0 },
      ],
      seats: { main: { x: 9, y: 4 }, miku: { x: 15, y: 4 } },
    };
    const callbacks = {
      onPlaceFurniture: vi.fn(), onSelectFurniture: vi.fn(), onMoveFurniture: vi.fn(),
      onRotateFurniture: vi.fn(), onCharacterClick: vi.fn(),
    };
    function Rooms() {
      const [room, setRoom] = useState('office');
      return <>
        <RoomSwitcher activeRoomId={room} onRoomChange={setRoom} agents={agents} />
        <PixelOffice {...callbacks} agents={agents.filter(agent => agent.roomId === room)}
          activeLayout={activeLayout} editorMode={false} deleteMode={false} selectedFurnitureType={null} />
      </>;
    }
    const view = render(<Rooms />);
    const canvas = view.container.querySelector('canvas')!;
    const clickGrid = (x: number, y: number) => fireEvent.click(canvas, {
      clientX: (x + 0.5) * 32, clientY: (y + 0.5) * 32,
    });
    await waitFor(() => {
      clickGrid(10, 6);
      expect(callbacks.onCharacterClick).toHaveBeenLastCalledWith('main');
    });

    for (let visit = 0; visit < 3; visit++) {
      fireEvent.click(screen.getByRole('button', { name: /Research Lab/ }));
      callbacks.onCharacterClick.mockClear();
      clickGrid(10, 6);
      expect(callbacks.onCharacterClick).not.toHaveBeenCalled();
      clickGrid(16, 6);
      expect(callbacks.onCharacterClick).toHaveBeenLastCalledWith('miku');

      fireEvent.click(screen.getByRole('button', { name: /Office/ }));
      callbacks.onCharacterClick.mockClear();
      clickGrid(16, 6);
      expect(callbacks.onCharacterClick).not.toHaveBeenCalled();
      clickGrid(10, 6);
      expect(callbacks.onCharacterClick).toHaveBeenLastCalledWith('main');
    }
  });
});
