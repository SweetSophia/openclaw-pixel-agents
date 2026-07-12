import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLayoutStore } from './useLayoutStore';
import type { LayoutDoc } from './useLayoutStore';

type LayoutStoreSnapshot = ReturnType<typeof useLayoutStore>;

/** Standard mock layout used across tests. */
const MOCK_LAYOUT: LayoutDoc = {
  id: 'default',
  name: 'Default',
  width: 24,
  height: 16,
  furniture: [],
  seats: {},
  updatedAt: 1000,
};

/** A different layout to simulate switching. */
const OTHER_LAYOUT: LayoutDoc = {
  id: 'other',
  name: 'Other',
  width: 24,
  height: 16,
  furniture: [],
  seats: {},
  updatedAt: 2000,
};

function StoreProbe({ onSnapshot }: { onSnapshot: (snapshot: LayoutStoreSnapshot) => void }) {
  const store = useLayoutStore();

  useEffect(() => {
    onSnapshot(store);
  }, [onSnapshot, store]);

  return null;
}

function latest<T>(items: T[]): T {
  const item = items[items.length - 1];
  if (!item) throw new Error('Expected at least one item');
  return item;
}

/** Create a fetch mock that responds to the layout API routes. */
function makeFetchMock(
  layouts: Record<string, LayoutDoc> = { default: MOCK_LAYOUT },
  captures: { lastPutBody?: LayoutDoc & { baseUpdatedAt?: number } } = {},
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    // GET /api/layouts — list all layouts
    if (url.endsWith('/api/layouts') && (!init || init.method === undefined || init.method === 'GET')) {
      return new Response(JSON.stringify({ layouts: Object.values(layouts) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /api/layouts — create new layout
    if (url.endsWith('/api/layouts') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string);
      const newLayout: LayoutDoc = {
        id: body.name.toLowerCase().replace(/\s+/g, '-'),
        name: body.name,
        width: body.width ?? 24,
        height: body.height ?? 16,
        furniture: [],
        seats: {},
        updatedAt: Date.now(),
      };
      layouts[newLayout.id] = newLayout;
      return new Response(JSON.stringify({ layout: newLayout }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // PUT /api/layouts/:id — save layout
    const putMatch = url.match(/\/api\/layouts\/(.+)$/);
    if (putMatch && init?.method === 'PUT') {
      const body = JSON.parse(init.body as string) as LayoutDoc;
      captures.lastPutBody = body;
      layouts[body.id] = body;
      return new Response(JSON.stringify({ layout: body }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /api/layouts/:id — load specific layout
    const getMatch = url.match(/\/api\/layouts\/([^/?]+)$/);
    if (getMatch) {
      const id = getMatch[1];
      const layout = layouts[id];
      if (layout) {
        return new Response(JSON.stringify(layout), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }

    // GET /api/furniture-catalog
    if (url.endsWith('/api/furniture-catalog')) {
      return new Response(JSON.stringify({ types: ['desk'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  });
}

describe('useLayoutStore', () => {
  let layouts: Record<string, LayoutDoc>;
  let captures: { lastPutBody?: LayoutDoc & { baseUpdatedAt?: number } };
  let snapshots: LayoutStoreSnapshot[];
  let unmount: () => void;

  beforeEach(() => {
    layouts = { default: { ...MOCK_LAYOUT }, other: { ...OTHER_LAYOUT } };
    captures = {};
    vi.stubGlobal('fetch', makeFetchMock(layouts, captures));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    snapshots = [];
  });

  async function renderStoreProbe() {
    snapshots = [];
    const view = render(<StoreProbe onSnapshot={(snapshot) => snapshots.push(snapshot)} />);
    unmount = view.unmount;
    // Flush microtasks for initial fetchLayouts + loadLayoutById('default')
    await act(async () => { await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0)); });
    return view;
  }

  it('loads the default layout on mount', async () => {
    await renderStoreProbe();
    expect(latest(snapshots).activeLayout?.id).toBe('default');
  });

  it('saveActiveLayout uses the most-recent active layout, not a stale closure', async () => {
    await renderStoreProbe();

    // The initial layout has updatedAt=1000
    expect(latest(snapshots).activeLayout?.updatedAt).toBe(1000);

    // Switch to the "other" layout (updatedAt=2000)
    await act(async () => {
      await latest(snapshots).loadLayoutById('other');
    });
    expect(latest(snapshots).activeLayout?.id).toBe('other');
    expect(latest(snapshots).activeLayout?.updatedAt).toBe(2000);

    // Save — should PUT with the "other" layout's updatedAt (2000),
    // not the stale "default" layout's updatedAt (1000).
    await act(async () => {
      await latest(snapshots).saveActiveLayout();
    });

    expect(captures.lastPutBody).toBeDefined();
    expect(captures.lastPutBody!.id).toBe('other');
    // baseUpdatedAt should be the "other" layout's updatedAt (2000),
    // proving saveActiveLayout read the latest state, not a stale one.
    expect(captures.lastPutBody!.baseUpdatedAt).toBe(2000);
  });

  it('saveActiveLayout is a no-op when no layout is active', async () => {
    await renderStoreProbe();

    // Force-clear the active layout
    await act(async () => {
      // Switch to a non-existent layout to trigger a load error;
      // the active layout stays as whatever was last loaded.
      // Instead, test via deleteLayout on the active layout.
      await latest(snapshots).deleteLayout('default');
    });

    // After deleting the active layout, it should be null
    expect(latest(snapshots).activeLayout).toBeNull();

    // Saving should be a no-op — no PUT should be made for this call
    const fetchCallsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      await latest(snapshots).saveActiveLayout();
    });
    // Allow the save promise chain to settle
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    // No PUT request should have been made in the saveActiveLayout call
    const putCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'PUT';
      }
    );
    // The only PUTs should be from before the deleteLayout, if any
    expect(putCalls.length).toBe(0);
  });

  it('updateFurniture applies functional updater to current layout', async () => {
    await renderStoreProbe();

    const furniture = [
      { id: 'f1', type: 'desk', x: 5, y: 5, rotation: 0 },
    ];

    await act(async () => {
      latest(snapshots).updateFurniture(furniture);
    });

    expect(latest(snapshots).activeLayout?.furniture).toEqual(furniture);

    // Functional updater form — delete by id
    await act(async () => {
      latest(snapshots).updateFurniture(prev => prev.filter(f => f.id !== 'f1'));
    });

    expect(latest(snapshots).activeLayout?.furniture).toEqual([]);
  });
});
