import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScheduleIntent, ScheduleSnapshot } from '../../shared/controlSchedules';
import type { AgentState } from '../../shared/types';
import { AgentDetailPanel } from './AgentDetailPanel';
import { ControlApiError } from '../control/api';

const access = vi.hoisted(() => ({ request: vi.fn(), state: 'unlocked', generation: 1 }));
vi.mock('../control/ControlAccess', () => ({ useConversationDrafts: () => undefined, useControlAccess: () => ({ ...access,
  status: { configured: true, state: 'ready', canRead: true, canSend: false }, lock: vi.fn() }) }));
const agent: AgentState = { id: 'cylena', name: 'Cylena', activity: 'idle', model: 'fixture', sessionKey: 'agent:cylena:fixture', pixelEnabled: true, active: false, tags: [], lastActivity: 0 };
const draft = { name: 'Synthetic check', message: 'Synthetic private prompt', schedule: { kind: 'every' as const, everyMs: 60000 } };
const operationId = '11111111-1111-4111-8111-111111111111';
let snapshot: ScheduleSnapshot; let submissions: ScheduleIntent[];
beforeEach(() => {
  access.state = 'unlocked'; access.generation = 1; submissions = [];
  snapshot = { agentId: agent.id, source: { state: 'current', observedAt: 1234 }, management: { configured: true, state: 'ready', canManage: true, epoch: 'epoch-1', reason: null }, jobs: [], operations: [], scanned: 0, truncated: false };
  let confirmationNumber = 0;
  access.request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/status')) return { configured: true, state: 'ready', canRead: true, canSend: false };
    if (path.endsWith('/sessions')) return { sessions: [], source: snapshot.source };
    const input = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith('/prepare')) return { operationId: `11111111-1111-4111-8111-${String(++confirmationNumber).padStart(12, '0')}`, agentId: agent.id, epoch: 'epoch-1', expiresAt: 1, intent: input.intent, currentEnabled: input.intent.kind === 'create' ? null : snapshot.jobs[0]?.enabled ?? false };
    if (path.endsWith('/submit')) {
      submissions.push(input.intent);
      if (input.intent.kind === 'create') snapshot = { ...snapshot, jobs: [{ id: 'job-1', agentId: agent.id, name: draft.name, enabled: false, revision: 'r1', scheduleKind: 'every', draft, readOnlyReason: null }] };
      return { operationId: input.operationId, agentId: agent.id, action: input.intent.kind, state: 'confirmed', jobId: 'job-1' };
    }
    if (path.endsWith('/reconcile')) return { operationId, agentId: agent.id, action: 'create', state: 'observed', jobId: 'job-1' };
    if (path.includes('/operations?')) return { agentId: agent.id, operations: [] };
    return snapshot;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function open() {
  const result = render(<AgentDetailPanel agent={agent} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Schedules' }));
  await screen.findByRole('button', { name: 'New schedule' });
  await waitFor(() => expect(screen.queryByText('Loading schedules…')).toBeNull());
  return result;
}
function fill() {
  fireEvent.click(screen.getByRole('button', { name: 'New schedule' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Schedule name' }), { target: { value: draft.name } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: draft.message } });
}
it('can_open_schedules_for_agent_without_sessions', async () => {
  await open(); expect(screen.getByText('No schedules found for this agent.')).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Conversation' })).toBeNull();
  expect(submissions).toEqual([]);
});
it('creates_disabled_then_enables_only_after_second_confirmation', async () => {
  await open(); fill(); fireEvent.click(screen.getByRole('button', { name: 'Review disabled creation' }));
  const review = await screen.findByRole('region', { name: 'Review schedule change' });
  expect(review).toHaveFocus();
  expect(within(review).getByText(/Agent: cylena/)).toBeInTheDocument();
  expect(within(review).getByText(/Created disabled/)).toBeInTheDocument(); expect(submissions).toHaveLength(0);
  fireEvent.click(within(review).getByRole('button', { name: 'Create disabled schedule' }));
  await screen.findByText(/Native change acknowledged/); expect(submissions).toEqual([{ kind: 'create', draft }]);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  const enable = await screen.findByRole('button', { name: 'Enable Synthetic check' });
  await waitFor(() => expect(enable).toBeEnabled()); fireEvent.click(enable);
  const second = await screen.findByRole('region', { name: 'Review schedule change' });
  expect(within(second).getByText(/ordinary tools can act externally/i)).toBeInTheDocument();
  expect(submissions).toHaveLength(1);
  fireEvent.click(within(second).getByRole('button', { name: 'Confirm enable' }));
  await waitFor(() => expect(submissions).toHaveLength(2)); expect(submissions[1]).toEqual({ kind: 'enabled', jobId: 'job-1', revision: 'r1', enabled: true });
});
it('enabled_edit_warns_future_runs_change and cancel restores its trigger', async () => {
  snapshot.jobs = [{ id: 'job-1', agentId: agent.id, name: draft.name, enabled: true, revision: 'r1', scheduleKind: 'every', draft, readOnlyReason: null, timingMetadata: { anchorMs: 1000, staggerMs: 5000 } }];
  await open(); const edit = screen.getByRole('button', { name: 'Edit Synthetic check' }); fireEvent.click(edit);
  expect(screen.getByText(/future runs/i)).toBeInTheDocument(); expect(screen.getByText(/reanchor/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Review edit' }));
  const review = await screen.findByRole('region', { name: 'Review schedule change' });
  expect(within(review).getByText(/Job: job-1/)).toBeInTheDocument();
  fireEvent.click(within(review).getByRole('button', { name: 'Cancel confirmation' }));
  expect(screen.getByRole('button', { name: 'Review edit' })).toHaveFocus(); expect(submissions).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' })); expect(edit).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Pause Synthetic check' }));
  expect(await screen.findByText(/existing runs may continue/i)).toBeInTheDocument(); expect(submissions).toHaveLength(0);
});
it('unsupported_rows_never_show_raw_payload', async () => {
  snapshot.jobs = [{ id: 'unsupported', agentId: agent.id, name: 'Native-only row', enabled: true, revision: null, scheduleKind: 'at', draft: null, readOnlyReason: 'unsupported-definition' }];
  await open(); expect(screen.getByText(/unsupported-definition/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^(Edit|Enable|Pause) / })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Task prompt' })).toBeNull();
  expect(screen.queryByText(/next run/i)).toBeNull();
});
it('unknown_operation_has_reconcile_not_retry and separate pagination purposes', async () => {
  snapshot = { ...snapshot, scanned: 200, truncated: true, nextCursor: 'browse-200', operationsCursor: 'metadata-50', operations: [{ operationId, agentId: agent.id, action: 'create', state: 'unknown' }] };
  await open(); expect(screen.getByRole('button', { name: 'Reconcile' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: /retry|run now|delete/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Load more schedules' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Load more recovery records' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile' })); await screen.findByText(/Native state observed/);
  expect(submissions).toHaveLength(0);
});
it('keeps incomplete fields across mounted tabs and clears them on generation and lock', async () => {
  const view = await open(); fireEvent.click(screen.getByRole('button', { name: 'New schedule' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Partial private form' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Agent' })); fireEvent.click(screen.getByRole('tab', { name: 'Schedules' }));
  expect(screen.getByRole('textbox', { name: 'Task prompt' })).toHaveValue('Partial private form');
  access.generation++; view.rerender(<AgentDetailPanel agent={agent} onClose={vi.fn()} />);
  expect(screen.queryByRole('textbox', { name: 'Task prompt' })).toBeNull();
  await act(async () => {}); fill(); access.state = 'locked'; access.generation++;
  view.rerender(<AgentDetailPanel agent={agent} onClose={vi.fn()} />); expect(document.body.textContent).not.toContain(draft.message);
  expect(submissions).toHaveLength(0);
});
it.each(['disabled', 'pairing-required'] as const)('keeps readable schedules with management %s', async state => {
  snapshot.management = { configured: state !== 'disabled', state, canManage: false, epoch: null, reason: state };
  await open(); expect(screen.getByText(new RegExp(`Management: ${state}`))).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'New schedule' })).toBeDisabled();
});
it('metadata read errors block creation without hiding native rows or edits', async () => {
  snapshot.operationsError = 'storage-unavailable'; snapshot.jobs = [{ id: 'job-1', agentId: agent.id, name: draft.name, enabled: false, revision: 'r1', scheduleKind: 'every', draft, readOnlyReason: null }];
  await open(); expect(screen.getByText(/Recovery metadata could not be read/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'New schedule' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Edit Synthetic check' })).toBeEnabled();
});
it('local invalid cron/timezone fields prevent prepare and show labeled errors', async () => {
  await open(); fill(); fireEvent.change(screen.getByRole('combobox', { name: 'Timing' }), { target: { value: 'cron' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Five-field cron expression' }), { target: { value: '* * *' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'IANA timezone' }), { target: { value: 'Not/A_Zone' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review disabled creation' }));
  expect(screen.getByText(/Enter exactly five cron fields/)).toBeInTheDocument(); expect(screen.getByText(/Enter a valid IANA timezone/)).toBeInTheDocument();
  expect(access.request.mock.calls.some(([path]) => path.endsWith('/prepare'))).toBe(false);
});

it('incoming_row_revision_does_not_silently_rebase_open_editor', async () => {
  snapshot.jobs = [{ id: 'job-1', agentId: agent.id, name: draft.name, enabled: true, revision: 'r1', scheduleKind: 'every', draft, readOnlyReason: null }];
  await open();
  let finish!: (value: ScheduleSnapshot) => void;
  const original = access.request.getMockImplementation()!;
  access.request.mockImplementationOnce(() => Promise.resolve({ configured: true, state: 'ready', canRead: true, canSend: false }));
  access.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  // The status refresh admits the schedule read just after this editor opens.
  fireEvent.click(screen.getByRole('button', { name: 'Edit Synthetic check' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Retain my edited prompt' } });
  await waitFor(() => expect(finish).toBeDefined());
  snapshot = { ...snapshot, jobs: [{ ...snapshot.jobs[0], revision: 'r2', name: 'Changed native definition', draft: { ...draft, name: 'Changed native definition', message: 'New native prompt' } }] };
  await act(async () => { finish(snapshot); });
  access.request.mockImplementation(original);
  const changed = await screen.findByRole('region', { name: 'Changed schedule target' });
  expect(screen.getByRole('textbox', { name: 'Task prompt' })).toHaveValue('Retain my edited prompt');
  expect(screen.getByRole('button', { name: 'Review edit' })).toBeDisabled();
  expect(within(changed).getByText(/Revision: r2/)).toBeInTheDocument();
  expect(access.request.mock.calls.some(([path]) => path.endsWith('/prepare'))).toBe(false);
  fireEvent.click(within(changed).getByRole('button', { name: 'Use current revision for review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review edit' }));
  const review = await screen.findByRole('region', { name: 'Review schedule change' });
  expect(within(review).getByText(/Job: job-1 · Revision: r2/)).toBeInTheDocument();
  expect(within(review).getByText('Retain my edited prompt')).toBeInTheDocument(); expect(submissions).toHaveLength(0);
});

it('shows stale and capped reconciliation facts without inventing absence or continuation', async () => {
  snapshot = { ...snapshot, source: { state: 'stale', observedAt: 1234 }, scanned: 200, truncated: true, operations: [{ operationId, agentId: agent.id, action: 'create', state: 'unknown', recovery: { scanned: 2000, truncated: true } }] };
  await open(); expect(screen.getByRole('button', { name: 'New schedule' })).toBeDisabled();
  expect(screen.getByText(/Last known schedules/)).toBeInTheDocument();
  expect(screen.getByText(/No matching schedules in the scanned portion/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reconcile' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Continue reconciliation' })).toBeNull();
});

it('separates reconciliation continuation from schedule and recovery-record cursors', async () => {
  snapshot.operations = [{ operationId, agentId: agent.id, action: 'create', state: 'unknown', recovery: { scanned: 200, truncated: true, nextCursor: 'reconcile-200' } }];
  await open(); fireEvent.click(screen.getByRole('button', { name: 'Continue reconciliation' }));
  await screen.findByText(/Native state observed/);
  const call = access.request.mock.calls.find(([path]) => path.endsWith('/reconcile'))!;
  expect(JSON.parse(String(call[1].body))).toEqual({ cursor: 'reconcile-200' }); expect(submissions).toHaveLength(0);
});

it('writer-only storage failure does not claim that readable recovery metadata was lost', async () => {
  await open(); fill(); fireEvent.click(screen.getByRole('button', { name: 'Review disabled creation' }));
  await screen.findByRole('region', { name: 'Review schedule change' });
  const original = access.request.getMockImplementation()!;
  access.request.mockImplementation((path, init) => path.endsWith('/submit') ? Promise.reject(new ControlApiError('schedule-storage-unavailable')) : original(path, init));
  fireEvent.click(screen.getByRole('button', { name: 'Create disabled schedule' }));
  expect(await screen.findByText(/Creation storage is unavailable/)).toBeInTheDocument();
  expect(screen.queryByText(/Recovery metadata could not be read/)).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(draft.message);
});

it('Escape closes the drawer without preparing or submitting an incomplete schedule', async () => {
  const close = vi.fn(); render(<AgentDetailPanel agent={agent} onClose={close} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Schedules' }));
  const create = await screen.findByRole('button', { name: 'New schedule' }); await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create); fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Incomplete local prompt' } });
  fireEvent.keyDown(document, { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
  expect(access.request.mock.calls.some(([path]) => /\/(prepare|submit|reconcile)$/.test(path))).toBe(false);
});
