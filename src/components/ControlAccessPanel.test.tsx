import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ControlAccessPanel } from './ControlAccessPanel';

const access = vi.hoisted(() => ({ request: vi.fn(async () => ({})), lock: vi.fn(), unlock: vi.fn(), state: 'locked', generation: 1,
  status: { configured: true, state: 'ready', canRead: false, canSend: false } }));
vi.mock('../control/ControlAccess', () => ({ useControlAccess: () => access }));
afterEach(() => { cleanup(); access.state = 'locked'; access.request.mockClear(); });
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
