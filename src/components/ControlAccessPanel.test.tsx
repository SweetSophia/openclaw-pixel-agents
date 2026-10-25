import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ControlAccessPanel } from './ControlAccessPanel';
import { ControlApiError } from '../control/api';

const access = vi.hoisted(() => ({ request: vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({})), lock: vi.fn(), unlock: vi.fn(), state: 'locked', generation: 1,
  status: { configured: true, state: 'ready', canRead: false, canSend: false } }));
vi.mock('../control/ControlAccess', () => ({ useControlAccess: () => access }));
afterEach(() => { cleanup(); access.state = 'locked'; access.status.configured = true; access.request.mockReset().mockResolvedValue({}); vi.useRealTimers(); });
it('preserves a draft key while locked status checks advance the generation or the tab changes', () => {
  const refresh = async () => {};
  const { rerender } = render(<ControlAccessPanel active loading={false} onRefresh={refresh} />);
  const input = screen.getByLabelText('Task access key'); fireEvent.change(input, { target: { value: 'draft-key' } });
  access.generation++;
  rerender(<ControlAccessPanel active loading={false} onRefresh={refresh} />);
  expect(input).toHaveValue('draft-key');
  rerender(<ControlAccessPanel active={false} loading={false} onRefresh={refresh} />);
  rerender(<ControlAccessPanel active loading={false} onRefresh={refresh} />);
  expect(input).toHaveValue('draft-key');
});
it('unlocks Refresh after a stalled status request times out and permits retry', async () => {
  vi.useFakeTimers(); access.state = 'unlocked'; const refresh = vi.fn(async () => {});
  render(<ControlAccessPanel active loading={false} onRefresh={refresh} />);
  await act(async () => {}); access.request.mockClear();
  access.request.mockImplementationOnce((_path, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new ControlApiError('unavailable')), { once: true });
  }));
  const button = screen.getByRole('button', { name: 'Refresh' }); fireEvent.click(button);
  expect(button).toHaveAttribute('aria-disabled', 'true');
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(screen.getByRole('alert')).toHaveTextContent(/timed out/i);
  expect(button).toHaveAttribute('aria-disabled', 'false'); expect(refresh).not.toHaveBeenCalled();
  const requestsBeforeRetry = access.request.mock.calls.length;
  await act(async () => { fireEvent.click(button); });
  expect(access.request).toHaveBeenCalledTimes(requestsBeforeRetry + 1); expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).toBeNull();
});
it('announces an in-flight locked Check connection and coalesces retries', async () => {
  access.status.configured = false; let release!: (value: unknown) => void;
  render(<ControlAccessPanel active loading={false} onRefresh={async () => {}} />);
  await act(async () => {}); access.request.mockClear();
  access.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
  const button = screen.getByRole('button', { name: 'Checking…' });
  expect(button).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(button);
  expect(access.request).toHaveBeenCalledTimes(1);
  await act(async () => { release({}); });
  expect(screen.getByRole('button', { name: 'Check connection' })).toHaveAttribute('aria-disabled', 'false');
});
it('bounds the whole reload after a successful status probe', async () => {
  vi.useFakeTimers(); access.state = 'unlocked';
  const refresh = vi.fn((_signal?: AbortSignal) => new Promise<void>(() => {}));
  render(<ControlAccessPanel active loading={false} onRefresh={refresh} />);
  await act(async () => {}); fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(refresh.mock.calls[0][0]?.aborted).toBe(true);
  expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute('aria-disabled', 'false');
  expect(screen.getByRole('alert')).toHaveTextContent(/timed out/i);
});
it('shows a current failure before the previous manual timeout', async () => {
  vi.useFakeTimers(); access.state = 'unlocked'; const refresh = () => new Promise<void>(() => {});
  const { rerender } = render(<ControlAccessPanel active loading={false} onRefresh={refresh} />);
  await act(async () => {}); fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await act(() => vi.advanceTimersByTimeAsync(10000));
  rerender(<ControlAccessPanel active loading={false} onRefresh={refresh} error="This conversation changed. Select it again." />);
  expect(screen.getByRole('alert').textContent).toMatch(/^This conversation changed/);
  expect(screen.getByRole('alert')).toHaveTextContent(/last manual refresh.*timed out/i);
});
it('keeps locked retry available when an aborted body read is reported as invalid-source', async () => {
  vi.useFakeTimers(); access.request.mockRejectedValueOnce(new ControlApiError('unavailable'));
  render(<ControlAccessPanel active loading={false} onRefresh={async () => {}} />);
  await act(async () => {});
  access.request.mockImplementationOnce((_path, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new ControlApiError('invalid-source')), { once: true });
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(screen.getByRole('button', { name: 'Check connection' })).toHaveAttribute('aria-disabled', 'false');
});
it.each(['transport-required', 'locked'] as const)('keeps a manual timeout visible and retryable beside a %s access failure', async code => {
  vi.useFakeTimers(); access.request.mockRejectedValueOnce(new ControlApiError('transport-required'));
  const refresh = vi.fn(async () => {});
  const { rerender } = render(<ControlAccessPanel active loading={false} onRefresh={refresh} />);
  await act(async () => {});
  access.request.mockImplementationOnce(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
  access.request.mockRejectedValueOnce(new ControlApiError(code));
  rerender(<ControlAccessPanel active={false} loading={false} onRefresh={refresh} />);
  rerender(<ControlAccessPanel active loading={false} onRefresh={refresh} />);
  await act(async () => {}); await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(screen.getByRole('alert')).toHaveTextContent('The request timed out. Try again.');
  expect(screen.getByRole('alert')).not.toHaveTextContent(new ControlApiError(code).message);
  const button = screen.getByRole('button', { name: 'Check connection' });
  expect(button).toHaveAttribute('aria-disabled', 'false');
  await act(async () => { fireEvent.click(button); });
  expect(refresh).toHaveBeenCalledOnce(); expect(screen.queryByRole('alert')).toBeNull();
});
it('coalesces manual Refresh clicks while allowing the first to replace a background load', async () => {
  access.state = 'unlocked'; let release!: () => void;
  const refresh = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  render(<ControlAccessPanel active loading allowRefreshWhileLoading onRefresh={refresh} />);
  await act(async () => {}); access.request.mockClear();
  const button = screen.getByRole('button', { name: 'Refresh' });
  await act(async () => { fireEvent.click(button); });
  fireEvent.click(button); fireEvent.click(button);
  await act(async () => {});
  expect(refresh).toHaveBeenCalledTimes(1); expect(access.request).toHaveBeenCalledTimes(1);
  expect(button).toHaveAttribute('aria-disabled', 'true');
  await act(async () => { release(); }); expect(button).toHaveAttribute('aria-disabled', 'false');
});
