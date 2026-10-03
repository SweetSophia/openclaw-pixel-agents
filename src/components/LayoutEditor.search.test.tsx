import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LayoutEditor } from './LayoutEditor';
import type { LayoutDoc } from '../hooks/useLayoutStore';

const layout: LayoutDoc = {
  id: 'default', name: 'Default', width: 24, height: 16,
  furniture: [], seats: {}, updatedAt: 1,
};

function makeProps(overrides: Partial<React.ComponentProps<typeof LayoutEditor>> = {}) {
  return {
    catalog: ['DESK', 'LARGE_PLANT', 'PLANT', 'PC', 'LARGE_PAINTING', 'DOUBLE_BOOKSHELF'],
    activeLayout: layout, isDirty: false, layoutError: null, layouts: [layout],
    editorMode: true, selectedFurnitureType: null, selectedFurnitureId: null, deleteMode: false,
    onSelectFurnitureType: vi.fn(), onSelectFurnitureId: vi.fn(),
    onPlaceFurniture: vi.fn(), onMoveFurniture: vi.fn(), onRotateFurniture: vi.fn(),
    onDeleteFurniture: vi.fn(), onToggleDeleteMode: vi.fn(), onSave: vi.fn(),
    onLoad: vi.fn(), onCreate: vi.fn().mockResolvedValue(layout),
    onClearLayoutError: vi.fn(), onDeleteLayout: vi.fn().mockResolvedValue(true),
    onToggleEditor: vi.fn(), ...overrides,
  };
}

function openPalette() {
  fireEvent.click(screen.getByTitle('Furniture palette'));
  return screen.getByRole('searchbox', { name: 'Search furniture' }) as HTMLInputElement;
}

function paletteItems(input: HTMLInputElement) {
  return Array.from(input.closest('.furniture-palette')!.querySelectorAll('.palette-item'));
}

