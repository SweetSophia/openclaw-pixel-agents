import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ControlAccessProvider } from '../control/ControlAccess';
import { AgentDetailPanel } from './AgentDetailPanel';
import type { AgentState } from '../../shared/types';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('browses a workspace with zero conversations and stops private task polling on that tab', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetch = vi.fn(async (path: string) => {
    const value = path.endsWith('/status') ? { configured: true, state: 'ready', canRead: true, canSend: false }
      : path.endsWith('/sessions') ? { sessions: [], source: { state: 'current', observedAt: 100 } }
        : path.endsWith('/workspace') ? { agentId: 'cylena', path: '', offset: 0, totalEntries: 1,
          entries: [{ path: 'report.txt', name: 'report.txt', kind: 'file', size: 5, updatedAtMs: 100 }], source: { state: 'current', observedAt: 100 }, sourceRevision: 'source-1' }
          : null;
    if (!value) throw Error(`Unexpected fixture request: ${path}`);
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  const agent: AgentState = { id: 'cylena', name: 'Cylena', activity: 'idle', model: 'fixture', sessionKey: '', pixelEnabled: true, active: true, tags: [], lastActivity: 0 };
  render(<ControlAccessProvider><AgentDetailPanel agent={agent} onClose={() => {}} /></ControlAccessProvider>);
  const taskPanel = screen.getByRole('tabpanel');
  const input = await within(taskPanel).findByLabelText('Task access key'); fireEvent.change(input, { target: { value: 'fixture-key' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unlock task details' })); });
  await within(taskPanel).findByText('No visible conversations for this agent yet.');
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Workspace' })); });
  await screen.findByText('report.txt');
  expect(screen.queryByRole('combobox', { name: 'Conversation' })).toBeNull();
  fetch.mockClear(); await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fetch.mock.calls.some(([path]) => path.endsWith('/workspace'))).toBe(true);
  expect(fetch.mock.calls.some(([path]) => /\/(sessions|task|history|results)(?:\?|$)/.test(path))).toBe(false);
});
