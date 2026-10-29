import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentDetailPanel } from './AgentDetailPanel';
import { ControlAccessProvider, useControlAccess } from '../control/ControlAccess';
import { parseControlTarget } from '../../shared/control';
import type { AgentState } from '../../shared/types';
const agent: AgentState = { id: 'cylena', name: 'Cylena', activity: 'typing', model: 'fixture', sessionKey: 'agent:cylena:main', pixelEnabled: true, active: true, tags: [], lastActivity: 0 };
const selected = { agentId: agent.id, sessionKey: agent.sessionKey, sessionId: 'session-1', name: 'Visible selected conversation', isChild: false, hasActiveRun: true };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('uses real private access/hook/panel routes, isolates local errors, and unmounts approval reads for history and new drafts', async () => {
  const calls: string[] = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push(path); const input = init?.body ? JSON.parse(String(init.body)) : {}; const target = parseControlTarget(input.target ?? input); const source = { state: 'current', observedAt: Date.now() };
    const task = { target, source, hasActiveRun: true, activeRunIds: ['run-current'], runId: input.runId ?? 'run-current', runState: 'running', requestAssociation: 'unknown', requestState: 'unavailable', activity: [], children: [], childrenComplete: false, loadedRecords: 4 };
    const body = path.endsWith('/status') ? { configured: true, state: 'ready', canRead: true, canSend: true, canStop: true, canReviewApprovals: true }
      : path.endsWith('/sessions') ? { sessions: [selected], source }
        : path.endsWith('/runs') ? { target, source, runs: [{ runId: 'run-old' }], runsTruncated: false, limitReached: false, loadedRecords: 4, messagesTruncated: false, ...(input.runId ? { selectedRunId: input.runId, task } : {}), messages: [] }
          : path.endsWith('/approvals/list') ? { code: 'approvals-denied' }
            : path.endsWith('/history') ? { target, source, messages: [] } : task;
    return new Response(JSON.stringify(body), { status: path.endsWith('/approvals/list') ? 403 : 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  function Harness() { const access = useControlAccess(); return <><button onClick={() => void access.unlock('fixture-key')}>Unlock fixture</button><span data-testid="access">{access.state}</span><AgentDetailPanel agent={agent} onClose={vi.fn()} /></>; }
  render(<ControlAccessProvider><Harness /></ControlAccessProvider>); fireEvent.click(screen.getByRole('button', { name: 'Unlock fixture', hidden: true }));
  await screen.findByRole('option', { name: /run-old/ }); fireEvent.click(screen.getByRole('tab', { name: 'Approvals' }));
  await screen.findByText(/Approval review was denied/); expect(screen.getByTestId('access')).toHaveTextContent('unlocked'); expect(screen.getByRole('combobox', { name: 'Conversation' })).toHaveDisplayValue(/Visible selected conversation/);
  calls.length = 0; fireEvent.change(screen.getByRole('combobox', { name: 'Task / run' }), { target: { value: 'run-old' } });
  await screen.findByText(/Approvals are available for the live conversation only/); await act(async () => {}); expect(calls.some(path => path.includes('/approvals/'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Return to live conversation' })); await waitFor(() => expect(calls.some(path => path.endsWith('/approvals/list'))).toBe(true));
  fireEvent.click(screen.getByRole('tab', { name: 'Conversation' })); fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Keep private draft' } });
  calls.length = 0; fireEvent.click(screen.getByRole('tab', { name: 'Approvals' }));
  await screen.findByText(/new conversation draft/i); expect(calls.some(path => path.includes('/approvals/'))).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: 'Conversation' })); expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep private draft');
  expect(within(screen.getByRole('tabpanel')).queryByRole('button', { name: 'Allow once' })).toBeNull();
});