describe('LayoutEditor searchable furniture palette', () => {
  afterEach(cleanup);

  it.each([
    ['  lArGe PlAnT  ', 'Large Plant'],
    ['LARGE_PLANT', 'Large Plant'],
    ['lg painting', 'Lg Painting'],
    ['large painting', 'Lg Painting'],
    ['double bookshelf', 'Dbl Bookshelf'],
  ])('matches display labels and readable/raw types for %s', (query, label) => {
    render(<LayoutEditor {...makeProps()} />);
    const input = openPalette();
    fireEvent.change(input, { target: { value: query } });
    expect(paletteItems(input)).toHaveLength(1);
    expect(paletteItems(input)[0]).toHaveTextContent(label);
  });

  it('shows only catalog items, hides empty categories, and treats whitespace as no filter', () => {
    render(<LayoutEditor {...makeProps({ catalog: ['DESK', 'LARGE_PLANT'] })} />);
    const input = openPalette();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(paletteItems(input)).toHaveLength(2);
    expect(screen.queryByText('Electronics')).not.toBeInTheDocument();
    expect(screen.queryByText('Tables & Decor')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'plant' } });
    expect(paletteItems(input)).toHaveLength(1);
    expect(screen.queryByText('Desks & Seating')).not.toBeInTheDocument();
    expect(screen.getByText('Plants')).toBeInTheDocument();
    expect(screen.queryByTitle('Plant')).not.toBeInTheDocument();
  });

  it('shows a useful no-results message and clear restores the catalog and search focus', async () => {
    const user = userEvent.setup();
    render(<LayoutEditor {...makeProps()} />);
    const input = openPalette();
    await user.type(input, 'no such furniture');
    const palette = within(input.closest('.furniture-palette')! as HTMLElement);
    expect(palette.getByRole('status')).toHaveTextContent('No furniture matches');
    expect(palette.getByRole('status')).toHaveTextContent('Clear the search');
    expect(paletteItems(input)).toHaveLength(0);
    expect(screen.queryByText('Plants')).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Clear furniture search' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(paletteItems(input)).toHaveLength(6);
    expect(palette.queryByRole('status')).not.toBeInTheDocument();
  });

  it('distinguishes an empty catalog from a query with no matches', () => {
    render(<LayoutEditor {...makeProps({ catalog: [] })} />);
    const input = openPalette();
    expect(within(input.closest('.furniture-palette')! as HTMLElement).getByRole('status'))
      .toHaveTextContent('No furniture available');
    expect(screen.getByRole('button', { name: 'Clear furniture search' })).toBeDisabled();
  });

  it('focuses on explicit open, preserves query across panel toggles, and never steals focus on rerender', () => {
    const props = makeProps();
    const { rerender } = render(<LayoutEditor {...props} />);
    let input = openPalette();
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'plant' } });
    const plant = screen.getByTitle('Plant');
    plant.focus();
    rerender(<LayoutEditor {...props} isDirty saveStatus="saving" catalog={[...props.catalog]} />);
    expect(plant).toHaveFocus();
    expect(input).toHaveValue('plant');
    fireEvent.click(screen.getByTitle('Layout manager'));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText('New layout name')).toBeInTheDocument();
    input = openPalette();
    expect(input).toHaveFocus();
    expect(input).toHaveValue('plant');
    expect(screen.queryByLabelText('New layout name')).not.toBeInTheDocument();
  });

  it('keeps the filter current when the catalog changes without moving focus', () => {
    const props = makeProps();
    const { rerender } = render(<LayoutEditor {...props} />);
    const input = openPalette();
    fireEvent.change(input, { target: { value: 'plant' } });
    expect(paletteItems(input)).toHaveLength(2);
    rerender(<LayoutEditor {...props} catalog={['DESK']} />);
    expect(paletteItems(input)).toHaveLength(0);
    expect(input).toHaveValue('plant');
    expect(input).toHaveFocus();
    rerender(<LayoutEditor {...props} catalog={['LARGE_PLANT']} />);
    expect(paletteItems(input)).toHaveLength(1);
    expect(paletteItems(input)[0]).toHaveTextContent('Large Plant');
  });

  it('allows Tab and Enter to select a matching furniture item', async () => {
    const user = userEvent.setup();
    const props = makeProps({ selectedFurnitureType: 'DESK' });
    render(<LayoutEditor {...props} />);
    openPalette();
    // Empty query disables Clear, so Tab goes straight to the first item.
    await user.tab();
    expect(screen.getByTitle('Desk')).toHaveFocus();
    expect(screen.getByTitle('Desk')).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{Enter}');
    expect(props.onSelectFurnitureType).toHaveBeenCalledWith(null);
    await user.tab();
    expect(screen.getByTitle('Large Plant')).toHaveFocus();
    await user.keyboard(' ');
    expect(props.onSelectFurnitureType).toHaveBeenLastCalledWith('LARGE_PLANT');
  });

  it('preserves a filtered-out placement selection and keeps item toggle behavior', () => {
    const props = makeProps({ selectedFurnitureType: 'DESK' });
    render(<LayoutEditor {...props} />);
    const input = openPalette();
    fireEvent.change(input, { target: { value: 'plant' } });
    expect(screen.getByText(/Click the office floor to place Desk/)).toBeInTheDocument();
    expect(props.onSelectFurnitureType).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Plant'));
    expect(props.onSelectFurnitureType).toHaveBeenLastCalledWith('PLANT');
    fireEvent.click(screen.getByRole('button', { name: 'Clear furniture search' }));
    expect(screen.getByTitle('Desk')).toHaveClass('selected');
    fireEvent.click(screen.getByTitle('Desk'));
    expect(props.onSelectFurnitureType).toHaveBeenLastCalledWith(null);
    expect(props.onDeleteFurniture).not.toHaveBeenCalled();
    expect(props.onToggleEditor).not.toHaveBeenCalled();
  });

  it('isolates typing and Escape from document/window shortcuts without blocking native typing or Tab', async () => {
    const user = userEvent.setup();
    render(<LayoutEditor {...makeProps({ selectedFurnitureType: 'DESK' })} />);
    const input = openPalette();
    const documentKey = vi.fn();
    const windowKey = vi.fn();
    document.addEventListener('keydown', documentKey);
    window.addEventListener('keydown', windowKey);
    window.addEventListener('keyup', windowKey);
    try {
      await user.type(input, 'r');
      await user.keyboard('{Delete}{Backspace}');
      expect(input).toHaveValue('');
      await user.type(input, 'plant');
      await user.keyboard('{Escape}');
      expect(input).toHaveValue('');
      expect(input).toHaveFocus();
      expect(screen.getByText(/Click the office floor to place Desk/)).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(input).toHaveFocus();
      await user.type(input, 'pc');
      await user.tab();
      expect(screen.getByRole('button', { name: 'Clear furniture search' })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(input).toHaveValue('');
      expect(input).toHaveFocus();
      expect(documentKey).not.toHaveBeenCalled();
      expect(windowKey).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', documentKey);
      window.removeEventListener('keydown', windowKey);
      window.removeEventListener('keyup', windowKey);
    }
  });

  it('does not clear a query on an IME composition Escape', () => {
    render(<LayoutEditor {...makeProps()} />);
    const input = openPalette();
    fireEvent.change(input, { target: { value: 'plant' } });
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(input).toHaveValue('plant');
  });
});
