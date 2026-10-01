import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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

function makeProps(overrides: Partial<React.ComponentProps<typeof LayoutEditor>> = {}) {
  return {
    catalog: ['DESK'],
    activeLayout: defaultLayout,
    isDirty: false,
    layoutError: null,
    layouts: [defaultLayout],
    editorMode: true,
    selectedFurnitureType: 'DESK' as string | null,
    selectedFurnitureId: null as string | null,
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
    onDeleteLayout: vi.fn().mockResolvedValue(true),
    onToggleEditor: vi.fn(),
    ...overrides,
  };
}

/** The hint text is split across static and interpolated text nodes, so match
 *  on the .placement-hint container's textContent instead of a single node. */
function getPlacementHint(): HTMLElement {
  return screen.getByText(
    (_content, element) => element?.classList.contains('placement-hint') ?? false,
  );
}

describe('LayoutEditor placement hint room label', () => {
  afterEach(cleanup);

  it('names the supplied room in the placement hint', () => {
    render(<LayoutEditor {...makeProps({ roomName: 'Research Lab' })} />);
    expect(getPlacementHint().textContent).toContain('Click on the Research Lab to place Desk');
  });

  it('falls back to a generic label when no room name is provided', () => {
    render(<LayoutEditor {...makeProps({})} />);
    expect(getPlacementHint().textContent).toContain('Click on the room to place Desk');
  });

  it('renders no hint when no furniture type is selected', () => {
    render(<LayoutEditor {...makeProps({ selectedFurnitureType: null })} />);
    expect(
      screen.queryByText((_c, el) => el?.classList.contains('placement-hint') ?? false),
    ).toBeNull();
  });
});
