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
 *  10. Focus is restored to the invoking element on cancel.
 *  11. Confirm-path focus survives async row removal via a real parent
 *      re-render (stateful harness — no imperative .remove()).
 *  12. Focus escapes are recovered by the document focusin guard (P2).
 *  13. Escape does not propagate to the App window listener (P3).
 *  14. A failed delete keeps the barrier open and surfaces an inline error (P3).
 *  15. Double submission is prevented while a delete is in flight.
 *  16. Load controls expose an accessible name, not just an emoji (P3).
 */

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
    layoutError: null,
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
    onCreate: vi.fn().mockResolvedValue(defaultLayout),
    onClearLayoutError: vi.fn(),
    // Strict-boolean result contract (Sophie review @78f2bc3): the barrier
    // closes only on a literal `true`, so the default mock must resolve true.
    onDeleteLayout: vi.fn().mockResolvedValue(true),
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

  it('calls onDeleteLayout exactly once with the correct id when Delete is confirmed', async () => {
    const props = makeProps();
    openDeleteDialog(props);

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = dialog.querySelector('button.confirm-delete')!;
    fireEvent.click(confirmBtn);

    expect(props.onDeleteLayout).toHaveBeenCalledExactlyOnceWith('qa-layout');
    // Flush the async confirm so no state update lingers past cleanup.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  // ── Test 4: Default layout exposes no delete control ────────────────

  it('does not render a delete button for the default layout', () => {
    render(<LayoutEditor {...makeProps()} />);
    fireEvent.click(screen.getByTitle('Layout manager'));

    expect(screen.queryByLabelText('Delete Default')).toBeNull();
  });

  // ── Test 5: Store deletion uses an explicit DELETE mock branch ──────

  it('passes the layout id that the store would use for the DELETE request', async () => {
    const props = makeProps();
    openDeleteDialog(props);

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = dialog.querySelector('button.confirm-delete')!;
    fireEvent.click(confirmBtn);

    expect(props.onDeleteLayout).toHaveBeenCalledWith('qa-layout');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
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

  // ── Test 11: Confirm-path focus survives async row removal (P2) ─────
  //
  // Sophie's re-review at d65fca7 showed the previous version was a false
  // positive: it imperatively `.remove()`d the trash button to manufacture
  // `isConnected === false`, an ordering production never produces. In the
  // real lifecycle the DELETE resolves and `fetchLayouts()` re-renders the
  // parent WITHOUT the deleted row, unmounting the trash button later. This
  // harness reproduces that with a stateful parent re-render — React owns
  // the row removal, never an imperative DOM mutation.

  it('restores focus to a surviving control after the parent re-renders without the deleted row', async () => {
    function Harness() {
      const [layouts, setLayouts] = useState([defaultLayout, customLayout]);
      const [active, setActive] = useState<LayoutDoc | null>(defaultLayout);
      const handleDelete = (id: string): boolean => {
        // Mirrors fetchLayouts() dropping the deleted layout from state.
        setLayouts(prev => prev.filter(l => l.id !== id));
        setActive(prev => (prev?.id === id ? null : prev));
        // Strict-boolean contract: report success so the barrier closes.
        return true;
      };
      return (
        <LayoutEditor
          {...makeProps({ layouts, activeLayout: active, onDeleteLayout: handleDelete })}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByTitle('Layout manager'));
    fireEvent.click(screen.getByLabelText('Delete QA Layout'));

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(dialog.querySelector('button.confirm-delete')!);

    // The async confirm closes the dialog and the parent drops the row.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(screen.queryByText('QA Layout')).toBeNull());

    // Focus must land on a surviving control (the Layouts toggle), never on
    // <body> or the now-unmounted trash button.
    const layoutsToggle = screen.getByTitle('Layout manager');
    expect(document.activeElement).toBe(layoutsToggle);
  });

  // ── Test 12: Focus escapes are recovered (P2 containment guard) ─────

  it('returns focus inside the dialog when an outside control gains focus', () => {
    openDeleteDialog(makeProps());
    const dialog = screen.getByRole('alertdialog');
    const cancelBtn = dialog.querySelector('.confirm-cancel') as HTMLElement;

    // Focus escapes to a toolbar control outside the portaled overlay.
    const outside = screen.getByTitle('Furniture palette');
    fireEvent.focusIn(outside);

    // The document focusin guard must immediately pull focus back inside.
    expect(document.activeElement).toBe(cancelBtn);
  });

  // ── Test 12b: Containment holds while a delete is in flight (Kody) ───
  //
  // Kody review @09653e5: both dialog buttons carry disabled={deleting}, so
  // during the async delete the guard's .confirm-cancel.focus() is a silent
  // no-op (disabled buttons can't take focus) and focus strands on <body> —
  // the exact regression the guard exists to prevent. The fix focuses the
  // tabIndex={-1} overlay itself as the fallback target.

  it('keeps focus contained (on the overlay) when it escapes during an in-flight delete', async () => {
    let resolveDelete: (v: boolean) => void = () => {};
    const pending = new Promise<boolean>(resolve => { resolveDelete = resolve; });
    const onDeleteLayout = vi.fn().mockReturnValue(pending);
    const props = makeProps({ onDeleteLayout });
    openDeleteDialog(props);

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(dialog.querySelector('button.confirm-delete')!);

    // deleting === true now, so both buttons are disabled.
    const cancel = dialog.querySelector('.confirm-cancel') as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);

    // Focus escapes outside the overlay while the delete is in flight.
    fireEvent.focusIn(screen.getByTitle('Furniture palette'));

    // Cancel can't take focus, so the guard must fall back to the focusable
    // overlay itself. Focus stays contained — never on <body>.
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(document.body);

    resolveDelete(true);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  // ── Test 12c: Escape is ignored while a delete is in flight (P2) ─────
  //
  // Sophie's final review: onDocKeyDown dismissed the barrier on Escape even
  // while deletingRef was true. The DELETE is irreversible and uncancellable,
  // so Escape posing as a cancellation hid the pending result, stranded focus
  // when the row later unmounted, and could let a stale handler close a newer
  // dialog. The fix mirrors the disabled Cancel button: ignore Escape in flight.

  it('ignores Escape during an in-flight delete, then lands focus stably on success', async () => {
    let resolveDelete: (v: boolean) => void = () => {};
    const pending = new Promise<boolean>(resolve => { resolveDelete = resolve; });
    const onDeleteLayout = vi.fn().mockReturnValue(pending);
    const props = makeProps({ onDeleteLayout });
    openDeleteDialog(props);

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(dialog.querySelector('button.confirm-delete')!);

    // deleting === true: Escape is swallowed, the barrier stays up, and the
    // request is NOT re-fired.
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(onDeleteLayout).toHaveBeenCalledTimes(1);

    // On success the dialog closes and focus lands on the stable Layouts
    // toggle — never on <body>, even though Escape was pressed mid-flight.
    resolveDelete(true);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTitle('Layout manager'));
    expect(document.activeElement).not.toBe(document.body);
  });

  // ── Test 12d: Focus is anchored inside the dialog the instant a delete
  //    goes in flight — before any Tab key (P2, Sophie review @78f2bc3) ──
  //
  // Real Chromium moves focus to <body> when the focused Delete button is
  // disabled, with no focusin for the guard to catch; jsdom does not reproduce
  // that blur, which is how the defect hid behind a green suite. This pins the
  // POSITIVE invariant the useLayoutEffect fix guarantees: the moment
  // `deleting` commits, focus lands on the always-focusable overlay inside the
  // alertdialog — no Tab press required.

  it('anchors focus to the overlay immediately after an in-flight delete begins (no Tab)', () => {
    const onDeleteLayout = vi.fn().mockReturnValue(new Promise<boolean>(() => {}));
    const props = makeProps({ onDeleteLayout });
    openDeleteDialog(props);

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(dialog.querySelector('button.confirm-delete')!);

    // In flight: the Delete control is disabled, yet focus is already inside
    // the alertdialog (on the focusable overlay) — never on <body>, and no Tab
    // key was pressed to get it there.
    expect((dialog.querySelector('.confirm-delete') as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(dialog);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  // ── Test 13: Escape does not propagate to the App drawer (P3) ───────

  it('stops Escape propagation so a window-level listener is not also invoked', () => {
    openDeleteDialog(makeProps());

    const windowSpy = vi.fn();
    window.addEventListener('keydown', windowSpy);
    try {
      fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    } finally {
      window.removeEventListener('keydown', windowSpy);
    }

    // The document handler closed the dialog…
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // …and the same event never reached the window listener (App drawer).
    expect(windowSpy).not.toHaveBeenCalled();
  });

  // ── Test 14: Failed delete keeps the barrier open + inline error (P3) ──

  it('keeps the dialog open and surfaces an error when deletion fails', async () => {
    const onDeleteLayout = vi.fn().mockResolvedValue(false);
    const props = makeProps({ onDeleteLayout });
    openDeleteDialog(props);

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(dialog.querySelector('button.confirm-delete')!);

    // The failure is announced inline and the barrier stays up.
    await screen.findByRole('alert');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(onDeleteLayout).toHaveBeenCalledExactlyOnceWith('qa-layout');
  });

  // ── Test 15: Double submission prevented while in flight ────────────

  it('calls onDeleteLayout only once for repeated clicks during an in-flight delete', async () => {
    let resolveDelete: (v: boolean) => void = () => {};
    const pending = new Promise<boolean>(resolve => { resolveDelete = resolve; });
    const onDeleteLayout = vi.fn().mockReturnValue(pending);
    const props = makeProps({ onDeleteLayout });
    openDeleteDialog(props);

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = dialog.querySelector('button.confirm-delete') as HTMLElement;
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn); // second click while the first is in flight

    expect(onDeleteLayout).toHaveBeenCalledTimes(1);

    resolveDelete(true);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  // ── Test 16: Load controls expose an accessible name (P3) ───────────

  it('gives the Load button an accessible name beyond the folder emoji', () => {
    render(<LayoutEditor {...makeProps()} />);
    fireEvent.click(screen.getByTitle('Layout manager'));

    // The emoji-only content must be backed by an aria-label.
    const loadBtn = screen.getByRole('button', { name: 'Load QA Layout' });
    expect(loadBtn).toBeTruthy();
  });

  // ── Regression: confirmation dialog closes after confirm ───────────

  it('closes the confirmation dialog after confirmation', async () => {
    openDeleteDialog(makeProps());

    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = dialog.querySelector('button.confirm-delete')!;
    fireEvent.click(confirmBtn);

    // Confirm is async (awaits the delete); the dialog closes on success.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  // ── Regression: confirmation dialog closes after cancel ────────────

  it('closes the confirmation dialog after cancel', () => {
    openDeleteDialog(makeProps());

    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
