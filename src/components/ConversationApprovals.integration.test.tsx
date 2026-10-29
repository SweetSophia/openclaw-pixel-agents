import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentDetailPanel } from './AgentDetailPanel';
import { ControlAccessProvider, useControlAccess } from '../control/ControlAccess';
import { parseControlTarget } from '../../shared/control';
import type { AgentState } from '../../shared/types';
const agent: AgentState = { id: 'cylena', name: 'Cylena', activity: 'typing', model: 'fixture', sessionKey: 'agent:cylena:main', pixelEnabled: true, active: true, tags: [], lastActivity: 0 };
const selected = { agentId: agent.id, sessionKey: agent.sessionKey, sessionId: 'session-1', name: 'Visible selected conversation', isChild: false, hasActiveRun: true };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
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

it.each(['expiry', 'terminal', 'unknown', 'removed', 'tab', 'selection', 'escape', 'keyboard'] as const)('restores stable approval context after %s without stealing navigation focus', async scenario => {
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const approval = { id: 'focus-approval', kind: 'exec', title: 'Synthetic focus request', text: 'synthetic only', details: [], status: 'pending', createdAtMs: 1, expiresAtMs: now + 600000, allowedDecisions: ['allow-once', 'deny'] };
  const replacement = { ...selected, sessionId: 'session-2', sessionKey: 'agent:cylena:other', name: 'Other selected conversation' };
  const close = vi.fn(); let audienceVisible = true;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const input = init?.body ? JSON.parse(String(init.body)) : {}; const target = parseControlTarget(input.target ?? input); const source = { state: 'current', observedAt: now };
    const task = { target, source, hasActiveRun: true, activeRunIds: ['run-current'], runId: 'run-current', runState: 'running', requestAssociation: 'unknown', requestState: 'unavailable', activity: [], children: [], childrenComplete: false, loadedRecords: 4 };
    const body = path.endsWith('/status') ? { configured: true, state: 'ready', canRead: true, canSend: true, canStop: true, canReviewApprovals: true }
      : path.endsWith('/sessions') ? { sessions: [selected, replacement], source }
        : path.endsWith('/runs') ? { target, source, runs: [], runsTruncated: false, limitReached: false, loadedRecords: 4, messagesTruncated: false, messages: [] }
          : path.endsWith('/approvals/list') ? { target, source, items: audienceVisible ? [approval] : [], truncated: false }
            : path.endsWith('/approvals/inspect') ? { target, source, approval, applied: false, observationId: 'focus-observation' }
              : path.endsWith('/approvals/resolve') ? scenario === 'unknown' ? { code: 'approval-outcome-unknown' } : { target, source, approval: { ...approval, status: 'denied', resolvedAtMs: now, allowedDecisions: [] }, applied: true }
                : path.endsWith('/history') ? { target, source, messages: [] } : task;
    return new Response(JSON.stringify(body), { status: path.endsWith('/resolve') && scenario === 'unknown' ? 409 : 200, headers: { 'Content-Type': 'application/json' } });
  }));
  function Harness() { const access = useControlAccess(); return <><button onClick={() => void access.unlock('fixture-key')}>Unlock focus fixture</button><AgentDetailPanel agent={agent} onClose={close} /></>; }
  const view = render(<ControlAccessProvider><Harness /></ControlAccessProvider>); fireEvent.click(screen.getByRole('button', { name: 'Unlock focus fixture', hidden: true }));
  await screen.findByRole('option', { name: /Visible selected conversation/ }); fireEvent.click(screen.getByRole('tab', { name: 'Approvals' }));
  const deny = await screen.findByRole('button', { name: 'Deny' }); deny.focus(); fireEvent.click(deny);
  const dialog = await screen.findByRole('dialog', { name: 'Confirm deny' }); expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  if (scenario === 'keyboard') {
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm deny' });
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); expect(confirm).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); expect(cancel).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true }); expect(confirm).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true }); expect(cancel).toHaveFocus();
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith('/resolve'))).toBe(false);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); expect(close).not.toHaveBeenCalled(); expect(deny).toHaveFocus();
  } else if (scenario === 'escape') {
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); expect(close).not.toHaveBeenCalled(); expect(deny).toHaveFocus();
  } else if (scenario === 'expiry') {
    now = approval.expiresAtMs + 1; view.rerender(<ControlAccessProvider><Harness /></ControlAccessProvider>);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Confirm deny' })).toBeNull()); expect(screen.getByRole('button', { name: 'Inspect focus-approval' })).toHaveFocus();
  } else if (scenario === 'tab') {
    const tab = screen.getByRole('tab', { name: 'Task' }); tab.focus(); fireEvent.click(tab); await act(async () => {}); expect(tab).toHaveFocus();
  } else if (scenario === 'selection') {
    const selector = screen.getByRole('combobox', { name: 'Conversation' }); selector.focus();
    fireEvent.change(selector, { target: { value: '["cylena","agent:cylena:other","session-2",null,null]' } }); await act(async () => {}); expect(selector).toHaveFocus();
  } else if (scenario === 'removed') {
    audienceVisible = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh approvals' }));
    await screen.findByText('No pending approvals visible for this conversation.'); expect(screen.getByRole('button', { name: 'Refresh approvals' })).toHaveFocus();
  } else {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm deny' }));
    await screen.findByText(scenario === 'unknown' ? /Approval outcome is unknown/ : /Applied by this request/);
    await waitFor(() => expect(document.activeElement === screen.getByRole('button', { name: 'Inspect focus-approval' })
      || document.activeElement === screen.getByRole('button', { name: 'Refresh approvals' })
      || document.activeElement === screen.getByRole('heading', { name: 'Live conversation approvals' })).toBe(true));
  }
  expect(screen.queryByRole('dialog', { name: 'Confirm deny' })).toBeNull();
});
