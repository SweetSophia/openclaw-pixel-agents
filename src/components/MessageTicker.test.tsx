import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MessageTicker from './MessageTicker';
import type { TickerMessage } from '../../shared/types';

const socket = vi.hoisted(() => ({
  handlers: new Map<string, (messages: TickerMessage[]) => void>(),
  on(event: string, handler: (messages: TickerMessage[]) => void) { this.handlers.set(event, handler); },
  off(event: string) { this.handlers.delete(event); },
}));
vi.mock('../socket', () => ({ getSharedSocket: () => socket, getCachedTickerMessages: () => null }));
beforeEach(() => { socket.handlers.clear(); });
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
  act(() => socket.handlers.get('ticker:messages')?.([{
    id: 'new', agentId: 'cybera', agentName: 'Cybera', role: 'assistant',
    text: 'Fresh transcript', timestamp: 1_800_000_000_000,
  }]));
  await act(async () => { resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 })); });
  expect(screen.getByText('Fresh transcript')).toBeInTheDocument();
  view.unmount();
  expect(socket.handlers.size).toBe(0);
});
