import React, { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationModel } from './ConversationModel';
const access = vi.hoisted(() => ({ request: vi.fn(), generation: 1, state: 'unlocked', canRead: true }));
vi.mock('../control/ControlAccess', () => ({ useControlAccess: () => ({ ...access, status: { canRead: access.canRead } }) }));
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:main', sessionId: 'session-1' };
let canChange = true; let reason: 'busy' | 'permission' | null = null;
const longId = 'provider/' + 'long-model-'.repeat(40);
const snapshot = () => ({ target, selectionId: 'observation-1', observedAt: Date.now(), currentModel: 'p/old', canChange, disabledReason: reason,
  choices: [{ id: longId, label: 'Long model', selectable: true, available: true }, { id: '__default__', label: 'Literal sentinel model', selectable: true, available: true }, { id: 'p/denied', label: 'Policy denied', selectable: false, available: true },
    { id: 'p/not-ready', label: 'Not ready', selectable: true, available: false }, { id: 'p/unknown', label: 'Unknown readiness', selectable: true, available: null }] });
beforeEach(() => { access.generation++; canChange = true; reason = null; access.request = vi.fn(async (path, init) => path.endsWith('/models') ? snapshot() : { target, outcome: 'confirmed', snapshot: { ...snapshot(), currentModel: JSON.parse(String(init.body)).model ?? 'p/default', selectionId: 'after' } }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function select() { const select = await screen.findByRole('combobox', { name: 'Model preference' }); await waitFor(() => expect(select).not.toBeDisabled()); const option = screen.getByRole('option', { name: /Long model/ }) as HTMLOptionElement; fireEvent.change(select, { target: { value: option.value } }); return select; }
it('separates observed model, manual policy and readiness, with explicit default reset and no write on pick', async () => {
  render(<ConversationModel target={target} active />); await select();
  expect(screen.getByText('p/old')).toBeInTheDocument(); expect(screen.getByRole('option', { name: /Use configured default for this conversation/ })).not.toBeDisabled();
  expect(screen.getByRole('option', { name: /Policy denied.*not permitted/i })).toBeDisabled();
  expect(screen.getByRole('option', { name: /Not ready.*not ready/i })).toBeDisabled(); expect(screen.getByRole('option', { name: /Unknown readiness.*unknown/i })).toBeDisabled();
  expect(access.request.mock.calls.filter(([path]) => path.endsWith('/model'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Apply model preference' })); const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(longId)).toBeInTheDocument(); expect(within(dialog).getByText('p/old')).toBeInTheDocument();
  expect(within(dialog).getByText("Work starting after the idle check may switch models or restart under the Gateway's native behavior. This is not a future-turn-only guarantee.")).toBeInTheDocument();
  expect(dialog).not.toHaveAttribute('aria-modal');
  expect(dialog).toHaveAccessibleDescription("Work starting after the idle check may switch models or restart under the Gateway's native behavior. This is not a future-turn-only guarantee.");
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm model preference' })); await screen.findByText(/Preference confirmed.*does not prove.*executed/i);
});
it('focuses Cancel first, traps forward/reverse Tab locally and Escape restores focus without closing parent', async () => {
  const close = vi.fn(); render(<div onKeyDown={event => { if (event.key === 'Escape') close(); }}><ConversationModel target={target} active /></div>); await select();
  const apply = screen.getByRole('button', { name: 'Apply model preference' }); apply.focus(); fireEvent.click(apply);
  const cancel = screen.getByRole('button', { name: 'Cancel' }); const confirm = screen.getByRole('button', { name: 'Confirm model preference' });
  expect(cancel).toHaveFocus(); fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true }); expect(confirm).toHaveFocus(); fireEvent.keyDown(confirm, { key: 'Tab' }); expect(cancel).toHaveFocus();
  fireEvent.keyDown(cancel, { key: 'Tab' }); expect(confirm).toHaveFocus(); fireEvent.keyDown(confirm, { key: 'Tab', shiftKey: true }); expect(cancel).toHaveFocus();
  fireEvent.keyDown(cancel, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(close).not.toHaveBeenCalled(); expect(apply).toHaveFocus();
});
it('keeps local controls disabled and confirmation immutable until Cancel or external invalidation', async () => {
  render(<ConversationModel target={target} active />); await select(); fireEvent.click(screen.getByRole('button', { name: 'Apply model preference' }));
  canChange = false; reason = 'busy'; fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
  expect(screen.getByRole('button', { name: 'Refresh models' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Apply model preference' })).toBeDisabled(); expect(screen.getByRole('combobox', { name: 'Model preference' })).toBeDisabled();
  expect(screen.getByRole('dialog')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  expect(access.request.mock.calls.filter(([path]) => path.endsWith('/models'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
  await screen.findByText(/This conversation has active work/); expect(screen.getByRole('button', { name: 'Apply model preference' })).toBeDisabled();
});
it('explains connection or conversation policy without falsely attributing connection authority to manual selection', async () => {
  canChange = false; reason = 'permission'; render(<ConversationModel target={target} active />);
  await screen.findByText('Model changes are not permitted by the current connection or conversation policy.');
  expect(screen.getByRole('combobox', { name: 'Model preference' })).toBeDisabled();
});
it('renders explanation only for history/new drafts and clears confirmation immediately on read-only change', async () => {
  const rendered = render(<ConversationModel target={target} active readOnly />);
  expect(screen.getByText(/live conversation only/i)).toBeInTheDocument(); expect(access.request).not.toHaveBeenCalled();
  rendered.rerender(<ConversationModel target={target} active />); await select(); fireEvent.click(screen.getByRole('button', { name: 'Apply model preference' }));
  rendered.rerender(<ConversationModel target={target} active readOnly />); expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('combobox')).toBeNull();
});
it('does not confuse a legal catalog ID with the configured-default control', async () => {
  render(<ConversationModel target={target} active />); await select();
  const option = screen.getByRole('option', { name: /Literal sentinel model/ }) as HTMLOptionElement;
  fireEvent.change(screen.getByRole('combobox', { name: 'Model preference' }), { target: { value: option.value } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply model preference' }));
  expect(within(screen.getByRole('dialog')).getByText('__default__')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm model preference' }));
  await waitFor(() => expect(access.request.mock.calls.some(([path, init]) => path.endsWith('/model') && JSON.parse(String(init.body)).model === '__default__')).toBe(true));
});
it('requires Refresh for expired facts and preserves the displayed original observation time on transient failure', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const rendered = render(<ConversationModel target={target} active />); await select();
  const originalTime = document.querySelector('time')!.getAttribute('datetime');
  now += 60001; rendered.rerender(<ConversationModel target={target} active />);
  expect(screen.getByText(/Last known.*Refresh required/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Apply model preference' })).toBeDisabled();
  access.request.mockRejectedValue(new Error('synthetic offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh models' })); await screen.findByRole('alert');
  expect(document.querySelector('time')).toHaveAttribute('datetime', originalTime); expect(screen.getByRole('combobox', { name: 'Model preference' })).toBeDisabled();
});
it('renders only at the expiry boundary, then closes confirmation and restores usable Refresh focus', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const commits = vi.fn(); render(<Profiler id="model-expiry" onRender={commits}><ConversationModel target={target} active /></Profiler>);
  await act(async () => {});
  fireEvent.change(screen.getByRole('combobox', { name: 'Model preference' }), { target: { value: 'default' } }); fireEvent.click(screen.getByRole('button', { name: 'Apply model preference' }));
  const rendered = commits.mock.calls.length; now = 59999; await act(() => vi.advanceTimersByTimeAsync(59999));
  expect(commits.mock.calls.length).toBe(rendered); expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  now = 60000; await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByRole('button', { name: 'Refresh models' })).toHaveFocus(); expect(screen.getByRole('button', { name: 'Apply model preference' })).toBeDisabled();
  expect(commits.mock.calls.length).toBeGreaterThan(rendered);
});
it('removes confirmation and fences retained native click handlers on a committed known-busy transition', async () => {
  const view = render(<ConversationModel target={target} active />); await select();
  fireEvent.click(screen.getByRole('button', { name: 'Apply model preference' }));
  const obsolete = screen.getByRole('button', { name: 'Confirm model preference' });
  view.rerender(<ConversationModel target={target} active busy />);
  expect(screen.queryByRole('dialog')).toBeNull(); fireEvent.click(obsolete);
  expect(access.request.mock.calls.filter(([path]) => path.endsWith('/model'))).toHaveLength(0);
  expect(screen.getByText(/Model changes are disabled while this conversation has active work/)).toBeInTheDocument();
});
