import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationApprovals } from './ConversationApprovals';
import type { ControlApproval } from '../../shared/controlApprovals';
import { ControlApiError } from '../control/api';
const access = vi.hoisted(() => ({ request: vi.fn(), generation: 1, state: 'unlocked', reason: undefined as string | undefined, canReviewApprovals: true }));
vi.mock('../control/ControlAccess', () => ({ useControlAccess: () => ({ ...access, status: { canRead: true, canReviewApprovals: access.canReviewApprovals, approvalsDisabledReason: access.reason } }) }));
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:main', sessionId: 'session-1' };
let item: ControlApproval;
beforeEach(() => {
  access.state = 'unlocked'; access.generation = 1; access.canReviewApprovals = true; access.reason = undefined;
  item = { id: 'approval-1', kind: 'plugin', title: 'Review plugin operation', text: '<script>literal https://example.test</script>', details: ['Warning: synthetic blast radius'], status: 'pending', createdAtMs: 1, expiresAtMs: Date.now() + 600000, sourceSessionKey: 'agent:cylena:child', allowedDecisions: ['allow-once', 'deny'] };
  access.request = vi.fn(async (path, init) => {
    const input = JSON.parse(String(init.body)); const base = { target: input.target, source: { state: 'current', observedAt: 1234 } };
    return path.endsWith('/list') ? { ...base, items: [item], truncated: true } : { ...base, approval: path.endsWith('/resolve') ? { ...item, status: 'allowed', resolvedAtMs: 20, allowedDecisions: [] } : item, applied: false, ...(path.endsWith('/inspect') && item.status === 'pending' ? { observationId: 'observation-1' } : {}) };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('renders bounded literal presentation and immutable inspected confirmation, with Cancel-first focus and Escape restoration', async () => {
  render(<ConversationApprovals target={target} active />); const allow = await screen.findByRole('button', { name: 'Allow once' });
  expect(screen.getByText(item.text)).toBeVisible(); expect(document.querySelector('script,a')).toBeNull(); expect(screen.getByText(/Source: child conversation/)).toBeVisible();
  allow.focus(); fireEvent.click(allow); const dialog = await screen.findByRole('dialog', { name: 'Confirm allow once' });
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  expect(within(dialog).getByText('approval-1')).toBeVisible(); expect(within(dialog).getByText(item.text)).toBeVisible(); expect(within(dialog).getByText('plugin')).toBeVisible(); expect(within(dialog).getByText(target.sessionKey)).toBeVisible();
  const escape = vi.fn(); document.addEventListener('keydown', escape); fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); document.removeEventListener('keydown', escape);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(allow).toHaveFocus();
  expect(access.request.mock.calls.filter(([path]) => String(path).endsWith('/resolve'))).toHaveLength(0);
  expect(screen.queryByRole('button', { name: /always|override/i })).toBeNull();
});
it('shows actual terminal truth and never calls a first-answer race our success', async () => {
  render(<ConversationApprovals target={target} active />); fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
  const dialog = await screen.findByRole('dialog', { name: 'Confirm deny' }); fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm deny' }));
  await screen.findByText(/not applied by this request/i); expect(screen.getAllByText(/allowed/i).length).toBeGreaterThan(0);
});
it.each(['disabled', 'scope-required', 'unsupported'])('explains explicit %s setup failures without actions', async reason => {
  access.canReviewApprovals = false; access.reason = reason; render(<ConversationApprovals target={target} active />);
  expect(screen.getByText(reason === 'scope-required' ? /operator.approvals/ : reason === 'unsupported' ? /does not support/ : /not enabled/)).toBeVisible(); expect(access.request).not.toHaveBeenCalled();
});
it('does not read or act in recorded mode', () => {
  render(<ConversationApprovals target={target} active readOnly />); expect(access.request).not.toHaveBeenCalled(); expect(screen.getByText(/live conversation only/i)).toBeVisible(); expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
});
it('fences a captured Confirm click after replacement before passive effects', async () => {
  let staleButton: HTMLButtonElement;
  function Harness({ current }: { current: typeof target }) {
    React.useLayoutEffect(() => { if (staleButton) staleButton.click(); }, [current]);
    return <ConversationApprovals target={current} active />;
  }
  const view = render(<Harness current={target} />); fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
  staleButton = within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm deny' });
  view.rerender(<Harness current={{ ...target, sessionId: 'replacement' }} />);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(access.request.mock.calls.filter(([path]) => String(path).endsWith('/resolve'))).toHaveLength(0);
});
it('fences duplicate same-task confirmation clicks before a response', async () => {
  const original = access.request.getMockImplementation()!; let finish!: (value: unknown) => void;
  access.request.mockImplementation((path, init) => path.endsWith('/resolve') ? new Promise(resolve => { finish = resolve; }) : original(path, init));
  render(<ConversationApprovals target={target} active />); fireEvent.click(await screen.findByRole('button', { name: 'Deny' })); const dialog = await screen.findByRole('dialog'); const confirm = within(dialog).getByRole('button', { name: 'Confirm deny' });
  act(() => { confirm.click(); confirm.click(); }); expect(access.request.mock.calls.filter(([path]) => String(path).endsWith('/resolve'))).toHaveLength(1);
  await act(async () => finish({ target, source: { state: 'current', observedAt: 22 }, approval: { ...item, status: 'denied', resolvedAtMs: 22, allowedDecisions: [] }, applied: true }));
});
it('retains explicit unknown-outcome inspection when polling drops the record from the pending audience', async () => {
  const original = access.request.getMockImplementation()!; let attempted = false;
  access.request.mockImplementation(async (path, init) => {
    if (path.endsWith('/resolve')) { attempted = true; throw new ControlApiError('approval-outcome-unknown'); }
    const value = await original(path, init); return path.endsWith('/list') && attempted ? { ...value, items: [] } : value;
  });
  render(<ConversationApprovals target={target} active />); fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm deny' }));
  await screen.findByText(/Approval outcome is unknown/); fireEvent.click(screen.getByRole('button', { name: 'Refresh approvals' }));
  await screen.findByText('No pending approvals visible for this conversation.');
  expect(screen.getByText(/Pending does not establish failure/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Reconcile approval-1' })).toBeEnabled();
});
