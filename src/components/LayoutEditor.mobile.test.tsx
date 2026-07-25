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
 * Regression test for the overlap family first reported in issue #87
 * (mobile toolbar vs room switcher) and generalized in the 2026 responsive
 * revamp: ALL chrome collisions came from absolutely positioned islands
 * with magic offsets.
 *
 * Current architecture: one fixed top bar composes brand, room switcher,
 * and controls in flex flow (collisions structurally impossible), and the
 * editor toolbar offsets from the shared `--topbar-h` variable so it always
 * clears the bar — including the two-row mobile wrap. These pins fail if
 * anyone reintroduces independent absolute positioning.
 */
describe('Issue #87 — mobile toolbar / room switcher overlap', () => {
  afterEach(cleanup);
  // ── CSS regression: catch anyone reverting the offset ──────────────

  it('derives the toolbar offset from the shared top-bar height', () => {
    const root = getRuleDeclarations(appCss, ':root');
    expect(root.get('--topbar-h')).toBe('64px');
    expect(root.get('--desktop-agent-sidebar-reserved-width')).toBe('316px');

    // Mobile wraps the top bar to two rows and grows the shared height var.
    const mobileRoot = getRuleDeclarations(appCss, ':root', MOBILE_MEDIA_QUERY);
    expect(mobileRoot.get('--topbar-h')).toBe('104px');

    // The room switcher is composed in flex flow inside the top bar — never
    // absolutely positioned. On mobile it becomes the full-width second row.
    const baseSwitcher = getRuleDeclarations(roomSwitcherCss, '.room-switcher');
    expect(baseSwitcher.get('position')).toBe('static');
    const mobileSwitcher = getRuleDeclarations(
      roomSwitcherCss,
      '.room-switcher',
      MOBILE_MEDIA_QUERY,
    );
    expect(mobileSwitcher.get('order')).toBe('3');
    expect(mobileSwitcher.get('top')).toBeUndefined();

    // The toolbar clears the whole bar via the shared var, in every mode.
    const editorToolbar = getRuleDeclarations(layoutEditorCss, '.editor-toolbar');
    const toolbarOffset = editorToolbar
      .get('margin-top')
      ?.replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')');
    expect(toolbarOffset).toBe('calc(var(--topbar-h) + 12px)');
  });

  it('reserves the desktop agent sidebar band above drawer width only', () => {
    // Desktop (above the 1024px drawer breakpoint): reserve the sidebar band.
    const desktopEditor = getRuleDeclarations(
      layoutEditorCss,
      '.layout-editor',
      '(min-width: 1025px)',
    );
    expect(desktopEditor.get('padding-right')).toBe(
      'var(--desktop-agent-sidebar-reserved-width)',
    );

    // Base rule reserves nothing: below 1024px the sidebar is an off-canvas
    // drawer, so the editor may use the full stage width.
    const baseEditor = getRuleDeclarations(layoutEditorCss, '.layout-editor');
    expect(baseEditor.get('padding-right')).toBeUndefined();
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

  it('fires onSave when Save is clicked with unsaved changes', () => {
    render(<LayoutEditor {...props} isDirty />);
    fireEvent.click(screen.getByTitle(/Save layout/));
    expect(props.onSave).toHaveBeenCalledOnce();
  });

  it('disables Save when there are no unsaved changes', () => {
    render(<LayoutEditor {...props} />);
    const saveButton = screen.getByTitle(/Save layout/);
    expect(saveButton).toHaveProperty('disabled', true);
    fireEvent.click(saveButton);
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('reflects the save lifecycle state from the layout store', () => {
    const { unmount } = render(<LayoutEditor {...props} isDirty saveStatus="saving" />);
    expect(screen.getByTitle('Saving layout…')).toHaveProperty('disabled', true);
    unmount();

    const { unmount: unmountSaved } = render(<LayoutEditor {...props} saveStatus="saved" />);
    expect(screen.getByTitle('Layout saved').textContent).toContain('✓ Saved');
    unmountSaved();

    // Error state: stays enabled so the user can retry immediately.
    render(<LayoutEditor {...props} saveStatus="error" />);
    const retryButton = screen.getByTitle(/Couldn't save/);
    expect(retryButton).toHaveProperty('disabled', false);
    fireEvent.click(retryButton);
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
