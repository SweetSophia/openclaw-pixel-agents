import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ControlAccessPanel } from './ControlAccessPanel';

const access = vi.hoisted(() => ({ request: vi.fn(async () => ({})), lock: vi.fn(), unlock: vi.fn(), state: 'locked', generation: 1,
  status: { configured: true, state: 'ready', canRead: false, canSend: false } }));
vi.mock('../control/ControlAccess', () => ({ useControlAccess: () => access }));
afterEach(cleanup);
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
