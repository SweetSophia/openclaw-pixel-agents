import { useState, useEffect, useCallback, useRef } from 'react';
import type { PlacedFurniture, OfficeLayout } from '../../shared/types';

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

export function useLayoutStore() {
  const [layouts, setLayouts] = useState<LayoutDoc[]>([]);
  const [activeLayout, setActiveLayout] = useState<LayoutDoc | null>(null);
  const [catalog, setCatalog] = useState<string[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

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
      setActiveLayout(data);
      return data;
    } catch (err) {
      console.error('Failed to load layout:', err);
      return null;
    }
  }, []);

  const saveActiveLayout = useCallback(async (updates?: Partial<LayoutDoc>) => {
    if (!activeLayout) return;
    const merged = { ...activeLayout, ...updates, updatedAt: Date.now() };

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const ac = new AbortController();
    abortControllerRef.current = ac;

    try {
      const response = await fetch(`${API_BASE}/layouts/${merged.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
        signal: ac.signal,
      });
      if (!ac.signal.aborted) {
        if (!response.ok) {
          const errorBody = await response.json().catch(() => null);
          console.error('Failed to save layout:', errorBody?.error ?? `HTTP ${response.status}`);
          return;
        }
        setActiveLayout(merged);
        fetchLayouts();
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('Failed to save layout:', err);
      }
    }
  }, [activeLayout, fetchLayouts]);

  const createLayout = useCallback(async (name: string) => {
    try {
      const res = await fetch(`${API_BASE}/layouts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, width: 24, height: 16 }),
      });
      const data = await res.json();
      if (data.layout) {
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
      if (activeLayout?.id === id) setActiveLayout(null);
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

  // Auto-save removed — furniture is persisted only via the explicit
  // Save button (saveActiveLayout) to avoid race conditions on initial
  // load and StrictMode double-mounts that caused furniture to reset.

  // Initial load
  useEffect(() => {
    fetchLayouts();
    fetchCatalog();
    loadLayoutById('default');
  }, [fetchLayouts, fetchCatalog, loadLayoutById]);

  return {
    layouts,
    activeLayout,
    catalog,
    loadLayoutById,
    saveActiveLayout,
    createLayout,
    deleteLayout,
    updateFurniture,
    fetchLayouts,
  };
}
