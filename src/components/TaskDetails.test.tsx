import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskDetails } from './TaskDetails';
import { ControlApiError } from '../control/api';

const f = vi.hoisted(() => ({ request: vi.fn(), unlock: vi.fn(), lock: vi.fn(), refresh: vi.fn(), earlier: vi.fn(), accessState: 'unlocked', task: null as unknown, status: null as unknown }));
vi.mock('../control/ControlAccess', () => ({ useControlAccess: () => ({ state: f.accessState, status: f.status, request: f.request, unlock: f.unlock, lock: f.lock }) }));
vi.mock('../control/useTaskDetails', () => ({ useTaskDetails: () => ({ selected: { sessionKey: 'agent:cylena:test' }, sessions: [], task: f.task, loading: false, error: null, refresh: f.refresh, loadEarlier: f.earlier, loadMoreSessions: vi.fn(), selectSession: vi.fn() }) }));
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:test', sessionId: 'session-1' };
afterEach(() => { cleanup(); vi.clearAllMocks(); f.accessState = 'unlocked'; f.task = null; f.status = null; });
describe('task drawer presentation', () => {
  it('displays source facts and a failed tool without changing the proven run result', () => {
    f.task = { target, source: { state: 'current', observedAt: 100 }, hasActiveRun: false, runState: 'completed', runId: 'run-1',
      requestAssociation: 'run', requestState: 'found', request: { text: '<script>fixture</script>', truncated: false }, result: { text: 'Review complete.', truncated: false },
      activity: [{ id: 'call-1', toolName: 'exec', outcome: 'error' }], children: [], childrenComplete: true, loadedRecords: 50, model: 'fixture/model' };
    render(<TaskDetails agentId="cylena" initialSessionKey={target.sessionKey} active />);
    expect(screen.getByText('Completed')).toBeInTheDocument(); expect(screen.getByText('Error recorded')).toBeInTheDocument(); expect(screen.getByText('Review complete.')).toBeInTheDocument();
    expect(screen.getByText('<script>fixture</script>')).toBeInTheDocument(); expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('fixture/model')).toBeInTheDocument();
  });
  it('shows unknown current task identity and an explicit history action', () => {
    f.task = { target, source: { state: 'stale', observedAt: 100 }, hasActiveRun: true, runState: 'running', requestAssociation: 'unknown', requestState: 'not-loaded', activity: [], children: [], childrenComplete: false, loadedRecords: 200, nextCursor: 'earlier' };
    render(<TaskDetails agentId="cylena" initialSessionKey={target.sessionKey} active />);
    expect(screen.getByText(/current task identity unavailable/i)).toBeInTheDocument(); expect(screen.getByText(/Last known/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier records' })); expect(f.earlier).toHaveBeenCalledOnce();
  });
  it('explains disabled setup without requesting an access key', async () => {
    f.accessState = 'locked'; f.status = { configured: false, state: 'disabled', canRead: false, canSend: false }; f.request.mockResolvedValue(f.status);
    render(<TaskDetails agentId="cylena" initialSessionKey={target.sessionKey} active />);
    await waitFor(() => expect(screen.getByText(/Task access is not connected/)).toBeInTheDocument()); expect(screen.queryByLabelText('Task access key')).not.toBeInTheDocument();
  });
  it('does not solicit a key before checking transport, or on unsafe HTTP', async () => {
    f.accessState = 'locked'; f.request.mockRejectedValue(new ControlApiError('transport-required'));
    render(<TaskDetails agentId="cylena" initialSessionKey={target.sessionKey} active />);
    expect(screen.queryByLabelText('Task access key')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('A secure connection is required')).toBeInTheDocument());
    expect(screen.queryByLabelText('Task access key')).not.toBeInTheDocument();
  });
});
