import { act, render, waitFor } from '@testing-library/react';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

    // DELETE /api/layouts/:id — delete layout (issue #109: explicit branch
    // so deletion tests cannot pass through a generic GET fallback)
    const deleteMatch = url.match(/\/api\/layouts\/([^/?]+)$/);
    if (deleteMatch && init?.method === 'DELETE') {
      const id = deleteMatch[1];
      const existed = id in layouts;
      delete layouts[id];
      return new Response(JSON.stringify({ ok: existed }), {
        status: existed ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /api/layouts/:id — load specific layout
    const getMatch = url.match(/\/api\/layouts\/([^/?]+)$/);
    if (getMatch && (!init || init.method === undefined || init.method === 'GET')) {
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
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    layouts = { default: { ...MOCK_LAYOUT }, other: { ...OTHER_LAYOUT } };
    captures = {};
    vi.stubGlobal('fetch', makeFetchMock(layouts, captures));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (unmount) unmount();
    unmount = undefined;
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

  it('saveActiveLayout always reads the latest active layout (invariant test)', async () => {
    await renderStoreProbe();

    // The initial layout has updatedAt=1000
    expect(latest(snapshots).activeLayout?.updatedAt).toBe(1000);

    // Switch to the "other" layout (updatedAt=2000)
    await act(async () => {
      await latest(snapshots).loadLayoutById('other');
    });
    expect(latest(snapshots).activeLayout?.id).toBe('other');
    expect(latest(snapshots).activeLayout?.updatedAt).toBe(2000);

    // Save — the PUT body's baseUpdatedAt should be 2000 (the "other"
    // layout's updatedAt), proving saveActiveLayout read the latest
    // committed state at the moment its async chain ran.
    //
    // This is an INVARIANT test for the new useReducer architecture: if
    // a future refactor introduces a path that bypasses the reducer
    // (and thus desyncs the ref), this test will catch the regression.
    await act(async () => {
      await latest(snapshots).saveActiveLayout();
    });

    expect(captures.lastPutBody).toBeDefined();
    expect(captures.lastPutBody!.id).toBe('other');
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

  // ── deleteLayout result contract (Sophie review @78f2bc3, fail-safe) ──
  //
  // The confirmation barrier in LayoutEditor closes ONLY on a strict `true`,
  // so the store must return a real boolean for every outcome. These pin that
  // contract — success → true, non-2xx → false, rejected fetch → false — so a
  // future route change can't turn the destructive delete into a fail-open.

  describe('deleteLayout result contract', () => {
    it('resolves true on a successful (2xx) delete', async () => {
      await renderStoreProbe();
      let result: boolean | undefined;
      await act(async () => {
        result = await latest(snapshots).deleteLayout('default');
      });
      expect(result).toBe(true);
    });

    it('resolves false on a non-2xx response', async () => {
      await renderStoreProbe();
      let result: boolean | undefined;
      await act(async () => {
        // 'missing' is not in the mock store, so DELETE returns 404.
        result = await latest(snapshots).deleteLayout('missing');
      });
      expect(result).toBe(false);
    });

    it('resolves false when the fetch rejects (network error)', async () => {
      await renderStoreProbe();
      (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));
      let result: boolean | undefined;
      await act(async () => {
        result = await latest(snapshots).deleteLayout('default');
      });
      expect(result).toBe(false);
    });
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

  // --- Auto-save tests ---

  it('does not auto-save during initial load', async () => {
    await renderStoreProbe();

    const putCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'PUT';
      }
    );
    expect(putCalls.length).toBe(0);
  });

  it('isDirty is false after initial load, true after updateFurniture', async () => {
    await renderStoreProbe();
    expect(latest(snapshots).isDirty).toBe(false);

    await act(async () => {
      latest(snapshots).updateFurniture([{ id: 'f1', type: 'desk', x: 5, y: 5, rotation: 0 }]);
    });
    expect(latest(snapshots).isDirty).toBe(true);
  });

  it('auto-saves after 2s debounce and clears isDirty', async () => {
    await renderStoreProbe();

    const putCountBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'PUT';
      }
    ).length;

    await act(async () => {
      latest(snapshots).updateFurniture([{ id: 'f1', type: 'desk', x: 5, y: 5, rotation: 0 }]);
    });
    expect(latest(snapshots).isDirty).toBe(true);

    // Wait for the 2-second debounce
    await act(async () => { await new Promise(r => setTimeout(r, 2100)); });

    // Auto-save should have fired
    const putCountAfter = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'PUT';
      }
    ).length;
    expect(putCountAfter).toBeGreaterThan(putCountBefore);
    expect(latest(snapshots).isDirty).toBe(false);
  });

  it('includes the latest absolute rotation in the autosave payload', async () => {
    await renderStoreProbe();
    vi.useFakeTimers();

    await act(async () => {
      latest(snapshots).updateFurniture([
        { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 90 },
      ]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(captures.lastPutBody?.furniture).toEqual([
      { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 90 },
    ]);
  });

  it('preserves and serializes edits made while an older save is in flight', async () => {
    layouts.default = {
      ...layouts.default,
      furniture: [{ id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 0 }],
    };
    await renderStoreProbe();

    const initialFetch = fetch;
    const firstResponse = deferred<Response>();
    const putBodies: Array<LayoutDoc & { baseUpdatedAt?: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
      if (url.endsWith('/api/layouts/default') && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as LayoutDoc & { baseUpdatedAt?: number };
        putBodies.push(body);
        if (putBodies.length === 1) return firstResponse.promise;
        return new Response(JSON.stringify({ layout: body }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return initialFetch(input, init);
    }));

    let firstSave!: Promise<void>;
    act(() => {
      firstSave = latest(snapshots).saveActiveLayout();
    });
    await waitFor(() => expect(putBodies).toHaveLength(1));

    vi.useFakeTimers();
    act(() => {
      latest(snapshots).updateFurniture([
        { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 90 },
      ]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const savedOlderLayout: LayoutDoc = {
      id: 'default',
      name: 'Default',
      width: 24,
      height: 16,
      furniture: [{ id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 0 }],
      seats: {},
      updatedAt: 2_000,
    };
    await act(async () => {
      firstResponse.resolve(new Response(JSON.stringify({ layout: savedOlderLayout }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await firstSave;
    });

    expect(latest(snapshots).activeLayout?.furniture[0].rotation).toBe(90);
    expect(latest(snapshots).isDirty).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(putBodies).toHaveLength(2);
    expect(putBodies[1].furniture[0].rotation).toBe(90);
    expect(putBodies[1].baseUpdatedAt).toBe(2_000);
  });

  it('keeps a newly loaded layout active when an older layout save finishes', async () => {
    await renderStoreProbe();

    const initialFetch = fetch;
    const firstResponse = deferred<Response>();
    const putBodies: Array<LayoutDoc & { baseUpdatedAt?: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
      if (url.includes('/api/layouts/') && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as LayoutDoc & { baseUpdatedAt?: number };
        putBodies.push(body);
        if (putBodies.length === 1) return firstResponse.promise;
      }
      return initialFetch(input, init);
    }));

    let defaultSave!: Promise<void>;
    act(() => {
      defaultSave = latest(snapshots).saveActiveLayout();
    });
    await waitFor(() => expect(putBodies).toHaveLength(1));

    await act(async () => {
      await latest(snapshots).loadLayoutById('other');
    });
    expect(latest(snapshots).activeLayout).toMatchObject({
      id: 'other',
      updatedAt: 2_000,
    });

    const savedDefaultLayout: LayoutDoc = {
      ...layouts.default,
      updatedAt: 3_000,
    };
    await act(async () => {
      firstResponse.resolve(new Response(JSON.stringify({ layout: savedDefaultLayout }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await defaultSave;
    });

    expect(latest(snapshots).activeLayout).toMatchObject({
      id: 'other',
      updatedAt: 2_000,
    });

    await act(async () => {
      await latest(snapshots).saveActiveLayout();
    });

    expect(putBodies).toHaveLength(2);
    expect(putBodies[1]).toMatchObject({
      id: 'other',
      baseUpdatedAt: 2_000,
    });
  });

  it('does not trust a successful save response without a valid layout', async () => {
    await renderStoreProbe();

    const initialFetch = fetch;
    const putBodies: Array<LayoutDoc & { baseUpdatedAt?: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
      if (url.endsWith('/api/layouts/default') && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as LayoutDoc & { baseUpdatedAt?: number };
        putBodies.push(body);
        if (putBodies.length === 1) {
          layouts.default = { ...body, updatedAt: 2_000 };
          return new Response(null, { status: 200 });
        }
        return new Response(JSON.stringify({
          layout: { ...body, updatedAt: 3_000 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return initialFetch(input, init);
    }));

    act(() => {
      latest(snapshots).updateFurniture([
        { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 90 },
      ]);
    });
    await act(async () => {
      await latest(snapshots).saveActiveLayout();
    });

    expect(latest(snapshots).isDirty).toBe(true);

    await act(async () => {
      await latest(snapshots).saveActiveLayout();
    });

    expect(putBodies).toHaveLength(2);
    expect(putBodies[1].baseUpdatedAt).toBe(2_000);
  });

  it('refreshes the server revision and retries a conflicted autosave', async () => {
    await renderStoreProbe();
    vi.useFakeTimers();

    const initialFetch = fetch;
    const putBodies: Array<LayoutDoc & { baseUpdatedAt?: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
      if (url.endsWith('/api/layouts/default') && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as LayoutDoc & { baseUpdatedAt?: number };
        putBodies.push(body);
        if (putBodies.length === 1) {
          layouts.default = { ...layouts.default, updatedAt: 2_000 };
          return new Response(JSON.stringify({ error: 'Conflict' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          layout: { ...body, updatedAt: 3_000 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return initialFetch(input, init);
    }));

    act(() => {
      latest(snapshots).updateFurniture([
        { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 90 },
      ]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(putBodies).toHaveLength(1);
    expect(latest(snapshots).isDirty).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(putBodies).toHaveLength(2);
    expect(putBodies[1].baseUpdatedAt).toBe(2_000);
    expect(putBodies[1].furniture[0].rotation).toBe(90);
    expect(latest(snapshots).isDirty).toBe(false);
  });

  it('does not move the persisted revision backwards after a same-id reload', async () => {
    await renderStoreProbe();

    const initialFetch = fetch;
    const firstResponse = deferred<Response>();
    const putBodies: Array<LayoutDoc & { baseUpdatedAt?: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
      if (url.endsWith('/api/layouts/default') && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as LayoutDoc & { baseUpdatedAt?: number };
        putBodies.push(body);
        if (putBodies.length === 1) return firstResponse.promise;
        return new Response(JSON.stringify({ layout: body }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return initialFetch(input, init);
    }));

    let firstSave!: Promise<void>;
    act(() => {
      firstSave = latest(snapshots).saveActiveLayout();
    });
    await waitFor(() => expect(putBodies).toHaveLength(1));

    layouts.default = { ...layouts.default, updatedAt: 3_000 };
    await act(async () => {
      await latest(snapshots).loadLayoutById('default');
    });
    expect(latest(snapshots).activeLayout?.updatedAt).toBe(3_000);

    await act(async () => {
      firstResponse.resolve(new Response(JSON.stringify({
        layout: { ...layouts.default, updatedAt: 2_000 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await firstSave;
    });

    await act(async () => {
      await latest(snapshots).saveActiveLayout();
    });

    expect(putBodies).toHaveLength(2);
    expect(putBodies[1].baseUpdatedAt).toBe(3_000);
  });

  it('recovers a keepalive conflict when the page remains active', async () => {
    await renderStoreProbe();

    const initialFetch = fetch;
    const putBodies: Array<LayoutDoc & { baseUpdatedAt?: number }> = [];
    let revisionFetches = 0;
    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
      if (url.endsWith('/api/layouts/default') && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as LayoutDoc & { baseUpdatedAt?: number };
        putBodies.push(body);
        if (init.keepalive) {
          layouts.default = { ...layouts.default, updatedAt: 2_000 };
          return new Response(JSON.stringify({ error: 'Conflict' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ layout: body }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/layouts/default') && init?.method !== 'PUT') {
        revisionFetches++;
      }
      return initialFetch(input, init);
    }));

    act(() => {
      latest(snapshots).updateFurniture([
        { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 90 },
      ]);
    });
    window.dispatchEvent(new Event('beforeunload') as BeforeUnloadEvent);
    await waitFor(() => expect(revisionFetches).toBe(1));

    await act(async () => {
      await latest(snapshots).saveActiveLayout();
    });

    expect(putBodies).toHaveLength(2);
    expect(putBodies[0].baseUpdatedAt).toBe(1_000);
    expect(putBodies[1].baseUpdatedAt).toBe(2_000);
  });

  it('advances the persisted revision after a successful keepalive save', async () => {
    await renderStoreProbe();

    const initialFetch = fetch;
    const putBodies: Array<LayoutDoc & { baseUpdatedAt?: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
      if (url.endsWith('/api/layouts/default') && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as LayoutDoc & { baseUpdatedAt?: number };
        putBodies.push(body);
        if (init.keepalive) {
          return new Response(JSON.stringify({
            layout: { ...body, updatedAt: 2_000 },
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          layout: { ...body, updatedAt: 3_000 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return initialFetch(input, init);
    }));

    act(() => {
      latest(snapshots).updateFurniture([
        { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 90 },
      ]);
    });
    window.dispatchEvent(new Event('beforeunload') as BeforeUnloadEvent);
    await waitFor(() => expect(putBodies).toHaveLength(1));
    // Flush the keepalive response handler (json parse + revision advance).
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    await act(async () => {
      await latest(snapshots).saveActiveLayout();
    });

    expect(putBodies).toHaveLength(2);
    expect(putBodies[0].baseUpdatedAt).toBe(1_000);
    // The follow-up save must chain from the revision the keepalive PUT
    // persisted (2_000), not the pre-keepalive revision (1_000).
    expect(putBodies[1].baseUpdatedAt).toBe(2_000);
  });

  it('debounces rapid furniture changes into a single save', async () => {
    await renderStoreProbe();

    const putCountBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'PUT';
      }
    ).length;

    // Make 3 rapid changes
    await act(async () => {
      latest(snapshots).updateFurniture([{ id: 'f1', type: 'desk', x: 1, y: 1, rotation: 0 }]);
    });
    await act(async () => {
      latest(snapshots).updateFurniture([{ id: 'f1', type: 'desk', x: 2, y: 2, rotation: 0 }]);
    });
    await act(async () => {
      latest(snapshots).updateFurniture([{ id: 'f1', type: 'desk', x: 3, y: 3, rotation: 0 }]);
    });

    // Wait for debounce
    await act(async () => { await new Promise(r => setTimeout(r, 2100)); });

    // Only 1 PUT should have been made (debounced)
    const putCountAfter = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'PUT';
      }
    ).length;
    expect(putCountAfter - putCountBefore).toBe(1);
  });

  // --- Oracle-driven regression tests (H1, H2, M1) ---

  it('beforeunload reads isDirtyRef synchronously (not stale closure)', async () => {
    // H1: The beforeunload handler must read isDirtyRef, not isDirty from
    // closure (which would be stale if isDirty changed after the listener
    // was registered). We verify this by:
    // 1. Render the probe (isDirty starts false)
    // 2. Make a furniture change (isDirty becomes true)
    // 3. Dispatch a beforeunload event WITHOUT waiting for any re-render
    // 4. Verify the handler detects the dirty state and calls preventDefault

    await renderStoreProbe();

    // Make a change so isDirty becomes true
    await act(async () => {
      latest(snapshots).updateFurniture([{ id: 'f1', type: 'desk', x: 1, y: 1, rotation: 0 }]);
    });
    expect(latest(snapshots).isDirty).toBe(true);

    // Dispatch beforeunload — the handler must see isDirtyRef.current === true
    // (not the stale closure value from when the listener was registered).
    // The default PUT mock returns 200, so the fetch call is fine.
    let prevented = false;
    const event = new Event('beforeunload') as BeforeUnloadEvent;
    Object.defineProperty(event, 'preventDefault', {
      value: () => { prevented = true; },
      writable: true,
    });

    // Dispatch before React's isDirty state propagates — this is the race
    // we're testing. If the handler used the isDirty closure, it would see
    // the old value (false) because the state update from updateFurniture
    // hasn't been committed to the closure yet.
    window.dispatchEvent(event);

    expect(prevented).toBe(true);
  });

  it('loadLayoutById confirms discard when isDirty is true (H2)', async () => {
    // H2: loadLayoutById must not silently discard unsaved changes.
    // If the user clicks Cancel on the confirm, the load is aborted.
    await renderStoreProbe();

    // Make a change so isDirty becomes true
    await act(async () => {
      latest(snapshots).updateFurniture([{ id: 'f1', type: 'desk', x: 1, y: 1, rotation: 0 }]);
    });
    expect(latest(snapshots).isDirty).toBe(true);

    // Mock window.confirm to simulate user clicking Cancel
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const initialLayoutId = latest(snapshots).activeLayout?.id;
    const result = await latest(snapshots).loadLayoutById('other');

    // Load was aborted — returns null
    expect(result).toBeNull();
    // Active layout is unchanged
    expect(latest(snapshots).activeLayout?.id).toBe(initialLayoutId);
    // Confirm was called
    expect(confirmSpy).toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('does not let a delayed remote reload overwrite a newer local edit', async () => {
    await renderStoreProbe();
    const originalFetch = vi.mocked(fetch);
    const pending = deferred<Response>();
    let deferRemoteLoad = true;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (
        deferRemoteLoad
        && url.endsWith('/api/layouts/default')
        && (!init || init.method === undefined || init.method === 'GET')
      ) {
        deferRemoteLoad = false;
        return pending.promise;
      }
      return originalFetch(input, init);
    }));

    let reconciliation!: Promise<void>;
    act(() => {
      reconciliation = latest(snapshots).reconcileRemoteLayout({ id: 'default' });
    });
    const localFurniture = [{ id: 'local', type: 'desk', x: 7, y: 8, rotation: 0 }];
    act(() => latest(snapshots).updateFurniture(localFurniture));

    pending.resolve(new Response(JSON.stringify({
      ...MOCK_LAYOUT,
      furniture: [{ id: 'remote', type: 'sofa', x: 1, y: 1, rotation: 0 }],
      updatedAt: 3000,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await act(async () => { await reconciliation; });

    expect(latest(snapshots).activeLayout?.furniture).toEqual(localFurniture);
    expect(latest(snapshots).isDirty).toBe(true);
  });

  it('blocks auto-save and manual save after a dirty layout is remotely deleted', async () => {
    await renderStoreProbe();
    await act(async () => { await latest(snapshots).loadLayoutById('other'); });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    vi.useFakeTimers();

    act(() => {
      latest(snapshots).updateFurniture([
        { id: 'local', type: 'desk', x: 2, y: 3, rotation: 0 },
      ]);
    });
    delete layouts.other;
    await act(async () => {
      await latest(snapshots).reconcileRemoteLayout({ id: 'other' });
      await latest(snapshots).saveActiveLayout();
      vi.advanceTimersByTime(5000);
      window.dispatchEvent(new Event('beforeunload') as BeforeUnloadEvent);
    });

    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
    expect(latest(snapshots).activeLayout?.id).toBe('other');
    expect(latest(snapshots).isDirty).toBe(true);
    expect(latest(snapshots).saveStatus).toBe('error');
  });

  it('loads the default when a clean active layout was deleted while disconnected', async () => {
    await renderStoreProbe();
    await act(async () => { await latest(snapshots).loadLayoutById('other'); });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    delete layouts.other;

    await act(async () => {
      await latest(snapshots).reconcileRemoteLayout({ id: 'other' });
    });

    const getCalls = fetchMock.mock.calls.filter(([input, init]) => {
      const url = typeof input === 'string' ? input : input.toString();
      return url.endsWith('/api/layouts/other')
        && (!init || init.method === undefined || init.method === 'GET');
    });
    expect(getCalls).toHaveLength(1);
    expect(latest(snapshots).activeLayout?.id).toBe('default');
    expect(latest(snapshots).isDirty).toBe(false);
    expect(latest(snapshots).saveStatus).toBe('idle');
  });

  it('ignores an older reconciliation response after a newer request observes deletion', async () => {
    await renderStoreProbe();
    await act(async () => { await latest(snapshots).loadLayoutById('other'); });
    const originalFetch = vi.mocked(fetch);
    const staleResponse = deferred<Response>();
    let otherGetCount = 0;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (
        url.endsWith('/api/layouts/other')
        && (!init || init.method === undefined || init.method === 'GET')
      ) {
        otherGetCount++;
        if (otherGetCount === 1) return staleResponse.promise;
        return Promise.resolve(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
      }
      return originalFetch(input, init);
    }));

    let older!: Promise<void>;
    act(() => {
      older = latest(snapshots).reconcileRemoteLayout({ id: 'other' });
    });
    await act(async () => {
      await latest(snapshots).reconcileRemoteLayout({ id: 'other' });
    });
    expect(latest(snapshots).activeLayout?.id).toBe('default');

    staleResponse.resolve(new Response(JSON.stringify({
      ...OTHER_LAYOUT,
      updatedAt: 3000,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await act(async () => { await older; });

    expect(latest(snapshots).activeLayout?.id).toBe('default');
  });

  it('retries auto-save on 5xx with exponential backoff (M1)', async () => {
    // M1: On 5xx, scheduleSaveRetry must reschedule with exponential
    // backoff (2s, 4s, 8s ...) so transient server errors don't strand
    // the user's edits. Regression test for the refactored retry path.
    await renderStoreProbe();
    vi.useFakeTimers();

    const initialFetch = fetch;
    const putBodies: Array<LayoutDoc & { baseUpdatedAt?: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
      if (url.endsWith('/api/layouts/default') && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as LayoutDoc & { baseUpdatedAt?: number };
        putBodies.push(body);
        if (putBodies.length === 1) {
          return new Response(JSON.stringify({ error: 'Service Unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ layout: { ...body, updatedAt: 2_000 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return initialFetch(input, init);
    }));

    act(() => {
      latest(snapshots).updateFurniture([
        { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 90 },
      ]);
    });

    // First save attempt (2s debounce).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(putBodies).toHaveLength(1);
    expect(latest(snapshots).isDirty).toBe(true);

    // First retry: scheduled at 2s * 2^0 = 2000ms after the 5xx.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(putBodies).toHaveLength(2);
    // The retried PUT carries the same furniture — the user's edit is preserved.
    expect(putBodies[1].furniture[0].rotation).toBe(90);
    expect(latest(snapshots).isDirty).toBe(false);
  });

  it('does not auto-save when activeLayout is null', async () => {
    // Edge case: if the active layout is null (e.g., after deleteLayout),
    // updateFurniture should not crash and no auto-save should fire.
    await renderStoreProbe();

    // Delete the active layout — this sets activeLayout to null
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });
    await act(async () => {
      const id = latest(snapshots).activeLayout?.id;
      if (id) await latest(snapshots).deleteLayout(id);
    });

    // Now try to update furniture on a null layout — should not crash
    await act(async () => {
      latest(snapshots).updateFurniture([{ id: 'f1', type: 'desk', x: 1, y: 1, rotation: 0 }]);
    });

    // Wait for debounce — no PUT should fire
    await act(async () => { await new Promise(r => setTimeout(r, 2100)); });

    const putCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'PUT';
      }
    );
    // Only the saveActiveLayout-related PUTs should be present, not auto-save
    expect(putCalls.length).toBe(0);
  });
});
