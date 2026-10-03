import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

// Keep the real App mount boundary and LayoutEditor state/focus behavior;
// replace network stores and unrelated UI to avoid canvas or persistence writes.
vi.mock('./hooks/useAgentStore', () => ({
  useAgentStore: () => ({
    agents: [], roomAgents: [], connected: true, activeRoomId: 'default',
    toggleAgent: vi.fn(), toggleAll: vi.fn(), updateTags: vi.fn(),
    updateRecipe: vi.fn(), setActiveRoomId: vi.fn(),
  }),
}));
vi.mock('./hooks/useLayoutStore', () => ({
  useLayoutStore: () => ({
    layouts: [], activeLayout: null, isDirty: false, layoutError: null,
    catalog: ['DESK', 'PLANT'], clearLayoutError: vi.fn(),
    loadLayoutById: vi.fn(), saveActiveLayout: vi.fn(), createLayout: vi.fn(),
    deleteLayout: vi.fn(), updateFurniture: vi.fn(),
  }),
}));
vi.mock('./components/PixelOffice', () => ({ PixelOffice: () => null }));
vi.mock('./components/AgentSidebar', () => ({ AgentSidebar: () => null }));
vi.mock('./components/AgentDetailPanel', () => ({ AgentDetailPanel: () => null }));
vi.mock('./components/SoundControls', () => ({ SoundControls: () => null }));
vi.mock('./components/RoomSwitcher', () => ({ RoomSwitcher: () => null }));
vi.mock('./components/MessageTicker', () => ({ default: () => null }));

describe('App furniture palette session lifecycle', () => {
  afterEach(cleanup);

  it.each(['toolbar close', 'header toggle'])('discards panel/query state on %s and focuses a fresh search when reopened', exit => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '✏️ Editor' }));
    fireEvent.click(screen.getByTitle('Furniture palette'));
    const oldInput = screen.getByRole('searchbox', { name: 'Search furniture' });
    fireEvent.change(oldInput, { target: { value: 'plant' } });
    expect(screen.queryByTitle('Desk')).not.toBeInTheDocument();

    fireEvent.click(exit === 'toolbar close'
      ? screen.getByTitle('Exit editor')
      : screen.getByRole('button', { name: '✏️ Editor ON' }));
    expect(oldInput).not.toBeInTheDocument();
    expect(screen.queryByTitle('Furniture palette')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '✏️ Editor' }));
    const toggle = screen.getByTitle('Furniture palette');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    const newInput = screen.getByRole('searchbox', { name: 'Search furniture' });
    expect(newInput).not.toBe(oldInput);
    expect(newInput).toHaveValue('');
    expect(newInput).toHaveFocus();
    expect(screen.getByTitle('Desk')).toBeInTheDocument();
    expect(screen.getByTitle('Plant')).toBeInTheDocument();
  });
});
