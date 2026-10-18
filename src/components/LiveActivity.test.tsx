import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentState } from '../../shared/types';
import LiveActivity from './LiveActivity';

const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), connected: true }));
vi.mock('../socket', () => ({ getSharedSocket: () => socket, getCachedTickerMessages: () => null }));

const now = 1_800_000_000_000;
const agent: AgentState = {
  id: 'cybera', name: 'Cybera', activity: 'typing', active: true,
  model: 'test-model', sessionKey: 'session-1', lastActivity: now - 30_000,
  pixelEnabled: true, tags: ['coding'],
};

describe('LiveActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url === '/api/status'
        ? { dataSource: 'ingest', lastIngestAt: now }
        : { messages: [] },
    ), { status: 200, headers: { Date: new Date(Date.now()).toUTCString() } })));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
  function open() { fireEvent.click(screen.getByRole('button', { name: /Live activity/i })); }

  it('counts all agent states and filters the roster without hiding disabled pixel agents', async () => {
    render(<LiveActivity agents={[
      { ...agent, id: 'off', name: 'Offline agent', active: false, activity: 'sleeping' },
      agent,
      { ...agent, id: 'waiting', name: 'Waiting agent', activity: 'waiting_input', active: false, pixelEnabled: false },
      { ...agent, id: 'idle', name: 'Idle agent', activity: 'idle' },
    ]} connected snapshotReceivedAt={now} onSelectAgent={() => {}} />);
    await settle();
    expect(screen.getByText('Working 1')).toBeInTheDocument();
    expect(screen.getByText('Needs attention 1')).toBeInTheDocument();
    expect(screen.getByText('Idle 1')).toBeInTheDocument();
    expect(screen.getByText('Inactive 1')).toBeInTheDocument();
    open();
    expect(within(screen.getByRole('list', { name: 'Agent activity' })).getAllByRole('button')[0]).toHaveTextContent('Cybera');
    fireEvent.click(screen.getByRole('button', { name: 'Needs attention' }));
    const roster = screen.getByRole('list', { name: 'Agent activity' });
    expect(within(roster).getByText('Waiting agent')).toBeInTheDocument();
    expect(within(roster).getByText('Waiting for input')).toBeInTheDocument();
    expect(within(roster).queryByText('Cybera')).not.toBeInTheDocument();
    expect(screen.getByText(/estimated from session recency/i)).toBeInTheDocument();
  });

  it('opens existing agent details and records each observed state change once', async () => {
    const select = vi.fn();
    const props = { connected: true, snapshotReceivedAt: now, onSelectAgent: select };
    const view = render(<LiveActivity {...props} agents={[agent]} />);
    await settle(); open();
    fireEvent.click(screen.getByRole('button', { name: /Cybera.*Typing/i }));
    expect(select).toHaveBeenCalledWith('cybera');
    expect(screen.getByText(/No changes observed/i)).toBeInTheDocument();
    view.rerender(<LiveActivity {...props} agents={[{ ...agent, activity: 'reading' }]} />);
    view.rerender(<LiveActivity {...props} agents={[{ ...agent, activity: 'reading', model: 'new-model', pixelEnabled: false }]} />);
    const changes = screen.getByRole('list', { name: 'Observed changes' });
    expect(within(changes).getAllByRole('listitem')).toHaveLength(1);
    expect(within(changes).getByText(/Typing → Reading/)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('region', { name: 'Live activity' }), { key: 'Escape' });
    expect(screen.queryByRole('list', { name: 'Agent activity' })).not.toBeInTheDocument();
  });

  it('marks an old collector snapshot stale even while the dashboard socket stays connected', async () => {
    render(<LiveActivity agents={[agent]} connected snapshotReceivedAt={now} onSelectAgent={() => {}} />);
    await settle();
    expect(screen.getByText(/Updated just now/i)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(95_000); });
    expect(screen.getByText(/Data is stale/i)).toBeInTheDocument();
    open();
    expect(screen.getByText(/last known activity/i)).toBeInTheDocument();
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ dataSource: 'ingest', lastIngestAt: Date.now() }), { status: 200, headers: { Date: new Date(Date.now()).toUTCString() } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.queryByText(/Data is stale/i)).not.toBeInTheDocument();
  });

  it('shows source errors and empty states without labelling cached data live', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 503 }));
    render(<LiveActivity agents={[]} connected={false} snapshotReceivedAt={null} onSelectAgent={() => {}} />);
    await settle(); open();
    expect(screen.getByText(/Freshness unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/No agents received yet/i)).toBeInTheDocument();
  });

  it('keeps actual transcript messages separate from inferred status changes', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(
      url === '/api/status' ? { dataSource: 'ingest', lastIngestAt: now }
        : { messages: [{ id: 'm1', agentId: 'cybera', agentName: 'Cybera', role: 'assistant', text: 'Build completed.', timestamp: now }] },
    ), { status: 200, headers: { Date: new Date(Date.now()).toUTCString() } }));
    render(<LiveActivity agents={[agent]} connected snapshotReceivedAt={now} onSelectAgent={() => {}} />);
    await settle(); open(); await settle();
    expect(screen.getByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    expect(screen.getByText('Build completed.')).toBeInTheDocument();
    expect(screen.getByText(/No changes observed/i)).toBeInTheDocument();
  });

  it('waits for the first collector push instead of treating the browser snapshot as source freshness', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ dataSource: 'ingest', lastIngestAt: null }), { status: 200 }));
    render(<LiveActivity agents={[agent]} connected snapshotReceivedAt={now} onSelectAgent={() => {}} />);
    await settle();
    expect(screen.getByText(/Waiting for source data/i)).toBeInTheDocument();
    expect(screen.queryByText(/Updated just now/i)).not.toBeInTheDocument();
  });

  it('distinguishes CLI snapshot receipt from collector freshness during REST fallback', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ dataSource: 'cli-poll', lastIngestAt: null }), { status: 200 }));
    const props = { agents: [agent], connected: false, onSelectAgent: () => {} };
    const view = render(<LiveActivity {...props} snapshotReceivedAt={now - 120_000} />);
    await settle();
    expect(screen.getByText(/Data is stale/i)).toBeInTheDocument();
    view.rerender(<LiveActivity {...props} snapshotReceivedAt={now} />);
    expect(screen.getByText(/Snapshot received just now/i)).toBeInTheDocument();
    open();
    expect(screen.getByText(/OpenClaw CLI · REST fallback/i)).toBeInTheDocument();
  });

  it.each([-600_000, 600_000])('uses the server clock for collector age with a %ims clock offset', async offset => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      dataSource: 'ingest', lastIngestAt: now + offset - 15_000,
    }), { status: 200, headers: { Date: new Date(Date.now() + offset).toUTCString() } }));
    render(<LiveActivity agents={[{ ...agent, lastActivity: now + offset - 30_000 }]} connected snapshotReceivedAt={now} onSelectAgent={() => {}} />);
    await settle();
    expect(screen.getByText('Updated 15s ago')).toBeInTheDocument();
    open();
    expect(screen.getByText('Session activity 30s ago')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(screen.getByText(/Data is stale/i)).toBeInTheDocument();
  });

  it('does not guess collector freshness when the server clock is unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ dataSource: 'ingest', lastIngestAt: now }), { status: 200 }));
    render(<LiveActivity agents={[agent]} connected snapshotReceivedAt={now} onSelectAgent={() => {}} />);
    await settle();
    expect(screen.getByText(/Freshness unavailable/i)).toBeInTheDocument();
  });
});
