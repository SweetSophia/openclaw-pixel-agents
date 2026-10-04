import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import type { LayoutDoc } from '../hooks/useLayoutStore';
import { resetSharedSocketForTesting } from '../socket';

// Real App, stores, PixelOffice, engine/controller. Only REST/Socket.IO,
// canvas, asset requests, audio and RAF browser boundaries are replaced.
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../audio/SoundFX', () => ({ sfx: {
  click: vi.fn(), pickup: vi.fn(), place: vi.fn(), muted: true, volume: 0, ambienceOn: false,
} }));

describe('informational preview preserves App layout writes', () => {
  let persisted: LayoutDoc;
  let writes: LayoutDoc[];
  beforeEach(() => {
    persisted = { id: 'default', name: 'Default', width: 24, height: 16, updatedAt: 1000, seats: {}, furniture: [
      { id: 'table', type: 'DESK', x: 5, y: 5, rotation: 0 },
      { id: 'wall', type: 'WHITEBOARD', x: 0, y: 0, rotation: 0 },
      { id: 'painting', type: 'LARGE_PAINTING', x: 22, y: 0, rotation: 0 },
      { id: 'moving', type: 'PC', x: 10, y: 10, rotation: 0 },
    ] };
    writes = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 768, height: 512 } as DOMRect);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/assets/')) return new Promise<Response>(() => {});
      if (url === '/api/layouts/default' && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        persisted = { ...body, updatedAt: persisted.updatedAt + 1 }; writes.push(persisted);
        return Response.json({ layout: persisted });
      }
      if (url === '/api/layouts/default') return Response.json(persisted);
      if (url === '/api/layouts') return Response.json({ layouts: [persisted] });
      if (url === '/api/furniture-catalog') return Response.json({ types: ['COFFEE', 'WHITEBOARD'] });
      if (url === '/api/agents') return Response.json({ agents: [] });
      return Response.json({});
    }));
  });
  afterEach(() => { cleanup(); resetSharedSocketForTesting(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const point = (x: number, y: number) => ({ clientX: (x + 0.5) * 32, clientY: (y + 0.5) * 32, button: 0 });
  it('accepts and saves overlapped placement and movement with unchanged wall decor and draw order, then reloads', async () => {
    const view = render(<App />); fireEvent.click(screen.getByRole('button', { name: '✏️ Editor' }));
    fireEvent.click(screen.getByRole('button', { name: '📦 Furniture' }));
    const coffee = await screen.findByTitle('Coffee'); vi.useFakeTimers(); fireEvent.click(coffee);
    const canvas = view.container.querySelector('canvas')!;
    const status = screen.getByRole('status', { name: 'Furniture placement preview' });
    fireEvent.mouseMove(canvas, point(5, 5)); expect(status).toHaveTextContent('Overlaps furniture — placement is allowed.');
    fireEvent.mouseDown(canvas, point(5, 5));
    fireEvent.click(coffee); // deselect placement; drag the pre-existing PC onto the desk
    fireEvent.mouseDown(canvas, point(10, 10)); fireEvent.mouseMove(canvas, point(5, 5));
    expect(status).toHaveTextContent('Overlaps furniture — placement is allowed.'); fireEvent.mouseUp(canvas, point(5, 5));
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(writes).toHaveLength(1);
    expect(persisted.furniture.map(f => f.type)).toEqual(['DESK', 'WHITEBOARD', 'LARGE_PAINTING', 'PC', 'COFFEE']);
    expect(persisted.furniture.find(f => f.id === 'moving')).toMatchObject({ x: 5, y: 5 });
    expect(persisted.furniture[persisted.furniture.length - 1]).toMatchObject({ type: 'COFFEE', x: 5, y: 5 });
    expect(persisted.furniture[1]).toEqual({ id: 'wall', type: 'WHITEBOARD', x: 0, y: 0, rotation: 0 });
    expect(persisted.furniture[2]).toEqual({ id: 'painting', type: 'LARGE_PAINTING', x: 22, y: 0, rotation: 0 });
    vi.useRealTimers(); view.unmount(); const again = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '✏️ Editor' }));
    await waitFor(() => {
      fireEvent.mouseDown(again.container.querySelector('canvas')!, point(5, 5));
      expect(screen.getByText('Coffee')).toBeInTheDocument();
    }); // reverse-list selection still chooses last layered item
  });
  it('preserves raw touch wall/decor placement and persists its accepted overlap', async () => {
    const view = render(<App />); fireEvent.click(screen.getByRole('button', { name: '✏️ Editor' }));
    fireEvent.click(screen.getByRole('button', { name: '📦 Furniture' }));
    const wall = await screen.findByTitle('Whiteboard'); vi.useFakeTimers(); fireEvent.click(wall);
    const canvas = view.container.querySelector('canvas')!;
    fireEvent.touchStart(canvas, { touches: [point(0, 0)] });
    expect(screen.getByRole('status', { name: 'Furniture placement preview' })).toHaveTextContent('Overlaps furniture — placement is allowed. Touches the office border.');
    fireEvent.touchEnd(canvas, { touches: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(writes).toHaveLength(1); expect(persisted.furniture).toHaveLength(5);
    expect(persisted.furniture[4]).toMatchObject({ type: 'WHITEBOARD', x: 0, y: 0, rotation: 0 });
    expect(persisted.furniture[1]).toEqual({ id: 'wall', type: 'WHITEBOARD', x: 0, y: 0, rotation: 0 });
  });

});
