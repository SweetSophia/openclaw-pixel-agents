import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlTaskSnapshot } from '../../shared/control';
import { RunControls } from './RunControls';
import { ControlApiError } from '../control/api';

const f = vi.hoisted(() => ({ state: 'unlocked', generation: 1, request: vi.fn(), canRead: true, canSend: true, canStop: true, stopDisabledReason: undefined as string | undefined }));
vi.mock('../control/ControlAccess', () => ({ useControlAccess: () => ({ ...f, status: f }) }));
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 's1', lifecycleRevision: 'life-1' };
const task = (): ControlTaskSnapshot => ({ target, source: { state: 'current', observedAt: Date.now() }, hasActiveRun: true,
  activeRunIds: ['run1'], runId: 'run1', runState: 'running', requestAssociation: 'unknown', requestState: 'unavailable', activity: [], children: [], childrenComplete: true, loadedRecords: 1 });
afterEach(() => { cleanup(); vi.restoreAllMocks(); f.request.mockReset(); Object.assign(f, { state: 'unlocked', generation: 1, canRead: true, canSend: true, canStop: true, stopDisabledReason: undefined }); });
describe('exact-run Stop controls', () => {
  it('requires named confirmation, focuses Cancel, consumes Escape and returns focus without a write', () => {
    const escape = vi.fn(); render(<div onKeyDown={escape}><RunControls task={task()} active onRefresh={vi.fn()} /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    expect(screen.getByRole('group', { name: 'Confirm Stop' })).toHaveTextContent('run1');
    expect(screen.getByText(/Controlled child work may also stop/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel Stop' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(escape).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Confirm Stop' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop run' })).toHaveFocus(); expect(f.request).not.toHaveBeenCalled();
  });
  it('coalesces duplicate confirmations, labels admission requested and refreshes task facts', async () => {
    let resolve!: (value: unknown) => void; f.request.mockImplementation(() => new Promise(done => { resolve = done; }));
    const refresh = vi.fn(); render(<RunControls task={task()} active onRefresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' })); const confirm = screen.getByRole('button', { name: 'Confirm Stop' });
    fireEvent.click(confirm); fireEvent.click(confirm); expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0][0]).toBe('/api/control/agents/cylena/stop'); expect(JSON.parse(f.request.mock.calls[0][1].body)).toEqual({ target, runId: 'run1' });
    await act(async () => resolve({ target, runId: 'run1', phase: 'requested' }));
    expect(screen.getByRole('status')).toHaveTextContent('Stop requested'); expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Stop run' })).toHaveAttribute('aria-disabled', 'true');
  });
  it.each(['stale', 'old', 'ambiguous', 'historical', 'locked', 'unsupported', 'read-only'] as const)('explains and prevents Stop for %s facts', mode => {
    const snapshot = task(); if (mode === 'stale') snapshot.source.state = 'stale'; if (mode === 'old') snapshot.source.observedAt -= 16000;
    if (mode === 'ambiguous') snapshot.activeRunIds = ['run1', 'run2']; if (mode === 'locked') f.state = 'locked';
    if (mode === 'unsupported') { f.canStop = false; f.stopDisabledReason = 'unsupported'; } if (mode === 'read-only') { f.canSend = false; f.canStop = false; f.stopDisabledReason = 'scope-required'; }
    render(<RunControls task={snapshot} active readOnly={mode === 'historical'} onRefresh={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Stop run' }); expect(button).toHaveAttribute('aria-disabled', 'true'); expect(button).toHaveAccessibleDescription();
    fireEvent.click(button); expect(screen.queryByRole('button', { name: 'Confirm Stop' })).toBeNull(); expect(f.request).not.toHaveBeenCalled();
  });
  it('uses the independent Stop capability even when conversation sending is unsupported', () => {
    f.canSend = false; render(<RunControls task={task()} active onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' })); expect(screen.getByRole('button', { name: 'Confirm Stop' })).toBeInTheDocument();
  });
  it('rechecks freshness when confirmation is submitted without a render', () => {
    const snapshot = task(); render(<RunControls task={snapshot} active onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' })); vi.spyOn(Date, 'now').mockReturnValue(snapshot.source.observedAt + 16000);
    const confirm = screen.getByRole('button', { name: 'Confirm Stop' }); confirm.focus(); fireEvent.click(confirm);
    expect(f.request).not.toHaveBeenCalled(); expect(screen.queryByRole('group', { name: 'Confirm Stop' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop run' })).toHaveFocus();
  });
  it.each(['stale', 'ambiguous'] as const)('restores Stop focus when %s facts invalidate an open confirmation without changing its scope', mode => {
    const snapshot = task(); const view = render(<RunControls task={snapshot} active onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' })); expect(screen.getByRole('button', { name: 'Cancel Stop' })).toHaveFocus();
    const invalidated = mode === 'stale' ? { ...snapshot, source: { ...snapshot.source, state: 'stale' as const } } : { ...snapshot, activeRunIds: ['run1', 'run2'] };
    view.rerender(<RunControls task={invalidated} active onRefresh={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Confirm Stop' })).toBeNull(); expect(screen.getByRole('button', { name: 'Stop run' })).toHaveFocus();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('refreshes unknown outcomes without replay across activity changes', async () => {
    f.request.mockRejectedValue(new ControlApiError('timed-out')); const refresh = vi.fn(); const snapshot = task();
    const view = render(<RunControls task={snapshot} active onRefresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm Stop' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('outcome is unknown'));
    view.rerender(<RunControls task={snapshot} active={false} onRefresh={refresh} />); view.rerender(<RunControls task={snapshot} active onRefresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' })); expect(f.request).toHaveBeenCalledOnce(); expect(refresh).toHaveBeenCalledOnce();
  });
  it('retains an admitted result across tab switches without background refresh or replay', async () => {
    let resolve!: (value: unknown) => void; f.request.mockImplementation(() => new Promise(done => { resolve = done; }));
    const refresh = vi.fn(); const snapshot = task(); const view = render(<RunControls task={snapshot} active onRefresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm Stop' }));
    view.rerender(<RunControls task={snapshot} active={false} onRefresh={refresh} />);
    await act(async () => resolve({ target, runId: 'run1', phase: 'requested' })); expect(refresh).not.toHaveBeenCalled();
    view.rerender(<RunControls task={snapshot} active onRefresh={refresh} />);
    expect(screen.getByRole('status')).toHaveTextContent('Stop requested'); expect(f.request).toHaveBeenCalledOnce();
  });
  it('reports ownership denial without locking private reads', async () => {
    f.request.mockRejectedValue(new ControlApiError('stop-denied')); render(<RunControls task={task()} active onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm Stop' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/owning device/)); expect(f.state).toBe('unlocked');
  });
  it('cancels replaced confirmations and ignores late responses after lock', async () => {
    let resolve!: (value: unknown) => void; f.request.mockImplementation(() => new Promise(done => { resolve = done; })); const refresh = vi.fn();
    const view = render(<RunControls task={task()} active onRefresh={refresh} />); fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    const replacement = { ...task(), runId: 'run2', activeRunIds: ['run2'] }; view.rerender(<RunControls task={replacement} active onRefresh={refresh} />);
    expect(screen.queryByRole('button', { name: 'Confirm Stop' })).toBeNull(); expect(screen.getByRole('button', { name: 'Stop run' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm Stop' }));
    f.state = 'locked'; f.generation++; view.rerender(<RunControls task={replacement} active onRefresh={refresh} />);
    await act(async () => resolve({ target, runId: 'run2', phase: 'requested' })); expect(refresh).not.toHaveBeenCalled(); expect(screen.queryByText(/Stop requested/)).toBeNull();
  });
});
