import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LayoutEditor } from './LayoutEditor';
import type { LayoutDoc } from '../hooks/useLayoutStore';

const defaultLayout: LayoutDoc = {
  id: 'default',
  name: 'Default',
  width: 24,
  height: 16,
  furniture: [],
  seats: {},
  updatedAt: 1,
};

function makeProps(overrides: Partial<React.ComponentProps<typeof LayoutEditor>> = {}) {
  return {
    catalog: [],
    activeLayout: defaultLayout,
    isDirty: false,
    layoutError: null,
    layouts: [defaultLayout],
    editorMode: true,
    selectedFurnitureType: null,
    selectedFurnitureId: null,
    deleteMode: false,
    onSelectFurnitureType: vi.fn(),
    onSelectFurnitureId: vi.fn(),
    onPlaceFurniture: vi.fn(),
    onMoveFurniture: vi.fn(),
    onRotateFurniture: vi.fn(),
    onDeleteFurniture: vi.fn(),
    onToggleDeleteMode: vi.fn(),
    onSave: vi.fn(),
    onLoad: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(defaultLayout),
    onClearLayoutError: vi.fn(),
    onDeleteLayout: vi.fn().mockResolvedValue(true),
    onToggleEditor: vi.fn(),
    ...overrides,
  };
}

function openLayoutManager() {
  fireEvent.click(screen.getByTitle('Layout manager'));
  return screen.getByPlaceholderText('New layout name...') as HTMLInputElement;
}

describe('LayoutEditor layout creation recovery', () => {
  afterEach(cleanup);

  it('preserves the entered name and shows the store warning after a failed create', async () => {
    const errorMessage = 'Layout limit reached (100). Delete unused layouts until the warning clears.';

    function Harness() {
      const [layoutError, setLayoutError] = useState<string | null>(null);
      return (
        <LayoutEditor
          {...makeProps({
            layoutError,
            onCreate: async () => {
              setLayoutError(errorMessage);
              return null;
            },
          })}
        />
      );
    }

    render(<Harness />);
    const input = openLayoutManager();
    fireEvent.change(input, { target: { value: 'Overflow recovery' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent(errorMessage);
    await waitFor(() => expect(input.value).toBe('Overflow recovery'));
  });

  it('clears the entered name only after a successful create', async () => {
    const onCreate = vi.fn().mockResolvedValue({
      ...defaultLayout,
      id: 'new-layout',
      name: 'New Layout',
    });
    render(<LayoutEditor {...makeProps({ onCreate })} />);
    const input = openLayoutManager();
    fireEvent.change(input, { target: { value: 'New Layout' } });
    fireEvent.click(screen.getByRole('button', { name: '➕ Create' }));

    expect(onCreate).toHaveBeenCalledWith('New Layout');
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('shows a pending state and prevents duplicate submissions', async () => {
    let resolveCreate!: (layout: LayoutDoc | null) => void;
    const onCreate = vi.fn(() => new Promise<LayoutDoc | null>(resolve => {
      resolveCreate = resolve;
    }));
    render(<LayoutEditor {...makeProps({ onCreate })} />);
    const input = openLayoutManager();
    const form = input.closest('form')!;
    fireEvent.change(input, { target: { value: 'Slow Layout' } });
    fireEvent.submit(form);

    const pendingButton = screen.getByRole('button', { name: 'Creating…' });
    expect(pendingButton).toBeDisabled();
    expect(input).toHaveProperty('readOnly', true);
    fireEvent.submit(form);
    expect(onCreate).toHaveBeenCalledOnce();

    resolveCreate(null);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '➕ Create' })).not.toBeDisabled();
      expect(input).toHaveProperty('readOnly', false);
    });
  });

  it('calls the store dismiss action from the warning control', () => {
    const onClearLayoutError = vi.fn();
    render(
      <LayoutEditor
        {...makeProps({
          layoutError: 'Failed to create layout. Try again.',
          onClearLayoutError,
        })}
      />,
    );
    openLayoutManager();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss layout warning' }));
    expect(onClearLayoutError).toHaveBeenCalledOnce();
  });
});
