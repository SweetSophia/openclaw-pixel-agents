import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentDocuments } from './AgentDocuments';
import { AgentDetailPanel } from './AgentDetailPanel';
import { AgentWorkspace } from './AgentWorkspace';
import type { AgentState } from '../../shared/types';
import { ControlApiError } from '../control/api';

const access = vi.hoisted(() => ({ request: vi.fn(), requestFile: vi.fn(), lock: vi.fn(), unlock: vi.fn(), state: 'unlocked', generation: 1,
  status: { configured: true, state: 'ready', canRead: true, canSend: false } }));
vi.mock('../control/ControlAccess', () => ({ useControlAccess: () => access, useConversationDrafts: () => undefined }));
const management = { configured: true, state: 'ready', canEdit: true, epoch: 'epoch-1', reason: null };
const agent: AgentState = { id: 'cylena', name: 'Cylena', activity: 'idle', model: 'fixture', sessionKey: 'agent:cylena:test', pixelEnabled: true, active: true, tags: [], lastActivity: 0 };
beforeEach(() => {
  access.state = 'unlocked'; access.generation = 1; access.status.canRead = true;
  access.request.mockReset().mockImplementation(async (path, init) => {
    if (path.includes('/documents/status')) return management;
    if (path.includes('/documents/read')) return { agentId: 'cylena', name: JSON.parse(init.body).name, revision: 'revision-1', content: '', bytes: 0, source: { state: 'current', observedAt: 100 } };
    if (path.endsWith('/status')) return access.status;
    if (path.endsWith('/workspace')) return { agentId: 'cylena', path: '', offset: 0, entries: [{ path: 'notes', name: 'notes', kind: 'directory' }], totalEntries: 1, sourceRevision: 'source-1', source: { state: 'current', observedAt: 100 } };
    throw Error('unused private fixture');
  });
  vi.spyOn(window, 'confirm').mockReturnValue(false);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function edit() {
  fireEvent.click(screen.getByRole('button', { name: 'Agent documents' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit AGENTS.md' }));
  const textarea = await screen.findByRole('textbox', { name: /AGENTS.md text for cylena/ });
  fireEvent.change(textarea, { target: { value: 'é draft' } }); return textarea;
}
it('keeps Workspace browsing read-only until the separate editor is explicitly opened', async () => {
  render(<AgentWorkspace agentId="cylena" active />);
  await screen.findByRole('button', { name: 'Open folder notes' });
  expect(access.request.mock.calls.some(([path]) => path.includes('/documents/'))).toBe(false);
  expect(screen.queryByRole('textbox')).toBeNull(); await edit();
  expect(screen.getByText(/8 \/ 32768 bytes/)).toBeVisible(); expect(screen.getByRole('button', { name: 'Save document' })).toBeEnabled();
});
it('guards dirty document changes, reload, and section close and warns before unload', async () => {
  render(<AgentDocuments agentId="cylena" active />); const textarea = await edit();
  const count = access.request.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Edit SOUL.md' })); fireEvent.click(screen.getByRole('button', { name: 'Reload and review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Agent documents' }));
  expect(textarea).toHaveValue('é draft'); expect(window.confirm).toHaveBeenCalledTimes(3); expect(access.request).toHaveBeenCalledTimes(count);
  const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
  vi.mocked(window.confirm).mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: 'Reload and review' }));
  await waitFor(() => expect(textarea).toHaveValue('')); expect(screen.getByText(/This document is empty/)).toBeVisible();
});
it('does not store private drafts or leak ordinary editing keys out of its textarea', async () => {
  const store = vi.spyOn(Storage.prototype, 'setItem'); const outside = vi.fn();
  render(<div onKeyDown={outside}><AgentDocuments agentId="cylena" active /></div>); const textarea = await edit();
  fireEvent.keyDown(textarea, { key: 'r' }); fireEvent.keyUp(textarea, { key: 'Delete' });
  expect(outside).not.toHaveBeenCalled(); expect(store).not.toHaveBeenCalled();
  expect(access.requestFile).not.toHaveBeenCalled();
});
it.each(['disabled', 'pairing-required', 'permission', 'unsupported', 'connecting'])('shows honest %s guidance without editable text', async reason => {
  access.request.mockResolvedValue({ configured: reason !== 'disabled', state: reason === 'permission' ? 'auth-error' : reason, canEdit: false, epoch: null, reason: reason === 'connecting' ? 'unavailable' : reason });
  render(<AgentDocuments agentId="cylena" active />); fireEvent.click(screen.getByRole('button', { name: 'Agent documents' }));
  await screen.findByText(reason === 'permission' ? /administrator permission/i : reason === 'unsupported' ? /2026.11.2/i : reason === 'disabled' ? /disabled by the office operator/i : reason === 'pairing-required' ? /document device needs approval/i : /connecting document access/i);
  expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByRole('button', { name: 'Save document' })).toBeNull();
});
it('offers Return to live without starting management for a recorded-run context', async () => {
  const back = vi.fn(); render(<AgentWorkspace agentId="cylena" active historical onReturnToLive={back} />);
  await screen.findByRole('button', { name: 'Open folder notes' }); fireEvent.click(screen.getByRole('button', { name: 'Agent documents' }));
  fireEvent.click(screen.getByRole('button', { name: 'Return to live conversation' })); expect(back).toHaveBeenCalled();
  expect(access.request.mock.calls.some(([path]) => path.includes('/documents/'))).toBe(false); expect(screen.queryByRole('textbox')).toBeNull();
});
it.each(['close', 'overlay', 'Escape', 'tab', 'arrow'])('the real parent allows canceling dirty %s navigation and preserves focus', async method => {
  const close = vi.fn(); render(<AgentDetailPanel agent={agent} onClose={close} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Workspace' })); const textarea = await edit(); textarea.focus();
  if (method === 'close') fireEvent.click(screen.getByRole('button', { name: 'Close details for Cylena' }));
  if (method === 'overlay') fireEvent.click(document.querySelector('.detail-overlay')!);
  if (method === 'Escape') fireEvent.keyDown(textarea, { key: 'Escape' });
  if (method === 'tab') fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
  if (method === 'arrow') fireEvent.keyDown(screen.getByRole('tab', { name: 'Workspace' }), { key: 'ArrowRight' });
  expect(window.confirm).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('tab', { name: 'Workspace' })).toHaveAttribute('aria-selected', 'true'); expect(textarea).toHaveValue('é draft');
});
it('discards after accepted tab navigation without remounting ordinary Workspace browsing', async () => {
  render(<AgentDetailPanel agent={agent} onClose={() => {}} />); fireEvent.click(screen.getByRole('tab', { name: 'Workspace' })); await edit();
  vi.mocked(window.confirm).mockReturnValue(true); fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Workspace' })); expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('button', { name: 'Agent documents' })).toHaveAttribute('aria-expanded', 'false');
});
it('the real parent retains dirty consent without unknown-write guidance after a failed save preflight', async () => {
  const close = vi.fn(); render(<AgentDetailPanel agent={agent} onClose={close} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Workspace' })); const textarea = await edit();
  const originalRequest = access.request.getMockImplementation()!;
  access.request.mockImplementation((path, init) => path.endsWith('/documents/status') ? Promise.reject(new ControlApiError()) : originalRequest(path, init));
  fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save document' })).toBeDisabled());
  expect(screen.getByRole('alert')).not.toHaveTextContent(/unknown|replay this submission/i);
  expect(textarea).toHaveValue('é draft'); expect(screen.getByText(/8 \/ 32768 bytes · Unsaved changes/)).toBeVisible();
  expect(screen.getByText(/Reload and review the current document before another save/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Reload and review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close details for Cylena' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
  expect(window.confirm).toHaveBeenCalledTimes(3); expect(close).not.toHaveBeenCalled(); expect(textarea).toHaveValue('é draft');
  expect(screen.getByRole('tab', { name: 'Workspace' })).toHaveAttribute('aria-selected', 'true');
  const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
  access.request.mockImplementation(originalRequest); fireEvent.click(screen.getByRole('button', { name: 'Check document access' }));
  await waitFor(() => expect(screen.getByText(/Ready — select an existing document/)).toBeVisible());
  expect(screen.getByRole('button', { name: 'Save document' })).toBeDisabled();
  expect(access.request.mock.calls.filter(([path]) => path.endsWith('/documents/save'))).toHaveLength(0);
  vi.mocked(window.confirm).mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: 'Reload and review' }));
  await waitFor(() => expect(textarea).toHaveValue(''));
  expect(screen.queryByText(/Unsaved changes/)).toBeNull();
  expect(access.request.mock.calls.filter(([path]) => path.endsWith('/documents/save'))).toHaveLength(0);
});
it('the real parent protects an unsaved undo after a different submitted version is acknowledged', async () => {
  const close = vi.fn(); const originalRequest = access.request.getMockImplementation()!;
  let release!: (value: unknown) => void; let operationId!: string;
  access.request.mockImplementation((path, init) => {
    if (!path.endsWith('/documents/save')) return originalRequest(path, init);
    operationId = JSON.parse(init.body).operationId;
    return new Promise(resolve => { release = resolve; });
  });
  render(<AgentDetailPanel agent={agent} onClose={close} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Workspace' })); const textarea = await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Save document' })); await waitFor(() => expect(operationId).toBeTruthy());
  fireEvent.change(textarea, { target: { value: '' } });
  await act(async () => { release({ agentId: 'cylena', name: 'AGENTS.md', operationId, state: 'saved', snapshot: {
    agentId: 'cylena', name: 'AGENTS.md', revision: 'revision-2', content: 'é draft', bytes: 8, source: { state: 'current', observedAt: 200 } } }); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save document' })).toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Close details for Cylena' }));
  expect(window.confirm).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled(); expect(textarea).toHaveValue('');
  const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
  expect(screen.getByText(/0 \/ 32768 bytes · Unsaved changes/)).toBeVisible();
  expect(screen.getByText(/Submitted version saved.*current draft has unsaved changes/)).toBeVisible();
  expect(screen.queryByText('Document saved and verified by OpenClaw.')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Agent' })); expect(window.confirm).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('tab', { name: 'Workspace' })).toHaveAttribute('aria-selected', 'true');
  expect(access.request.mock.calls.filter(([path]) => path.endsWith('/documents/save'))).toHaveLength(1);
});
it('the real parent protects a baseline undo while a save is pending and after its outcome becomes unknown', async () => {
  const close = vi.fn(); const originalRequest = access.request.getMockImplementation()!;
  let release!: (value: unknown) => void; let operationId!: string;
  access.request.mockImplementation((path, init) => {
    if (!path.endsWith('/documents/save')) return originalRequest(path, init);
    operationId = JSON.parse(init.body).operationId;
    return new Promise(resolve => { release = resolve; });
  });
  render(<AgentDetailPanel agent={agent} onClose={close} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Workspace' })); const textarea = await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Save document' })); await waitFor(() => expect(operationId).toBeTruthy());
  fireEvent.change(textarea, { target: { value: '' } });
  for (const phase of ['pending', 'unknown']) {
    if (phase === 'unknown') await act(async () => { release({ agentId: 'cylena', name: 'AGENTS.md', operationId, state: 'unknown' }); });
    fireEvent.click(screen.getByRole('button', { name: 'Close details for Cylena' }));
    expect(window.confirm).toHaveBeenCalledTimes(phase === 'pending' ? 1 : 3); expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    expect(screen.getByRole('tab', { name: 'Workspace' })).toHaveAttribute('aria-selected', 'true'); expect(textarea).toHaveValue('');
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
  }
  expect(screen.getByText(/0 \/ 32768 bytes · Unsaved changes/)).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent(/unknown/i); expect(screen.getByRole('button', { name: 'Save document' })).toBeDisabled();
  expect(access.request.mock.calls.filter(([path]) => path.endsWith('/documents/save'))).toHaveLength(1);
});
