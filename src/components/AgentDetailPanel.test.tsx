import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentDetailPanel } from './AgentDetailPanel';
import type { AgentState } from '../../shared/types';

const agent: AgentState = { id: 'cylena', name: 'Cylena', activity: 'idle', model: 'fixture', sessionKey: 'agent:cylena:test', pixelEnabled: true, active: true, tags: [], lastActivity: 0 };
afterEach(cleanup);
it('provides five ARIA tabs with dynamic wrapping/Home/End and restores focus after closing', () => {
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus(); const close = vi.fn();
  const { unmount } = render(<AgentDetailPanel agent={agent} onClose={close} />);
  const tabs = screen.getAllByRole('tab'); expect(tabs.map(tab => tab.textContent)).toEqual(['Task', 'Conversation', 'Results', 'Workspace', 'Agent']);
  expect(tabs[0]).toHaveAttribute('aria-selected', 'true'); fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' }); expect(tabs[4]).toHaveFocus();
  fireEvent.keyDown(tabs[4], { key: 'Home' }); expect(tabs[0]).toHaveFocus(); fireEvent.keyDown(tabs[0], { key: 'ArrowRight' }); expect(tabs[1]).toHaveFocus();
  fireEvent.keyDown(tabs[1], { key: 'ArrowRight' }); expect(tabs[2]).toHaveFocus(); expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
  expect(document.getElementById(tabs[2].getAttribute('aria-controls')!)).toHaveAttribute('aria-labelledby', tabs[2].id);
  fireEvent.keyDown(tabs[2], { key: 'ArrowRight' }); expect(tabs[3]).toHaveFocus(); expect(tabs[3]).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(tabs[3], { key: 'End' }); expect(tabs[4]).toHaveFocus(); fireEvent.keyDown(tabs[4], { key: 'ArrowRight' }); expect(tabs[0]).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' }); expect(close).toHaveBeenCalled(); unmount(); expect(trigger).toHaveFocus(); expect(document.querySelector('.detail-overlay')).toBeNull(); trigger.remove();
});
