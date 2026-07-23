import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LayoutEditor } from './LayoutEditor';
import type { LayoutDoc } from '../hooks/useLayoutStore';

const MOBILE_MEDIA_QUERY = '(max-width: 768px)';
const COMPONENT_DIR = dirname(fileURLToPath(import.meta.url));
const appCss = readFileSync(resolve(COMPONENT_DIR, '../App.css'), 'utf-8');
const layoutEditorCss = readFileSync(resolve(COMPONENT_DIR, 'LayoutEditor.css'), 'utf-8');
const roomSwitcherCss = readFileSync(resolve(COMPONENT_DIR, 'RoomSwitcher.css'), 'utf-8');

function getRuleDeclarations(css: string, selector: string, mediaQuery?: string) {
  const styleElement = document.createElement('style');
  styleElement.textContent = css;
  document.head.append(styleElement);

  try {
    const sheet = styleElement.sheet;
    expect(sheet, 'CSS must produce a stylesheet').not.toBeNull();

    let rules = Array.from(sheet!.cssRules);
    if (mediaQuery) {
      const mediaRule = rules.find(
        (rule): rule is CSSMediaRule =>
          'conditionText' in rule && rule.conditionText === mediaQuery,
      );
      expect(mediaRule, `${mediaQuery} block must exist`).toBeDefined();
      rules = Array.from(mediaRule!.cssRules);
    }

    const styleRule = rules.find(
      (rule): rule is CSSStyleRule =>
        'selectorText' in rule && rule.selectorText === selector,
    );
    expect(styleRule, `${selector} rule must exist`).toBeDefined();

    const declarations = new Map<string, string>();
    for (let index = 0; index < styleRule!.style.length; index += 1) {
      const property = styleRule!.style.item(index);
      declarations.set(property, styleRule!.style.getPropertyValue(property).trim());
    }
    return declarations;
  } finally {
    styleElement.remove();
  }
}

/**
 * Regression test for issue #87: mobile toolbar overlap with room switcher.
 *
 * Root cause: at ≤768px the room switcher sits at top:64px with z-index:100
 * and a height of 46px (bottom edge 110px). The editor toolbar was at
 * margin-top:60px inside a z-index:90 container — so it occupied the same
 * vertical band and lost hit-testing to the room switcher.
 *
 * Fix: derive both elements from shared mobile HUD geometry so future room
 * switcher changes cannot silently reintroduce the overlap.
 */
describe('Issue #87 — mobile toolbar / room switcher overlap', () => {
  afterEach(cleanup);
  // ── CSS regression: catch anyone reverting the offset ──────────────

  it('derives the mobile toolbar offset from the room switcher geometry', () => {
    const root = getRuleDeclarations(appCss, ':root');
    expect(root.get('--mobile-room-switcher-top')).toBe('64px');
    expect(root.get('--mobile-room-switcher-height')).toBe('46px');
    expect(root.get('--mobile-editor-toolbar-gap')).toBe('10px');
    expect(root.get('--desktop-agent-sidebar-reserved-width')).toBe('316px');

    const roomSwitcher = getRuleDeclarations(
      roomSwitcherCss,
      '.room-switcher',
      MOBILE_MEDIA_QUERY,
    );

    expect(roomSwitcher.get('top')).toBe('var(--mobile-room-switcher-top)');
    expect(roomSwitcher.get('height')).toBe('var(--mobile-room-switcher-height)');

    const editorToolbar = getRuleDeclarations(
      layoutEditorCss,
      '.editor-toolbar',
      MOBILE_MEDIA_QUERY,
    );
    const toolbarOffset = editorToolbar
      .get('margin-top')
      ?.replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')');
    expect(toolbarOffset).toBe(
      'calc(var(--mobile-room-switcher-top) + var(--mobile-room-switcher-height) + var(--mobile-editor-toolbar-gap))',
    );
  });

  it('reserves the desktop agent sidebar band and releases it on mobile', () => {
    const desktopEditor = getRuleDeclarations(layoutEditorCss, '.layout-editor');
    expect(desktopEditor.get('padding-right')).toBe(
      'var(--desktop-agent-sidebar-reserved-width)',
    );

    const mobileEditor = getRuleDeclarations(
      layoutEditorCss,
      '.layout-editor',
      MOBILE_MEDIA_QUERY,
    );
    expect(mobileEditor.get('padding-right')).toBe('0px');
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

  it('opens the layout manager when Layouts is clicked', () => {
    render(<LayoutEditor {...props} />);
    fireEvent.click(screen.getByTitle('Layout manager'));
    // Layouts toggle is internal state; the panel opens
    // Verify the layout list renders
    expect(screen.getByText('Default')).toBeTruthy();
  });
});
