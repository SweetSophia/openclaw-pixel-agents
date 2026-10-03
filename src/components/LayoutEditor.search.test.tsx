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

  it('registers its empty live region before opening and preserves it across filtered panel reopening', () => {
    render(<LayoutEditor {...makeProps()} />);
    const status = screen.getByRole('status', { name: 'Furniture search feedback' });
    expect(status).toBeEmptyDOMElement();
    let input = openPalette();
    fireEvent.change(input, { target: { value: 'does not exist' } });
    expect(status).toHaveTextContent('No furniture matches');
    fireEvent.click(screen.getByTitle('Layout manager'));
    expect(screen.getByRole('status', { name: 'Furniture search feedback' })).toBe(status);
    expect(status).toBeEmptyDOMElement();
    input = openPalette();
    expect(input).toHaveValue('does not exist');
    expect(screen.getByRole('status', { name: 'Furniture search feedback' })).toBe(status);
    expect(status).toHaveTextContent('No furniture matches');
  });

  it('shows a useful no-results message and clear restores the catalog and search focus', async () => {
    const user = userEvent.setup();
    render(<LayoutEditor {...makeProps()} />);
    const input = openPalette();
    // AT must be able to register the empty region before its text changes.
    const status = screen.getByRole('status', { name: 'Furniture search feedback' });
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveAttribute('aria-live', 'polite');
    await user.type(input, 'no such furniture');
    expect(screen.getByRole('status', { name: 'Furniture search feedback' })).toBe(status);
    expect(status).toHaveTextContent('No furniture matches');
    expect(screen.getByRole('status', { name: 'Furniture search feedback' })).toHaveTextContent('Clear the search');
    expect(paletteItems(input)).toHaveLength(0);
    expect(screen.queryByText('Plants')).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Clear furniture search' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(paletteItems(input)).toHaveLength(6);
    expect(screen.getByRole('status', { name: 'Furniture search feedback' })).toBe(status);
    expect(status).toBeEmptyDOMElement();
  });

  it('distinguishes an empty catalog from a query with no matches', () => {
    render(<LayoutEditor {...makeProps({ catalog: [] })} />);
    const status = screen.getByRole('status', { name: 'Furniture search feedback' });
    expect(status).toBeEmptyDOMElement();
    const input = openPalette();
    expect(status).toHaveTextContent('Furniture catalog is not loaded or is unavailable.');
    expect(screen.getByRole('button', { name: 'Clear furniture search' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'plant' } });
    expect(status).toHaveTextContent('Furniture catalog is not loaded or is unavailable.');
    expect(status).not.toHaveTextContent('No furniture matches');
    fireEvent.click(screen.getByTitle('Layout manager'));
    expect(screen.getByRole('status', { name: 'Furniture search feedback' })).toBe(status);
    expect(status).toBeEmptyDOMElement();
    const reopened = openPalette();
    expect(reopened).toHaveValue('plant');
    expect(screen.getByRole('status', { name: 'Furniture search feedback' })).toBe(status);
    expect(status).toHaveTextContent('Furniture catalog is not loaded or is unavailable.');
  });

  it('focuses on explicit open, preserves query across panel toggles, and never steals focus on rerender', () => {
    const props = makeProps();
    const { rerender } = render(<LayoutEditor {...props} />);
    let input = openPalette();
    expect(input).toHaveFocus();
    const toggle = screen.getByTitle('Furniture palette');
    const panel = input.closest('.furniture-palette')!;
    expect(panel.id).not.toBe('');
    expect(toggle).toHaveAttribute('aria-controls', panel.id);
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
    function ControlledEditor() {
      const [selected, setSelected] = React.useState<string | null>('DESK');
      return <LayoutEditor {...props} selectedFurnitureType={selected}
        onSelectFurnitureType={type => { props.onSelectFurnitureType(type); setSelected(type); }} />;
    }
    render(<ControlledEditor />);
    const input = openPalette();
    fireEvent.change(input, { target: { value: 'plant' } });
    expect(screen.getByText(/Click the office floor to place Desk/)).toBeInTheDocument();
    expect(props.onSelectFurnitureType).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Plant'));
    expect(props.onSelectFurnitureType).toHaveBeenLastCalledWith('PLANT');
    fireEvent.click(screen.getByRole('button', { name: 'Clear furniture search' }));
    expect(screen.getByTitle('Plant')).toHaveClass('selected');
    fireEvent.click(screen.getByTitle('Layout manager'));
    openPalette();
    expect(screen.getByTitle('Plant')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Click the office floor to place Plant/)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Plant'));
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

  it('clears search from a keyboard-focused result without bubbling Escape or cancelling selection', async () => {
    const user = userEvent.setup();
    render(<LayoutEditor {...makeProps({ selectedFurnitureType: 'DESK' })} />);
    const input = openPalette();
    const windowEscape = vi.fn();
    window.addEventListener('keydown', windowEscape);
    try {
      await user.type(input, 'plant');
      await user.tab();
      await user.tab();
      expect(screen.getByTitle('Large Plant')).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(input).toHaveValue('');
      expect(input).toHaveFocus();
      expect(screen.getByText(/Click the office floor to place Desk/)).toBeInTheDocument();
      expect(windowEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', windowEscape);
    }
  });

  it('keeps ordinary result keydown/keyup events bubbling but contains both Escape phases', () => {
    render(<LayoutEditor {...makeProps()} />);
    const input = openPalette();
    const result = screen.getByTitle('Desk');
    const documentKey = vi.fn();
    const windowKey = vi.fn();
    document.addEventListener('keydown', documentKey);
    document.addEventListener('keyup', documentKey);
    window.addEventListener('keydown', windowKey);
    window.addEventListener('keyup', windowKey);
    try {
      result.focus();
      fireEvent.keyDown(result, { key: 'r' });
      fireEvent.keyUp(result, { key: 'r' });
      expect(documentKey.mock.calls.map(([event]) => [event.type, event.key]))
        .toEqual([['keydown', 'r'], ['keyup', 'r']]);
      expect(windowKey).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(result, { key: 'Escape' });
      fireEvent.keyUp(result, { key: 'Escape' });
      expect(documentKey).toHaveBeenCalledTimes(2);
      expect(windowKey).toHaveBeenCalledTimes(2);
      expect(input).toHaveFocus();
    } finally {
      document.removeEventListener('keydown', documentKey);
      document.removeEventListener('keyup', documentKey);
      window.removeEventListener('keydown', windowKey);
      window.removeEventListener('keyup', windowKey);
    }
  });

  it('gives each editor unique disclosure relationships only while the panels are mounted', () => {
    const { container } = render(<><LayoutEditor {...makeProps()} /><LayoutEditor {...makeProps()} /></>);
    const ids = new Set<string>();
    for (const editor of Array.from(container.querySelectorAll<HTMLElement>('.layout-editor'))) {
      const controls = within(editor);
      const furniture = controls.getByTitle('Furniture palette');
      const layouts = controls.getByTitle('Layout manager');
      for (const toggle of [furniture, layouts]) {
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(toggle).not.toHaveAttribute('aria-controls');
      }
      fireEvent.click(furniture);
      const palette = controls.getByRole('searchbox').closest('.furniture-palette')!;
      expect(furniture).toHaveAttribute('aria-expanded', 'true');
      expect(furniture).toHaveAttribute('aria-controls', palette.id);
      ids.add(palette.id);
      fireEvent.click(layouts);
      expect(furniture).toHaveAttribute('aria-expanded', 'false');
      expect(furniture).not.toHaveAttribute('aria-controls');
      expect(palette).not.toBeInTheDocument();
      const manager = controls.getByLabelText('New layout name').closest('.layout-manager')!;
      expect(layouts).toHaveAttribute('aria-expanded', 'true');
      expect(layouts).toHaveAttribute('aria-controls', manager.id);
      ids.add(manager.id);
      fireEvent.click(layouts);
      expect(layouts).toHaveAttribute('aria-expanded', 'false');
      expect(layouts).not.toHaveAttribute('aria-controls');
      expect(manager).not.toBeInTheDocument();
    }
    expect(ids.size).toBe(4);
    expect(ids.has('')).toBe(false);
  });

  it('advertises click actions without nonexistent shortcut labels and still invokes them', () => {
    const props = makeProps({
      activeLayout: { ...layout, furniture: [{ id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 0 }] },
      selectedFurnitureId: 'desk-1',
    });
    render(<LayoutEditor {...props} />);
    expect(screen.queryByTitle('Rotate (R)')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Delete (Del)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Rotate'));
    fireEvent.click(screen.getByTitle('Delete'));
    expect(props.onRotateFurniture).toHaveBeenCalledWith('desk-1');
    expect(props.onDeleteFurniture).toHaveBeenCalledWith('desk-1');
  });

  it('does not clear a query on an IME composition Escape', () => {
    render(<LayoutEditor {...makeProps()} />);
    const input = openPalette();
    fireEvent.change(input, { target: { value: 'plant' } });
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(input).toHaveValue('plant');
  });
});
