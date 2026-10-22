import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MessageTicker from './MessageTicker';
import type { TickerMessage } from '../../shared/types';

const socket = vi.hoisted(() => ({
  connected: true,
  cached: null as TickerMessage[] | null,
  handlers: new Map<string, Set<(messages: TickerMessage[]) => void>>(),
  on(event: string, handler: (messages: TickerMessage[]) => void) {
    const listeners = this.handlers.get(event) ?? new Set();
    listeners.add(handler); this.handlers.set(event, listeners);
  },
  off(event: string, handler: (messages: TickerMessage[]) => void) { this.handlers.get(event)?.delete(handler); },
  emit(event: string, messages: TickerMessage[]) { this.handlers.get(event)?.forEach(handler => handler(messages)); },
}));
vi.mock('../socket', () => ({ getSharedSocket: () => socket, getCachedTickerMessages: () => socket.cached }));
beforeEach(() => { socket.handlers.clear(); socket.cached = null; socket.connected = true; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('reports a failed transcript request without claiming there are no messages', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
  render(<MessageTicker />);
  expect(await screen.findByText(/Messages unavailable/i)).toBeInTheDocument();
  expect(screen.queryByText(/No transcript messages/i)).not.toBeInTheDocument();
});

it('keeps a newer socket message when the initial HTTP request finishes late', async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const view = render(<MessageTicker />);
  act(() => socket.emit('ticker:messages', [{
    id: 'new', agentId: 'cybera', agentName: 'Cybera', role: 'assistant',
    text: 'Fresh transcript', timestamp: 1_800_000_000_000,
  }]));
  await act(async () => { resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 })); });
  expect(screen.getByText('Fresh transcript')).toBeInTheDocument();
  view.unmount();
  expect(socket.handlers.get('ticker:messages')?.size).toBe(0);
});

const cachedMessage: TickerMessage = {
  id: 'cached', agentId: 'cybera', agentName: 'Cybera', role: 'assistant',
  text: 'Cached transcript', timestamp: 1_800_000_000_000,
};

it.each([200, 503])('keeps a cached live socket transcript when HTTP returns %i', async status => {
  socket.cached = [cachedMessage];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [] }), { status })));
  render(<MessageTicker />);
  await act(async () => {});
  expect(screen.getByText('Cached transcript')).toBeInTheDocument();
  expect(screen.queryByText(/Messages unavailable/i)).not.toBeInTheDocument();
});

it('refreshes a disconnected socket cache from a successful HTTP response', async () => {
  socket.connected = false; socket.cached = [cachedMessage];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [{ ...cachedMessage, id: 'fresh', text: 'HTTP transcript' }] }), { status: 200 })));
  render(<MessageTicker />);
  expect(await screen.findByText('HTTP transcript')).toBeInTheDocument();
  expect(screen.queryByText('Cached transcript')).not.toBeInTheDocument();
});

it('unsubscribes only its own listener from the shared socket', () => {
  const otherConsumer = () => {};
  socket.on('ticker:messages', otherConsumer);
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const view = render(<MessageTicker />);
  expect(socket.handlers.get('ticker:messages')?.size).toBe(2);
  view.unmount();
  expect([...socket.handlers.get('ticker:messages')!]).toEqual([otherConsumer]);
});
