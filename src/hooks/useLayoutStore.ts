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
  const savePromiseRef = useRef<Promise<void>>(Promise.resolve());

  // --- Auto-save state ---
  // isDirty: true when furniture has been changed but not yet persisted.
  const [isDirty, setIsDirty] = useState(false);
  // skipAutoSaveRef: set to true before programmatic layout changes (load,
  // create, save-response) so the auto-save effect doesn't fire on them.
  // The auto-save effect resets it to false after skipping.
  const skipAutoSaveRef = useRef(true); // Start true to skip initial load
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchLayouts = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/layouts`);
      const data = await res.json();
      setLayouts(data.layouts || []);
    } catch (err) {
      console.error('Failed to fetch layouts:', err);
    }
  }, []);

  const loadLayoutById = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/layouts/${id}`);
      const data = await res.json();
      skipAutoSaveRef.current = true;
      setIsDirty(false);
      setActiveLayout(data);
      return data;
    } catch (err) {
      console.error('Failed to load layout:', err);
      return null;
    }
  }, [setActiveLayout]);

  const saveActiveLayout = useCallback(async (updates?: Partial<LayoutDoc>) => {
    savePromiseRef.current = savePromiseRef.current.then(async () => {
      // Read from the ref — it's always synced by the reducer, so this
      // always reflects the latest committed state. This replaces the
      // old dual-setter pattern where a raw useState setter could bypass
      // the ref sync.
      const currentLayout = activeLayoutRef.current;
      if (!currentLayout) return;

      const merged = { ...currentLayout, ...updates, baseUpdatedAt: currentLayout.updatedAt, updatedAt: Date.now() };

      try {
        const response = await fetch(`${API_BASE}/layouts/${merged.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged),
        });
        if (!response.ok) {
          const errorBody = await response.json().catch(() => null);
          console.error('Failed to save layout:', errorBody?.error ?? `HTTP ${response.status}`);
          return;
        }
        const data = await response.json().catch(() => null);
        skipAutoSaveRef.current = true;
        setIsDirty(false);
        setActiveLayout(data?.layout ?? merged);
        fetchLayouts();
      } catch (err: any) {
        console.error('Failed to save layout:', err);
      }
    });
    return savePromiseRef.current;
  }, [fetchLayouts, setActiveLayout]);

  const createLayout = useCallback(async (name: string) => {
    try {
      const res = await fetch(`${API_BASE}/layouts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, width: 24, height: 16 }),
      });
      const data = await res.json();
      if (data.layout) {
        skipAutoSaveRef.current = true;
        setIsDirty(false);
        setActiveLayout(data.layout);
        fetchLayouts();
      }
      return data.layout;
    } catch (err) {
      console.error('Failed to create layout:', err);
      return null;
    }
  }, [fetchLayouts]);

  const deleteLayout = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/layouts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to delete layout' }));
        console.error('Failed to delete layout:', err.error);
        return;
      }
      if (activeLayout?.id === id) {
        skipAutoSaveRef.current = true;
        setIsDirty(false);
        setActiveLayout(null);
      }
      fetchLayouts();
    } catch (err) {
      console.error('Failed to delete layout:', err);
    }
  }, [activeLayout, fetchLayouts]);

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
  // Programmatic changes (load, create, save-response) are skipped via
  // skipAutoSaveRef, which is set to true before those operations and
  // reset to false by this effect after skipping.
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
    }

    // Schedule debounced auto-save (2 seconds of inactivity)
    autoSaveTimerRef.current = setTimeout(() => {
      saveActiveLayout();
    }, 2000);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [activeLayout?.furniture, saveActiveLayout]);

  // --- beforeunload: emergency save + browser confirmation ---
  // If there are unsaved changes when the user leaves, attempt a
  // keepalive PUT and trigger the browser's "Leave site?" dialog.
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirty) return;

      const currentLayout = activeLayoutRef.current;
      if (currentLayout) {
        const merged = {
          ...currentLayout,
          baseUpdatedAt: currentLayout.updatedAt,
          updatedAt: Date.now(),
        };
        fetch(`${API_BASE}/layouts/${merged.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged),
          keepalive: true,
        }).catch(() => {});
      }

      e.preventDefault();
      e.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // Cleanup auto-save timer on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, []);

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
    catalog,
    loadLayoutById,
    saveActiveLayout,
    createLayout,
    deleteLayout,
    updateFurniture,
    fetchLayouts,
  };
}
