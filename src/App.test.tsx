import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlacedFurniture } from '../shared/types';
import { App } from './App';

const testState = vi.hoisted(() => ({
  updateFurniture: vi.fn(),
  pixelOfficeProps: null as null | {
    onRotateFurniture: (id: string, rotation: number) => void;
  },
  layoutEditorProps: null as null | {
    onRotateFurniture: (id: string) => void;
  },
}));

vi.mock('./hooks/useAgentStore', () => ({
  useAgentStore: () => ({
    agents: [],
    connected: true,
    toggleAgent: vi.fn(),
    toggleAll: vi.fn(),
    updateTags: vi.fn(),
    updateRecipe: vi.fn(),
    activeRoomId: 'default',
    setActiveRoomId: vi.fn(),
    roomAgents: [],
  }),
}));

vi.mock('./hooks/useLayoutStore', () => ({
  useLayoutStore: () => ({
    layouts: [],
    activeLayout: {
      id: 'default',
      name: 'Default',
      width: 24,
      height: 16,
      furniture: [{ id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 0 }],
      seats: {},
    },
    isDirty: false,
    catalog: [],
    loadLayoutById: vi.fn(),
    saveActiveLayout: vi.fn(),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    updateFurniture: testState.updateFurniture,
  }),
}));

vi.mock('./components/PixelOffice', () => ({
  PixelOffice: (props: NonNullable<typeof testState.pixelOfficeProps>) => {
    testState.pixelOfficeProps = props;
    return null;
  },
}));
vi.mock('./components/AgentSidebar', () => ({ AgentSidebar: () => null }));
vi.mock('./components/AgentDetailPanel', () => ({ AgentDetailPanel: () => null }));
vi.mock('./components/LayoutEditor', () => ({
  LayoutEditor: (props: NonNullable<typeof testState.layoutEditorProps>) => {
    testState.layoutEditorProps = props;
    return null;
  },
}));
vi.mock('./components/SoundControls', () => ({ SoundControls: () => null }));
vi.mock('./components/RoomSwitcher', () => ({ RoomSwitcher: () => null }));
vi.mock('./components/MessageTicker', () => ({ default: () => null }));

describe('App furniture rotation persistence', () => {
  afterEach(cleanup);

  beforeEach(() => {
    testState.updateFurniture.mockReset();
    testState.pixelOfficeProps = null;
    testState.layoutEditorProps = null;
  });

  it('applies the exact engine rotation through the layout-store updater', () => {
    render(<App />);

    act(() => {
      testState.pixelOfficeProps?.onRotateFurniture('desk-1', 90);
    });

    expect(testState.updateFurniture).toHaveBeenCalledOnce();
    const update = testState.updateFurniture.mock.calls[0][0] as (
      furniture: PlacedFurniture[],
    ) => PlacedFurniture[];

    // GameEngine already mutated the shared object to 90°. The React boundary
    // must persist that exact angle instead of adding another quarter turn.
    const engineOwnedFurniture: PlacedFurniture[] = [
      { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 90 },
    ];
    expect(update(engineOwnedFurniture)).toEqual([
      { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 90 },
    ]);
  });

  it('increments the latest store rotation for the toolbar callback', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '✏️ Editor' }));

    act(() => {
      testState.layoutEditorProps?.onRotateFurniture('desk-1');
    });

    expect(testState.updateFurniture).toHaveBeenCalledOnce();
    const update = testState.updateFurniture.mock.calls[0][0] as (
      furniture: PlacedFurniture[],
    ) => PlacedFurniture[];

    expect(update([
      { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 0 },
    ])).toEqual([
      { id: 'desk-1', type: 'DESK', x: 3, y: 4, rotation: 90 },
    ]);
  });
});
