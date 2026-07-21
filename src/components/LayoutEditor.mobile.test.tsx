import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { LayoutEditor } from './LayoutEditor';
import type { LayoutDoc } from '../hooks/useLayoutStore';

/**
 * Regression test for issue #87: mobile toolbar overlap with room switcher.
 *
 * Root cause: at ≤768px the room switcher sits at top:64px with z-index:100
 * and a height of ~44px (bottom edge ≈108px). The editor toolbar was at
 * margin-top:60px inside a z-index:90 container — so it occupied the same
 * vertical band and lost hit-testing to the room switcher.
 *
 * Fix: bump mobile toolbar margin-top to 120px so it clears the switcher.
 */
describe('Issue #87 — mobile toolbar / room switcher overlap', () => {
  afterEach(cleanup);

  // ── CSS regression: catch anyone reverting the offset ──────────────

  it('mobile editor-toolbar margin-top clears the room switcher bottom edge (≥108px)', () => {
    const css = readFileSync(
      resolve(__dirname, 'LayoutEditor.css'),
      'utf-8',
    );

    // Extract the mobile media query block
    const mobileBlock = css.match(/@media\s*\(max-width:\s*768px\)\s*\{([^}]*\{[^}]*\}[^}]*)\}/s);
    expect(mobileBlock, 'mobile @media block must exist').not.toBeNull();
    const rules = mobileBlock![1];

    const toolbarMatch = rules.match(/\.editor-toolbar\s*\{([^}]*)\}/s);
    expect(toolbarMatch, '.editor-toolbar rule in mobile media query').not.toBeNull();

    const marginTopMatch = toolbarMatch![1].match(/margin-top:\s*(\d+)px/);
    expect(marginTopMatch, 'margin-top must be a pixel value').not.toBeNull();

    const marginTop = parseInt(marginTopMatch![1], 10);
    // Room switcher bottom edge ≈ top(64) + padding(4+4) + min-height(36) + border(2) = ~110px
    // Use 108 as the floor — anything below overlaps.
    expect(marginTop).toBeGreaterThanOrEqual(108);
  });

  // ── Functional regression: toolbar buttons render and fire ──────────

  const mockLayout: LayoutDoc = {
    id: 'default',
    name: 'Default',
    width: 24,
    height: 16,
    furniture: [],
    seats: {},
    updatedAt: 1,
  };

  const props = {
    catalog: ['DESK', 'PLANT'],
    activeLayout: mockLayout,
    isDirty: false,
    layouts: [mockLayout],
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
  };

  beforeEach(() => {
    Object.values(props).forEach(fn => {
      if (typeof fn === 'function' && 'mockClear' in fn) (fn as ReturnType<typeof vi.fn>).mockClear();
    });
  });

  it('renders all five toolbar controls in editor mode', () => {
    render(<LayoutEditor {...props} />);

    expect(screen.getByTitle('Furniture palette')).toBeTruthy();
    expect(screen.getByTitle('Delete mode — click placed items to remove them')).toBeTruthy();
    expect(screen.getByTitle('Layout manager')).toBeTruthy();
    expect(screen.getByTitle(/Save layout/)).toBeTruthy();
    expect(screen.getByTitle('Exit editor')).toBeTruthy();
  });

  it('fires onSave when Save is clicked', () => {
    render(<LayoutEditor {...props} />);
    fireEvent.click(screen.getByTitle(/Save layout/));
    expect(props.onSave).toHaveBeenCalledOnce();
  });

  it('fires onToggleEditor when Close is clicked', () => {
    render(<LayoutEditor {...props} />);
    fireEvent.click(screen.getByTitle('Exit editor'));
    expect(props.onToggleEditor).toHaveBeenCalledOnce();
  });

  it('fires onToggleDeleteMode when Delete is clicked', () => {
    render(<LayoutEditor {...props} />);
    fireEvent.click(screen.getByTitle(/Delete mode/));
    expect(props.onToggleDeleteMode).toHaveBeenCalledOnce();
  });

  it('opens the furniture palette when Furniture is clicked', () => {
    render(<LayoutEditor {...props} />);
    fireEvent.click(screen.getByTitle('Furniture palette'));
    // Palette panel opens — category headers become visible
    expect(screen.getByText('Desks & Seating')).toBeTruthy();
    expect(screen.getByText('Plants')).toBeTruthy();
  });

  it('fires onLoad manager toggle when Layouts is clicked', () => {
    render(<LayoutEditor {...props} />);
    fireEvent.click(screen.getByTitle('Layout manager'));
    // Layouts toggle is internal state; the panel opens
    // Verify the layout list renders
    expect(screen.getByText('Default')).toBeTruthy();
  });
});
