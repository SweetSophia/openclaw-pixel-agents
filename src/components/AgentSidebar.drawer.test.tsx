/**
 * Drawer-mode contract tests for AgentSidebar (PR #121 bot-review fixes).
 *
 * Two classes of pins:
 *  1. CSS: below 1024px the CLOSED drawer must leave tab order and the a11y
 *     tree (visibility:hidden), not just the viewport (transform) — an
 *     off-screen panel whose controls stay tabbable is the classic
 *     off-canvas accessibility defect Codex flagged.
 *  2. Behavior: the `open` prop drives the `open` class and the close
 *     button requests `onClose`.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentSidebar } from './AgentSidebar';
import type { AgentState } from '../../shared/types';

vi.mock('./AgentPortrait', () => ({ AgentPortrait: () => null }));
vi.mock('./TagEditor', () => ({ TagEditor: () => null }));
vi.mock('./CharacterCustomizer', () => ({ CharacterCustomizer: () => null }));

const DRAWER_MEDIA_QUERY = '(max-width: 1024px)';
const COMPONENT_DIR = dirname(fileURLToPath(import.meta.url));
const sidebarCss = readFileSync(resolve(COMPONENT_DIR, 'AgentSidebar.css'), 'utf-8');

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

const agent: AgentState = {
  id: 'cybera',
  name: 'Cybera',
  activity: 'typing',
  model: 'm',
  sessionKey: 'k',
  active: true,
  lastActivity: 1,
  pixelEnabled: true,
  tags: [],
};

const baseProps = {
  agents: [agent],
  onToggle: vi.fn(),
  onToggleAll: vi.fn(),
};

describe('AgentSidebar drawer mode', () => {
  afterEach(cleanup);

  it('closed drawer is hidden from tab order and AT, open drawer is visible', () => {
    const closed = getRuleDeclarations(sidebarCss, '.agent-sidebar', DRAWER_MEDIA_QUERY);
    expect(closed.get('visibility')).toBe('hidden');
    expect(closed.get('transform')).toContain('translateX(105%)');

    const open = getRuleDeclarations(sidebarCss, '.agent-sidebar.open', DRAWER_MEDIA_QUERY);
    expect(open.get('visibility')).toBe('visible');
    expect(open.get('transform')).toBe('translateX(0)');
  });

  it('applies the open class from the prop and requests close from the close button', () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <AgentSidebar {...baseProps} open={false} onClose={onClose} />,
    );
    const aside = container.querySelector('aside')!;
    expect(aside.classList.contains('open')).toBe(false);

    rerender(<AgentSidebar {...baseProps} open onClose={onClose} />);
    expect(aside.classList.contains('open')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Close agents panel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('labels the aside and the icon-only card controls for assistive tech', () => {
    render(<AgentSidebar {...baseProps} open />);
    expect(screen.getByRole('complementary', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide Cybera from office' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add tags for Cybera' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Customize appearance for Cybera' })).toBeTruthy();
  });
});
