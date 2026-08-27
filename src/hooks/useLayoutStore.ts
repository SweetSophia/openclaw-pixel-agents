import { useState, useEffect, useCallback, useReducer, useRef } from 'react';
import type { PlacedFurniture } from '../../shared/types';

const API_BASE = '/api';

export interface LayoutDoc {
  id: string;
  name: string;
  width: number;
  height: number;
  furniture: PlacedFurniture[];
  seats: Record<string, { x: number; y: number }>;
  updatedAt: number;
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

type PersistedRevision = { id: string; updatedAt: number };

function isLayoutDoc(value: unknown): value is LayoutDoc {
  if (!value || typeof value !== 'object') return false;
  const layout = value as Record<string, unknown>;
  return typeof layout.id === 'string' && layout.id.length > 0
    && typeof layout.name === 'string' && layout.name.trim().length > 0
    && Number.isSafeInteger(layout.width) && (layout.width as number) > 0
    && Number.isSafeInteger(layout.height) && (layout.height as number) > 0
    && Number.isSafeInteger(layout.updatedAt) && (layout.updatedAt as number) >= 0
    && Array.isArray(layout.furniture)
    && layout.furniture.every(item => {
      if (!item || typeof item !== 'object') return false;
      const furniture = item as Record<string, unknown>;
      return typeof furniture.id === 'string'
        && typeof furniture.type === 'string'
        && Number.isSafeInteger(furniture.x)
        && Number.isSafeInteger(furniture.y)
        && [0, 90, 180, 270].includes(furniture.rotation as number);
    })
    && !!layout.seats
    && typeof layout.seats === 'object'
    && !Array.isArray(layout.seats)
    && Object.values(layout.seats as Record<string, unknown>).every(seat => {
      if (!seat || typeof seat !== 'object') return false;
      const position = seat as Record<string, unknown>;
      return Number.isSafeInteger(position.x) && Number.isSafeInteger(position.y);
    });
}

function pickBaseUpdatedAt(
  currentLayout: LayoutDoc,
  persistedRevision: PersistedRevision | null,
): number {
  return persistedRevision?.id === currentLayout.id
    ? persistedRevision.updatedAt
    : currentLayout.updatedAt;
}

function capacityErrorMessage(error: unknown): string {
  const detail = typeof error === 'string' && error.trim()
    ? error.trim().replace(/[.!?]+$/, '')
    : 'Layout limit reached (100)';
  return `${detail}. Delete unused layouts until the warning clears.`;
}

/**
 * Dispatched action: a new layout value, or a functional updater.
 * Every mutation flows through the reducer, which guarantees the ref
 * stays in sync — there is no separate raw setter that could bypass it.
 */
type LayoutAction = LayoutDoc | null | ((prev: LayoutDoc | null) => LayoutDoc | null);

export function useLayoutStore() {
  const [layouts, setLayouts] = useState<LayoutDoc[]>([]);
  const activeLayoutRef = useRef<LayoutDoc | null>(null);

  // useReducer replaces the dual useState+useRef pattern. The reducer
  // ALWAYS syncs the ref, making desync architecturally impossible —
  // dispatch is the single entry point for all active-layout mutations.
  //
  // Note: the ref-write inside the reducer is technically impure (React
  // invokes reducers twice in Strict Mode), but it is idempotent —
  // writing the same value twice is harmless. This trade-off is preferred
  // over a useEffect sync because the ref is read synchronously inside
  // saveActiveLayout's async callback chain, which would otherwise have a
  // one-render stale window.
  const [activeLayout, setActiveLayout] = useReducer(
    function reducer(state: LayoutDoc | null, action: LayoutAction): LayoutDoc | null {
      const next = typeof action === 'function' ? action(state) : action;
      activeLayoutRef.current = next;
      return next;
    },
    null,
  );

  const [catalog, setCatalog] = useState<string[]>([]);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const savePromiseRef = useRef<Promise<void>>(Promise.resolve());
  // Tracks the last server revision independently from the optimistic local
  // document. A stale response may advance this revision without being
  // allowed to replace newer furniture edits in the UI.
  const persistedRevisionRef = useRef<PersistedRevision | null>(null);
  const furnitureEditVersionRef = useRef(0);

  // --- Auto-save state ---
  // isDirty: true when furniture has been changed but not yet persisted.
  const [isDirty, setIsDirty] = useState(false);
  // saveStatus: user-visible save lifecycle feedback. Purely additive —
  // nothing in the persistence protocol reads it.
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // skipAutoSaveRef: set to true before programmatic layout changes (load,
  // create, save-response) so the auto-save effect doesn't fire on them.
  // The auto-save effect resets it to false after skipping.
  const skipAutoSaveRef = useRef(true); // Start true to skip initial load
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // isDirtyRef: mirror of isDirty for synchronous reads (e.g. beforeunload).
  // React state closures capture stale values; refs read the latest.
  const isDirtyRef = useRef(false);
  // retryAttemptRef: tracks consecutive failed auto-saves for backoff.
  const retryAttemptRef = useRef(0);

  const clearLayoutError = useCallback(() => setLayoutError(null), []);

  const scheduleSaveRetry = useCallback((retry: () => void) => {
    const delay = Math.min(2000 * Math.pow(2, retryAttemptRef.current), 30000);
    retryAttemptRef.current++;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      retry();
    }, delay);
  }, []);

  // 'saved' auto-clears back to 'idle' so the button returns to its neutral
  // state; 'saving' and 'error' persist until the next save attempt resolves.
  const markSaveStatus = useCallback((status: SaveStatus) => {
    if (saveStatusTimerRef.current) {
      clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = null;
    }
    setSaveStatus(status);
    if (status === 'saved') {
      saveStatusTimerRef.current = setTimeout(() => {
        saveStatusTimerRef.current = null;
        setSaveStatus('idle');
      }, 2500);
    }
  }, []);

  const advancePersistedRevision = useCallback((id: string, updatedAt: number) => {
    if (activeLayoutRef.current?.id !== id || !Number.isSafeInteger(updatedAt)) return false;
    const current = persistedRevisionRef.current;
    if (!current || current.id !== id || updatedAt > current.updatedAt) {
      persistedRevisionRef.current = { id, updatedAt };
    }
    return true;
  }, []);

  const refreshPersistedRevision = useCallback(async (id: string) => {
    try {
      const response = await fetch(`${API_BASE}/layouts/${id}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const layout: unknown = await response.json();
      if (!isLayoutDoc(layout) || layout.id !== id) {
        throw new Error('Invalid layout response');
      }
      return advancePersistedRevision(id, layout.updatedAt);
    } catch (err) {
      console.error('Failed to refresh layout revision:', err);
      return false;
    }
  }, [advancePersistedRevision]);

  // Wrapper for programmatic layout changes. Always sets skipAutoSaveRef
  // before setActiveLayout so the auto-save effect skips these changes.
  // Also clears isDirty. This makes the skip-auto-save invariant
  // architecturally enforced — every programmatic set goes through here.
  const setActiveLayoutProgrammatic = useCallback((layout: LayoutDoc | null) => {
    skipAutoSaveRef.current = true;
    setIsDirty(false);
    // Reset the retry counter so the first failure on a freshly-loaded
    // layout starts from the base 2s backoff, not the previous layout's
    // inflated exponent.
    retryAttemptRef.current = 0;
    if (!layout) {
      persistedRevisionRef.current = null;
    } else {
      const current = persistedRevisionRef.current;
      if (!current || current.id !== layout.id || layout.updatedAt >= current.updatedAt) {
        persistedRevisionRef.current = { id: layout.id, updatedAt: layout.updatedAt };
      }
    }
    setActiveLayout(layout);
  }, []);

  const fetchLayouts = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/layouts`);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const message = res.status === 507
          ? capacityErrorMessage(data?.error)
          : data?.error ?? `Failed to fetch layouts (HTTP ${res.status})`;
        setLayoutError(message);
        console.error('Failed to fetch layouts:', message);
        return;
      }
      setLayouts(data?.layouts || []);
      if (data?.overCapacity === true) {
        const limit = Number.isSafeInteger(data.layoutLimit) ? data.layoutLimit : 100;
        setLayoutError(
          `Only ${limit} layouts are shown because the layout limit was exceeded. `
          + 'Delete unused layouts until this warning clears.',
        );
      } else {
        setLayoutError(null);
      }
    } catch (err) {
      console.error('Failed to fetch layouts:', err);
      setLayoutError('Failed to fetch layouts. Try again.');
    }
  }, []);

  const loadLayoutById = useCallback(async (id: string) => {
    // If there are unsaved changes, confirm discard before loading.
    // This prevents silently losing user edits when switching layouts.
    if (isDirtyRef.current) {
      const ok = window.confirm(
        'You have unsaved furniture changes that will be discarded. Continue?',
      );
      if (!ok) return null;
    }
    try {
      const res = await fetch(`${API_BASE}/layouts/${id}`);
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        const message = res.status === 507
          ? capacityErrorMessage(errBody.error)
          : errBody.error ?? `Failed to load layout (HTTP ${res.status})`;
        if (res.status === 507) setLayoutError(message);
        console.error('Failed to load layout:', message);
        return null;
      }
      const data: unknown = await res.json();
      if (!isLayoutDoc(data)) {
        console.error('Failed to load layout: invalid response body');
        return null;
      }
      setActiveLayoutProgrammatic(data);
      return data;
    } catch (err) {
      console.error('Failed to load layout:', err);
      return null;
    }
  }, [setActiveLayoutProgrammatic]);

  const saveActiveLayout = useCallback(async (updates?: Partial<LayoutDoc>) => {
    savePromiseRef.current = savePromiseRef.current.then(async () => {
      // Read from the ref — it's always synced by the reducer, so this
      // always reflects the latest committed state. This replaces the
      // old dual-setter pattern where a raw useState setter could bypass
      // the ref sync.
      const currentLayout = activeLayoutRef.current;
      if (!currentLayout) return;
      markSaveStatus('saving');
      const editVersionAtSaveStart = furnitureEditVersionRef.current;
      const persistedRevision = persistedRevisionRef.current;
      const baseUpdatedAt = pickBaseUpdatedAt(currentLayout, persistedRevision);

      const merged = { ...currentLayout, ...updates, baseUpdatedAt, updatedAt: Date.now() };

      try {
        const response = await fetch(`${API_BASE}/layouts/${merged.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged),
        });
        if (!response.ok) {
          const errorBody = await response.json().catch(() => null);
          console.error('Failed to save layout:', errorBody?.error ?? `HTTP ${response.status}`);
          if (response.status === 507) {
            if (autoSaveTimerRef.current) {
              clearTimeout(autoSaveTimerRef.current);
              autoSaveTimerRef.current = null;
            }
            retryAttemptRef.current = 0;
            setLayoutError(capacityErrorMessage(errorBody?.error));
          } else if (response.status === 409) {
            await refreshPersistedRevision(merged.id);
            if (activeLayoutRef.current?.id === merged.id) {
              scheduleSaveRetry(() => { void saveActiveLayout(); });
            }
          } else if (response.status >= 500) {
            scheduleSaveRetry(() => { void saveActiveLayout(); });
          }
          markSaveStatus('error');
          return;
        }
        const data = await response.json().catch(() => null);
        const savedLayout: unknown = data?.layout;
        if (!isLayoutDoc(savedLayout) || savedLayout.id !== merged.id) {
          const reason = !isLayoutDoc(savedLayout)
            ? 'invalid response body'
            : `response id mismatch (expected '${merged.id}', got '${savedLayout.id}')`;
          console.error(`Failed to save layout: ${reason}`);
          await refreshPersistedRevision(merged.id);
          if (activeLayoutRef.current?.id === merged.id) {
            scheduleSaveRetry(() => { void saveActiveLayout(); });
          }
          markSaveStatus('error');
          return;
        }
        // Success — reset retry counter and advance the revision monotonically.
        retryAttemptRef.current = 0;
        markSaveStatus('saved');
        const currentRevision = persistedRevisionRef.current;
        const responseIsCurrent = currentRevision?.id !== savedLayout.id
          || savedLayout.updatedAt >= currentRevision.updatedAt;
        advancePersistedRevision(savedLayout.id, savedLayout.updatedAt);

        // The response is authoritative only for the snapshot it saved. If
        // the user edited or switched layouts while the PUT was in flight,
        // retain that newer local state and let its queued auto-save proceed.
        if (
          responseIsCurrent
          && furnitureEditVersionRef.current === editVersionAtSaveStart
          && activeLayoutRef.current === currentLayout
        ) {
          setActiveLayoutProgrammatic(savedLayout);
        }
        fetchLayouts();
      } catch (err: any) {
        console.error('Failed to save layout:', err);
        // Network error — retry with backoff
        markSaveStatus('error');
        scheduleSaveRetry(() => { void saveActiveLayout(); });
      }
    });
    return savePromiseRef.current;
  }, [
    advancePersistedRevision,
    fetchLayouts,
    markSaveStatus,
    refreshPersistedRevision,
    scheduleSaveRetry,
    setActiveLayoutProgrammatic,
  ]);

  const createLayout = useCallback(async (name: string): Promise<LayoutDoc | null> => {
    try {
      const res = await fetch(`${API_BASE}/layouts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, width: 24, height: 16 }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const message = res.status === 507
          ? capacityErrorMessage(data?.error)
          : data?.error ?? `Failed to create layout (HTTP ${res.status})`;
        setLayoutError(message);
        console.error('Failed to create layout:', message);
        return null;
      }
      if (!isLayoutDoc(data?.layout)) {
        setLayoutError('Failed to create layout: invalid response body.');
        console.error('Failed to create layout: invalid response body');
        return null;
      }
      setLayoutError(null);
      setActiveLayoutProgrammatic(data.layout);
      fetchLayouts();
      return data.layout;
    } catch (err) {
      console.error('Failed to create layout:', err);
      setLayoutError('Failed to create layout. Try again.');
      return null;
    }
  }, [fetchLayouts, setActiveLayoutProgrammatic]);

  // Returns true on success and false on failure so the confirmation barrier
  // in LayoutEditor can keep the dialog open and surface an error instead of
  // closing optimistically on a silent store failure (PR #122 P3 fix).
  const deleteLayout = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE}/layouts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to delete layout' }));
        console.error('Failed to delete layout:', err.error);
        return false;
      }
      if (activeLayout?.id === id) {
        setActiveLayoutProgrammatic(null);
      }
      fetchLayouts();
      return true;
    } catch (err) {
      console.error('Failed to delete layout:', err);
      return false;
    }
  }, [activeLayout, fetchLayouts, setActiveLayoutProgrammatic]);

  const fetchCatalog = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/furniture-catalog`);
      const data = await res.json();
      setCatalog(data.types || []);
    } catch (err) {
      console.error('Failed to fetch catalog:', err);
    }
  }, []);

  // Update furniture on the active layout (optimistic).
  // Accepts either a new array or a functional updater that receives the
  // current furniture list — use the updater form for actions (like
  // delete-mode rapid clicks) that may fire faster than React batches.
  const updateFurniture = useCallback((
    furnitureOrUpdater: PlacedFurniture[] | ((prev: PlacedFurniture[]) => PlacedFurniture[]),
  ) => {
    if (!activeLayoutRef.current) return;
    furnitureEditVersionRef.current++;
    setActiveLayout(prev => {
      if (!prev) return null;
      const furniture = typeof furnitureOrUpdater === 'function'
        ? furnitureOrUpdater(prev.furniture)
        : furnitureOrUpdater;
      return { ...prev, furniture };
    });
  }, []);

  // --- Debounced auto-save ---
  // Watches furniture changes and saves after 2s of inactivity.
  // Programmatic changes (load, create, save-response, delete) are skipped
  // via skipAutoSaveRef, which is set to true by setActiveLayoutProgrammatic
  // before every programmatic dispatch.
  useEffect(() => {
    if (!activeLayout) return;

    // Skip programmatic changes (initial load, createLayout, save response)
    if (skipAutoSaveRef.current) {
      skipAutoSaveRef.current = false;
      return;
    }

    // Mark as dirty — there are unsaved furniture changes
    setIsDirty(true);

    // Clear any pending auto-save (debounce: rapid changes coalesce)
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    // Schedule debounced auto-save (2 seconds of inactivity)
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      saveActiveLayout();
    }, 2000);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [activeLayout?.furniture, saveActiveLayout]);

  // --- Sync isDirty → isDirtyRef for synchronous reads ---
  // beforeunload handlers and loadLayoutById need to check isDirty
  // synchronously, but React state closures capture stale values.
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  // --- beforeunload: emergency save + browser confirmation ---
  // Reads isDirtyRef/activeLayoutRef for current state; re-registers when
  // the (stable) save/refresh callbacks change identity.
  // If there are unsaved changes, attempt a keepalive PUT and show the
  // browser's "Leave site?" dialog.
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirtyRef.current) return;

      const currentLayout = activeLayoutRef.current;
      if (currentLayout) {
        const persistedRevision = persistedRevisionRef.current;
        const merged = {
          ...currentLayout,
          baseUpdatedAt: pickBaseUpdatedAt(currentLayout, persistedRevision),
          updatedAt: Date.now(),
        };
        void fetch(`${API_BASE}/layouts/${merged.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged),
          keepalive: true,
        }).then(async response => {
          if (response.status === 409) {
            console.warn('Layout changed elsewhere while leaving; retrying if the page remains open.');
            await refreshPersistedRevision(merged.id);
            if (activeLayoutRef.current?.id === merged.id) {
              scheduleSaveRetry(() => { void saveActiveLayout(); });
            }
            return;
          }
          if (!response.ok) {
            console.error(`Failed to save layout before unload: HTTP ${response.status}`);
            return;
          }
          const data = await response.json().catch(() => null);
          const savedLayout: unknown = data?.layout;
          if (!isLayoutDoc(savedLayout) || savedLayout.id !== merged.id) {
            const reason = !isLayoutDoc(savedLayout)
              ? 'invalid response body'
              : `response id mismatch (expected '${merged.id}', got '${savedLayout.id}')`;
            console.error(`Failed to save layout before unload: ${reason}`);
            return;
          }
          // If the unload is cancelled and the page stays open, the next
          // save must chain from the revision this keepalive PUT actually
          // persisted — otherwise it 409s on a stale baseUpdatedAt.
          // isDirty/activeLayout are deliberately untouched: edits landing
          // after beforeunload are not covered by this save.
          retryAttemptRef.current = 0;
          advancePersistedRevision(savedLayout.id, savedLayout.updatedAt);
        }).catch(err => {
          console.error('Failed to save layout before unload:', err);
        });
      }

      e.preventDefault();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [refreshPersistedRevision, saveActiveLayout, scheduleSaveRetry]);

  // Initial load
  useEffect(() => {
    fetchLayouts();
    fetchCatalog();
    loadLayoutById('default');
  }, [fetchLayouts, fetchCatalog, loadLayoutById]);

  return {
    layouts,
    activeLayout,
    isDirty,
    saveStatus,
    layoutError,
    catalog,
    clearLayoutError,
    loadLayoutById,
    saveActiveLayout,
    createLayout,
    deleteLayout,
    updateFurniture,
    fetchLayouts,
  };
}
