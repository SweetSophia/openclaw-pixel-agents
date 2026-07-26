/**
 * Issue #109 — Delete confirmation guard for custom layouts.
 *
 * Semantic anchors: Fail-Safe / Guard Pattern, Defense in Depth.
 * The component owns the user-facing confirmation barrier; the store and
 * server remain raw delete primitives. These tests pin the barrier so it
 * cannot be silently removed.
 *
 * Test cases (mapped from issue #109):
 *   1. Clicking Delete opens confirmation containing the layout name.
 *   2. Cancel retains the row and never calls onDeleteLayout.
 *   3. Confirm calls onDeleteLayout exactly once with the correct id.
 *   4. Default layout exposes no delete control.
 *   5. Store deletion tests use an explicit DELETE mock branch.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const customLayout: LayoutDoc = {
  id: 'qa-layout',
  name: 'QA Layout',
  width: 24,
  height: 16,
  furniture: [
    { id: 'f1', type: 'DESK', x: 3, y: 4, rotation: 0 },
  ],
  seats: { cybera: { x: 3, y: 5 } },
  updatedAt: 1721900000000,
};

function makeProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    catalog: ['DESK'],
    activeLayout: defaultLayout,
    isDirty: false,
    layouts: [defaultLayout, customLayout],
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
    onCreate: vi.fn(),
    onDeleteLayout: vi.fn(),
    onToggleEditor: vi.fn(),
    ...overrides,
  };
}

describe('Issue #109 — delete confirmation guard', () => {
  afterEach(cleanup);

  // ── Test 1: Clicking Delete opens confirmation ─────────────────────

  it('opens a confirmation dialog containing the layout name when Delete is clicked', () => {
    render(<LayoutEditor {...makeProps()} />);

    // Open the layout manager
    fireEvent.click(screen.getByTitle('Layout manager'));

    // Click the delete button for the custom layout
    const deleteBtn = screen.getByLabelText('Delete QA Layout');
    fireEvent.click(deleteBtn);

    // Confirmation dialog must be visible and contain the layout name
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('QA Layout');
    expect(dialog.textContent).toContain('cannot be undone');
  });

  // ── Test 2: Cancel retains the row and never calls onDeleteLayout ──

  it('does not call onDeleteLayout and keeps the layout row when Cancel is clicked', () => {
    const props = makeProps();
    render(<LayoutEditor {...props} />);

    fireEvent.click(screen.getByTitle('Layout manager'));
    fireEvent.click(screen.getByLabelText('Delete QA Layout'));

    // Cancel
    fireEvent.click(screen.getByText('Cancel'));

    // Store delete was never called
    expect(props.onDeleteLayout).not.toHaveBeenCalled();

    // Layout row is still present
    expect(screen.getByText('QA Layout')).toBeTruthy();
  });

  // ── Test 3: Confirm calls onDeleteLayout exactly once ───────────────

  it('calls onDeleteLayout exactly once with the correct id when Delete is confirmed', () => {
    const props = makeProps();
    render(<LayoutEditor {...props} />);

    fireEvent.click(screen.getByTitle('Layout manager'));
    fireEvent.click(screen.getByLabelText('Delete QA Layout'));

    // Confirm deletion
    // The confirm button is the one labeled "Delete" inside the dialog
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = dialog.querySelector('button.confirm-delete')!;
    fireEvent.click(confirmBtn);

    expect(props.onDeleteLayout).toHaveBeenCalledExactlyOnceWith('qa-layout');
  });

  // ── Test 4: Default layout exposes no delete control ────────────────

  it('does not render a delete button for the default layout', () => {
    render(<LayoutEditor {...makeProps()} />);

    fireEvent.click(screen.getByTitle('Layout manager'));

    // No accessible label for deleting the Default layout
    expect(screen.queryByLabelText('Delete Default')).toBeNull();
  });

  // ── Test 5: Store deletion uses an explicit DELETE mock branch ──────
  // This test lives alongside the useLayoutStore tests, but we verify here
  // that the component correctly wires the store's delete through the guard
  // by asserting the id passed matches what the store would send to DELETE.

  it('passes the layout id that the store would use for the DELETE request', () => {
    const props = makeProps();
    render(<LayoutEditor {...props} />);

    fireEvent.click(screen.getByTitle('Layout manager'));
    fireEvent.click(screen.getByLabelText('Delete QA Layout'));

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = dialog.querySelector('button.confirm-delete')!;
    fireEvent.click(confirmBtn);

    // The id passed to onDeleteLayout is the same id the store uses to
    // build the DELETE /api/layouts/:id route — verified by the store's
    // own integration tests with an explicit DELETE mock branch.
    expect(props.onDeleteLayout).toHaveBeenCalledWith('qa-layout');
  });

  // ── Regression: confirmation dialog closes after confirm ───────────

  it('closes the confirmation dialog after confirmation', () => {
    render(<LayoutEditor {...makeProps()} />);

    fireEvent.click(screen.getByTitle('Layout manager'));
    fireEvent.click(screen.getByLabelText('Delete QA Layout'));

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = dialog.querySelector('button.confirm-delete')!;
    fireEvent.click(confirmBtn);

    // Dialog should be gone
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  // ── Regression: confirmation dialog closes after cancel ────────────

  it('closes the confirmation dialog after cancel', () => {
    render(<LayoutEditor {...makeProps()} />);

    fireEvent.click(screen.getByTitle('Layout manager'));
    fireEvent.click(screen.getByLabelText('Delete QA Layout'));

    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
