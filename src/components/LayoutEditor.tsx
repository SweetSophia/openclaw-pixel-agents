import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { PlacedFurniture } from '../../shared/types';
import type { LayoutDoc, SaveStatus } from '../hooks/useLayoutStore';
import './LayoutEditor.css';

interface Props {
  catalog: string[];
  activeLayout: LayoutDoc | null;
  isDirty: boolean;
  /** Save lifecycle feedback from useLayoutStore (optional for tests). */
  saveStatus?: SaveStatus;
  layouts: LayoutDoc[];
  editorMode: boolean;
  selectedFurnitureType: string | null;
  selectedFurnitureId: string | null;
  deleteMode: boolean;
  onSelectFurnitureType: (type: string | null) => void;
  onSelectFurnitureId: (id: string | null) => void;
  onPlaceFurniture: (type: string, x: number, y: number) => void;
  onMoveFurniture: (id: string, x: number, y: number) => void;
  onRotateFurniture: (id: string) => void;
  onDeleteFurniture: (id: string) => void;
  onToggleDeleteMode: () => void;
  onSave: () => void;
  onLoad: (id: string) => void;
  onCreate: (name: string) => void;
  onDeleteLayout: (id: string) => void | Promise<unknown>;
  onToggleEditor: () => void;
}

const FURNITURE_ICONS: Record<string, string> = {
  DESK: '🪑',
  PC: '🖥️',
  CHAIR: '💺',
  CUSHIONED_CHAIR: '💺',
  WOODEN_CHAIR: '💺',
  SOFA: '🛋️',
  CUSHIONED_BENCH: '🛋️',
  WOODEN_BENCH: '🪵',
  LARGE_PLANT: '🌿',
  PLANT: '🌱',
  PLANT_2: '🌵',
  CACTUS: '🌵',
  HANGING_PLANT: '🌸',
  POT: '🪴',
  COFFEE: '☕',
  COFFEE_TABLE: '☕',
  SMALL_TABLE: '🪧',
  TABLE_FRONT: '📋',
  BOOKSHELF: '📚',
  DOUBLE_BOOKSHELF: '📚',
  WHITEBOARD: '📋',
  CLOCK: '🕐',
  LARGE_PAINTING: '🖼️',
  SMALL_PAINTING: '🖼️',
  SMALL_PAINTING_2: '🎨',
  BIN: '🗑️',
};

const FURNITURE_LABELS: Record<string, string> = {
  DESK: 'Desk',
  PC: 'PC',
  CUSHIONED_CHAIR: 'Cushion Chair',
  WOODEN_CHAIR: 'Wood Chair',
  SOFA: 'Sofa',
  CUSHIONED_BENCH: 'Cushion Bench',
  WOODEN_BENCH: 'Wood Bench',
  LARGE_PLANT: 'Large Plant',
  PLANT: 'Plant',
  PLANT_2: 'Plant 2',
  CACTUS: 'Cactus',
  HANGING_PLANT: 'Hanging Plant',
  POT: 'Pot',
  COFFEE: 'Coffee',
  COFFEE_TABLE: 'Coffee Table',
  SMALL_TABLE: 'Small Table',
  TABLE_FRONT: 'Table',
  BOOKSHELF: 'Bookshelf',
  DOUBLE_BOOKSHELF: 'Dbl Bookshelf',
  WHITEBOARD: 'Whiteboard',
  CLOCK: 'Clock',
  LARGE_PAINTING: 'Lg Painting',
  SMALL_PAINTING: 'Sm Painting',
  SMALL_PAINTING_2: 'Sm Painting 2',
  BIN: 'Bin',
};

// Group furniture into categories for the palette
const CATEGORIES = [
  {
    name: 'Desks & Seating',
    types: ['DESK', 'CUSHIONED_CHAIR', 'WOODEN_CHAIR', 'SOFA', 'CUSHIONED_BENCH', 'WOODEN_BENCH'],
  },
  {
    name: 'Plants',
    types: ['LARGE_PLANT', 'PLANT', 'PLANT_2', 'CACTUS', 'HANGING_PLANT', 'POT'],
  },
  {
    name: 'Electronics',
    types: ['PC', 'WHITEBOARD', 'CLOCK'],
  },
  {
    name: 'Tables & Decor',
    types: ['COFFEE', 'COFFEE_TABLE', 'SMALL_TABLE', 'TABLE_FRONT', 'BOOKSHELF', 'DOUBLE_BOOKSHELF', 'LARGE_PAINTING', 'SMALL_PAINTING', 'SMALL_PAINTING_2', 'BIN'],
  },
];

