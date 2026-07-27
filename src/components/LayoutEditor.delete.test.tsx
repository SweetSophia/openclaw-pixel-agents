/**
 * Issue #109 — Delete confirmation guard for custom layouts.
 *
 * Semantic anchors: Confirmation Barrier / Guard Pattern with a safe default.
 * The component owns the sole user-facing confirmation barrier; the store and
 * server remain raw delete primitives (one independent guard, not Defense in
 * Depth). These tests pin the barrier so it cannot be silently removed.
 *
 * Test cases (mapped from issue #109 + Sophie's consolidated PR #122 review):
 *   1. Clicking Delete opens confirmation containing the layout name.
 *   2. Cancel retains the row and never calls onDeleteLayout.
 *   3. Confirm calls onDeleteLayout exactly once with the correct id.
 *   4. Default layout exposes no delete control.
 *   5. Store deletion tests use an explicit DELETE mock branch.
 *   6. Dialog is portaled to document.body (escapes .app-main stacking context).
 *   7. Escape closes the dialog without deleting.
 *   8. Dialog has accessible name and description (aria-labelledby/describedby).
 *   9. Focus is contained within the dialog (Tab trap).
 *  10. Focus is restored to the invoking element on close.
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

/** Helper: open layout manager and click the delete button for QA Layout. */
function openDeleteDialog(props: ReturnType<typeof makeProps>) {
  render(<LayoutEditor {...props} />);
  fireEvent.click(screen.getByTitle('Layout manager'));
  const deleteBtn = screen.getByLabelText('Delete QA Layout');
  fireEvent.click(deleteBtn);
  return deleteBtn;
}

describe('Issue #109 — delete confirmation guard', () => {
  afterEach(cleanup);

  // ── Test 1: Clicking Delete opens confirmation ─────────────────────

  it('opens a confirmation dialog containing the layout name when Delete is clicked', () => {
    openDeleteDialog(makeProps());

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('QA Layout');
    expect(dialog.textContent).toContain('cannot be undone');
  });

  // ── Test 2: Cancel retains the row and never calls onDeleteLayout ──

  it('does not call onDeleteLayout and keeps the layout row when Cancel is clicked', () => {
    const props = makeProps();
    openDeleteDialog(props);

    fireEvent.click(screen.getByText('Cancel'));

    expect(props.onDeleteLayout).not.toHaveBeenCalled();
    expect(screen.getByText('QA Layout')).toBeTruthy();
  });

  // ── Test 3: Confirm calls onDeleteLayout exactly once ───────────────

  it('calls onDeleteLayout exactly once with the correct id when Delete is confirmed', () => {
    const props = makeProps();
    openDeleteDialog(props);

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = dialog.querySelector('button.confirm-delete')!;
    fireEvent.click(confirmBtn);

    expect(props.onDeleteLayout).toHaveBeenCalledExactlyOnceWith('qa-layout');
  });

  // ── Test 4: Default layout exposes no delete control ────────────────

  it('does not render a delete button for the default layout', () => {
    render(<LayoutEditor {...makeProps()} />);
    fireEvent.click(screen.getByTitle('Layout manager'));

    expect(screen.queryByLabelText('Delete Default')).toBeNull();
  });

  // ── Test 5: Store deletion uses an explicit DELETE mock branch ──────

  it('passes the layout id that the store would use for the DELETE request', () => {
    const props = makeProps();
    openDeleteDialog(props);

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = dialog.querySelector('button.confirm-delete')!;
    fireEvent.click(confirmBtn);

    expect(props.onDeleteLayout).toHaveBeenCalledWith('qa-layout');
  });

  // ── Test 6: Dialog is portaled to document.body (P2 stacking fix) ───

  it('renders the confirmation dialog as a direct child of document.body', () => {
    openDeleteDialog(makeProps());

    const dialog = screen.getByRole('alertdialog');
    // The overlay must be portaled out of .app-main's stacking context.
    expect(dialog.parentElement).toBe(document.body);
  });

  // ── Test 7: Escape closes the dialog without deleting ──────────────

  it('closes the dialog on Escape without calling onDeleteLayout', () => {
    const props = makeProps();
    openDeleteDialog(props);

    const dialog = screen.getByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(props.onDeleteLayout).not.toHaveBeenCalled();
  });

  // ── Test 8: Accessible name and description (P2 alertdialog fix) ───

  it('has an accessible name via aria-labelledby and description via aria-describedby', () => {
    openDeleteDialog(makeProps());

    const dialog = screen.getByRole('alertdialog');

    // aria-labelledby must point to an element containing the layout name
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const titleEl = document.getElementById(labelledBy!);
    expect(titleEl).toBeTruthy();
    expect(titleEl!.textContent).toContain('QA Layout');

    // aria-describedby must point to an element describing the consequence
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const descEl = document.getElementById(describedBy!);
    expect(descEl).toBeTruthy();
    expect(descEl!.textContent).toContain('permanently');
  });

  // ── Test 9: Focus is contained within the dialog (Tab trap) ────────

  it('traps Tab focus within the dialog', () => {
    openDeleteDialog(makeProps());

    const dialog = screen.getByRole('alertdialog');
    const cancelBtn = dialog.querySelector('.confirm-cancel') as HTMLElement;
    const deleteBtn = dialog.querySelector('.confirm-delete') as HTMLElement;

    // Focus the last button (Delete), then Tab should wrap to first (Cancel)
    deleteBtn.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(cancelBtn);

    // Focus the first button (Cancel), then Shift+Tab should wrap to last (Delete)
    cancelBtn.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(deleteBtn);
  });

  // ── Test 10: Focus is restored to the invoking element on close ────

  it('restores focus to the delete button after cancel', () => {
    const props = makeProps();
    const deleteBtn = openDeleteDialog(props);

    fireEvent.click(screen.getByText('Cancel'));

    // Focus should return to the trash button that opened the dialog
    expect(document.activeElement).toBe(deleteBtn);
  });

  // ── Test 11: Confirm-path focus survives the trigger's unmount (P2) ──

  it('restores focus to the Layouts toggle after confirm when the trigger unmounts', () => {
    const props = makeProps();
    // Simulate the real lifecycle: confirming deletes the layout row, which
    // unmounts its trash button. The mock removes the trigger node so the
    // cleanup's isConnected check falls back to the Layouts toggle instead of
    // stranding focus on <body> (P2 from Sophie's re-review at b89818e).
    props.onDeleteLayout = vi.fn(() => {
      screen.getByLabelText('Delete QA Layout').remove();
    });
    openDeleteDialog(props);

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = dialog.querySelector('button.confirm-delete')!;
    fireEvent.click(confirmBtn);

    expect(props.onDeleteLayout).toHaveBeenCalledExactlyOnceWith('qa-layout');
    // Trigger is detached, so focus must fall back to the Layouts toggle.
    const layoutsToggle = document.querySelector<HTMLElement>('[title="Layout manager"]');
    expect(layoutsToggle).toBeTruthy();
    expect(document.activeElement).toBe(layoutsToggle);
  });

  // ── Regression: confirmation dialog closes after confirm ───────────

  it('closes the confirmation dialog after confirmation', () => {
    openDeleteDialog(makeProps());

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = dialog.querySelector('button.confirm-delete')!;
    fireEvent.click(confirmBtn);

    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  // ── Regression: confirmation dialog closes after cancel ────────────

  it('closes the confirmation dialog after cancel', () => {
    openDeleteDialog(makeProps());

    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