export const LayoutEditor: React.FC<Props> = ({
  catalog,
  activeLayout,
  isDirty,
  saveStatus = 'idle',
  layouts,
  editorMode,
  selectedFurnitureType,
  selectedFurnitureId,
  deleteMode,
  onSelectFurnitureType,
  onSelectFurnitureId,
  onRotateFurniture,
  onDeleteFurniture,
  onToggleDeleteMode,
  onSave,
  onLoad,
  onCreate,
  onDeleteLayout,
  onToggleEditor,
}) => {
  const [showPalette, setShowPalette] = useState(false);
  const [showLayouts, setShowLayouts] = useState(false);
  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<LayoutDoc | null>(null);
  // Confirm lifecycle: disables the buttons while the async delete is in
  // flight (double-submit guard) and surfaces a failure without closing.
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const deletingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // Stable toolbar toggle used as the focus-restore target after a confirmed
  // delete, when the trash button unmounts with its layout row (P2).
  const layoutsToggleRef = useRef<HTMLButtonElement>(null);
  // The control to refocus on close, chosen by CLOSE REASON rather than by
  // probing DOM connectedness at cleanup time (P2 close-reason fix):
  //   cancel / escape → the invoking trash button (still mounted)
  //   confirm         → the stable Layouts toggle (survives the row removal)
  const restoreTargetRef = useRef<HTMLElement | null>(null);

  // Focus trap for the confirmation dialog (WAI-ARIA APG). Escape is handled
  // separately via a document-level listener in the effect below so it fires
  // reliably regardless of which descendant currently holds focus.
  const handleDialogKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  useEffect(() => {
    if (!pendingDelete) return;

    // Reset transient confirm state for each fresh dialog open.
    deletingRef.current = false;
    setDeleting(false);
    setDeleteError(false);
    // Default restore target is the invoking control; the confirm path
    // overrides it to a stable surviving control before closing.
    restoreTargetRef.current = triggerRef.current;

    // Document-level Escape: closes the dialog no matter where focus is. A
    // listener on the overlay alone misses Escape when focus sits on a button
    // inside the portaled dialog (P2 fix from Sophie's re-review).
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // Stop the same Escape from also closing the App agents drawer, whose
        // window-level listener sits above document in the bubble path (P3).
        e.stopPropagation();
        setPendingDelete(null);
      }
    };
    document.addEventListener('keydown', onDocKeyDown);

    // Focus-containment guard (P2): the Tab trap on the overlay only wraps
    // while focus is already on the first/last dialog control. If focus
    // escapes the portaled overlay entirely (programmatic focus, a stray
    // Tab, or a browser quirk), pull it straight back inside so the
    // aria-modal dialog never strands focus on <body> or an outside control.
    const onFocusIn = (e: FocusEvent) => {
      const overlay = overlayRef.current;
      if (overlay && e.target instanceof Node && !overlay.contains(e.target)) {
        overlay.querySelector<HTMLElement>('.confirm-cancel')?.focus();
      }
    };
    document.addEventListener('focusin', onFocusIn);

    // Move focus into the dialog (autoFocus handles the initial focus,
    // but this ensures it even if autoFocus is suppressed by the browser).
    const timer = setTimeout(() => {
      const cancel = dialogRef.current?.querySelector<HTMLElement>('.confirm-cancel');
      cancel?.focus();
    }, 0);

    return () => {
      clearTimeout(timer);
      // Remove the containment guard BEFORE moving focus so the restore
      // target (which lives outside the overlay) is not intercepted.
      document.removeEventListener('keydown', onDocKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      // Restore focus to the control chosen at close time. After a confirmed
      // delete the trash button unmounts with its layout row, so the confirm
      // path points restoreTargetRef at the stable Layouts toggle; cancel and
      // Escape keep the original trigger. The isConnected probe is now only a
      // defensive fallback, not the selection mechanism (P2 close-reason fix).
      const target = restoreTargetRef.current;
      if (target && target.isConnected) {
        target.focus();
      } else {
        layoutsToggleRef.current?.focus();
      }
    };
  }, [pendingDelete]);

  if (!editorMode) return null;

  const selectedFurniture = activeLayout?.furniture.find(f => f.id === selectedFurnitureId);

  // Save button doubles as the save-status indicator (aria-live region).
  const saveLabel =
    saveStatus === 'saving' ? '💾 Saving…'
    : saveStatus === 'saved' ? '✓ Saved'
    : saveStatus === 'error' ? '⚠ Retry save'
    : isDirty ? '💾 Save ●'
    : '💾 Save';
  const saveTitle =
    saveStatus === 'saving' ? 'Saving layout…'
    : saveStatus === 'saved' ? 'Layout saved'
    : saveStatus === 'error' ? 'Couldn\'t save — the app retries automatically; click to retry now'
    : isDirty ? 'Save layout (unsaved changes)'
    : 'Save layout (no unsaved changes)';
  const saveDisabled = saveStatus === 'saving' || (!isDirty && saveStatus !== 'error');
  const saveClass =
    saveStatus === 'saved' ? 'saved'
    : saveStatus === 'error' ? 'error'
    : isDirty ? 'dirty'
    : '';

  return (
    <div className="layout-editor">
      {/* Toolbar */}
      <div className="editor-toolbar">
        <button
          className={`toolbar-btn ${showPalette ? 'active' : ''}`}
          onClick={() => { setShowPalette(!showPalette); setShowLayouts(false); }}
          title="Furniture palette"
        >
          📦 Furniture
        </button>
        <button
          className={`toolbar-btn ${deleteMode ? 'active danger' : ''}`}
          onClick={onToggleDeleteMode}
          aria-pressed={deleteMode}
          title="Delete mode — click placed items to remove them"
        >
          🗑️ Delete
        </button>
        <button
          ref={layoutsToggleRef}
          className={`toolbar-btn ${showLayouts ? 'active' : ''}`}
          onClick={() => { setShowLayouts(!showLayouts); setShowPalette(false); }}
          title="Layout manager"
        >
          📐 Layouts
        </button>
        <div className="toolbar-separator" />
        <span role="status" aria-live="polite" className="save-status-region">
          <button
            className={`toolbar-btn save-btn ${saveClass}`}
            onClick={onSave}
            disabled={saveDisabled}
            title={saveTitle}
          >
            {saveLabel}
          </button>
        </span>
        <button className="toolbar-btn" onClick={onToggleEditor} title="Exit editor">
          ✖ Close
        </button>
      </div>

      {/* Selected furniture info */}
      {selectedFurniture && (
        <div className="selected-info">
          <span className="selected-name">
            {FURNITURE_LABELS[selectedFurniture.type] || selectedFurniture.type}
          </span>
          <span className="selected-pos">
            ({selectedFurniture.x}, {selectedFurniture.y}) r{selectedFurniture.rotation}°
          </span>
          <button className="action-btn" onClick={() => onRotateFurniture(selectedFurniture.id)} title="Rotate (R)">🔄</button>
          <button className="action-btn danger" onClick={() => onDeleteFurniture(selectedFurniture.id)} title="Delete (Del)">🗑️</button>
          <button className="action-btn" onClick={() => onSelectFurnitureId(null)} title="Deselect">✖</button>
        </div>
      )}

      {/* Placement hint when type selected but nothing placed */}
      {selectedFurnitureType && !selectedFurnitureId && (
        <div className="placement-hint">
          Click on the office to place {FURNITURE_LABELS[selectedFurnitureType] || selectedFurnitureType}
          <button className="action-btn" onClick={() => onSelectFurnitureType(null)}>✖ Cancel</button>
        </div>
      )}

      {/* Delete mode hint */}
      {deleteMode && !selectedFurnitureType && (
        <div className="placement-hint danger">
          🗑️ Click on placed furniture to delete it
          <button className="action-btn" onClick={onToggleDeleteMode}>✖ Cancel</button>
        </div>
      )}

      {/* Furniture palette */}
      {showPalette && (
        <div className="furniture-palette">
          <h3>📦 Furniture</h3>
          {CATEGORIES.map(cat => (
            <div key={cat.name} className="palette-category">
              <h4>{cat.name}</h4>
              <div className="palette-items">
                {cat.types.filter(t => catalog.includes(t)).map(type => (
                  <button
                    key={type}
                    className={`palette-item ${selectedFurnitureType === type ? 'selected' : ''}`}
                    onClick={() => onSelectFurnitureType(selectedFurnitureType === type ? null : type)}
                    title={FURNITURE_LABELS[type] || type}
                  >
                    <span className="palette-icon">{FURNITURE_ICONS[type] || '📦'}</span>
                    <span className="palette-label">{FURNITURE_LABELS[type] || type}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Layout manager */}
      {showLayouts && (
        <div className="layout-manager">
          <h3>📐 Layouts</h3>
          <div className="layout-list">
            {layouts.map(layout => (
              <div
                key={layout.id}
                className={`layout-item ${activeLayout?.id === layout.id ? 'active' : ''}`}
              >
                <span className="layout-name">{layout.name}</span>
                <span className="layout-meta">
                  {layout.furniture.length} items · {new Date(layout.updatedAt).toLocaleDateString()}
                </span>
                <div className="layout-actions">
                  <button onClick={() => onLoad(layout.id)} title={`Load ${layout.name}`} aria-label={`Load ${layout.name}`}>📂</button>
                  {layout.id !== 'default' && (
                    <button
                      className="danger"
                      onClick={(e) => {
                        triggerRef.current = e.currentTarget;
                        setPendingDelete(layout);
                      }}
                      aria-label={`Delete ${layout.name}`}
                      title={`Delete ${layout.name}`}
                    >🗑️</button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="layout-create">
            <input
              type="text"
              placeholder="New layout name..."
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newName.trim()) {
                  onCreate(newName.trim());
                  setNewName('');
                }
              }}
            />
            <button onClick={() => { if (newName.trim()) { onCreate(newName.trim()); setNewName(''); } }}>
              ➕ Create
            </button>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog — Confirmation Barrier / Guard Pattern
          (issue #109): irreversible server-side unlinkSync must clear a
          confirmation barrier before the raw store delete is invoked. The
          store/server remain unguarded primitives; the component owns the
          sole user-facing gate (not Defense in Depth — one independent guard).
          Portaled to document.body to escape the .app-main stacking context
          and use the --z-modal token (P2 fix, Codex + Sophie review). */}
      {pendingDelete && createPortal(
        <div
          className="confirm-overlay"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-delete-title"
          aria-describedby="confirm-delete-desc"
          onKeyDown={handleDialogKeyDown}
          ref={overlayRef}
        >
          <div className="confirm-dialog" ref={dialogRef}>
            <p className="confirm-message" id="confirm-delete-title">
              Delete <strong>{pendingDelete.name}</strong>?
            </p>
            <p className="confirm-description" id="confirm-delete-desc">
              This will permanently remove the layout and all its furniture
              placements. This cannot be undone.
            </p>
            {deleteError && (
              <p className="confirm-error" role="alert">
                Couldn't delete the layout. Please try again.
              </p>
            )}
            <div className="confirm-actions">
              <button
                className="confirm-cancel"
                onClick={() => {
                  // Cancel/Escape keep the original trigger as the restore
                  // target — it stays mounted because nothing is deleted.
                  restoreTargetRef.current = triggerRef.current;
                  setPendingDelete(null);
                }}
                disabled={deleting}
                autoFocus
              >
                Cancel
              </button>
              <button
                className="confirm-delete danger"
                disabled={deleting}
                onClick={async () => {
                  if (deletingRef.current) return; // double-submit guard
                  deletingRef.current = true;
                  setDeleting(true);
                  setDeleteError(false);
                  let ok: unknown = true;
                  try {
                    ok = await Promise.resolve(onDeleteLayout(pendingDelete.id));
                  } catch {
                    ok = false;
                  }
                  deletingRef.current = false;
                  setDeleting(false);
                  if (ok === false) {
                    // Keep the barrier open and surface the failure instead of
                    // closing optimistically on a silent store error (P3).
                    setDeleteError(true);
                    return;
                  }
                  // Success: the layout row will unmount, taking its trash
                  // button with it. Restore focus to the stable Layouts toggle
                  // so focus never lands on <body> (P2 close-reason fix).
                  restoreTargetRef.current = layoutsToggleRef.current;
                  setPendingDelete(null);
                }}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};
