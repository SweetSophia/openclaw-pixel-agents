import React from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentWorkspace } from './AgentWorkspace';

const access = vi.hoisted(() => ({ request: vi.fn(), requestFile: vi.fn(), lock: vi.fn(), unlock: vi.fn(), state: 'unlocked', generation: 1,
  status: { configured: true, state: 'ready', canRead: true, canSend: false } }));
vi.mock('../control/ControlAccess', () => ({ useControlAccess: () => access }));
const report = { path: '日本語.txt', name: '日本語.txt', kind: 'file', size: 0, updatedAtMs: 100 };
const page = { agentId: 'cylena', path: '', offset: 0, totalEntries: 4, entries: [{ path: 'notes', name: 'notes', kind: 'directory' }, report,
  { path: 'big.png', name: 'big.png', kind: 'file', size: 2000000, updatedAtMs: 100 }, { path: 'unknown.txt', name: 'unknown.txt', kind: 'file' }],
  source: { state: 'current', observedAt: 100 }, sourceRevision: 'source-1' };
beforeEach(() => {
  access.state = 'unlocked'; access.request.mockReset().mockImplementation(async (path, init) => String(path).endsWith('/status') ? access.status
    : JSON.parse(init.body).path ? { ...page, path: 'notes', totalEntries: 0, entries: [] } : page);
  access.requestFile.mockReset().mockResolvedValue({ kind: 'bytes', blob: new NodeBlob([''], { type: 'text/plain' }), filename: '日本語.txt', truncated: false });
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('browses empty folders without conversations and explains unavailable file sizes', async () => {
  render(<AgentWorkspace agentId="cylena" active />);
  await screen.findByRole('button', { name: 'Open folder notes' }); expect(screen.queryByLabelText('Conversation')).toBeNull();
  expect(screen.getByText(/^0 B/)).toBeVisible(); expect(screen.getByText(/size unknown/i)).toBeVisible(); expect(screen.getByText(/too large/i)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Open folder notes' })); await screen.findByText(/this folder is empty/i);
  fireEvent.click(screen.getByRole('button', { name: 'Workspace root' })); await screen.findByRole('button', { name: 'Open folder notes' });
});
it('previews empty files and text literally without loading contents automatically', async () => {
  render(<AgentWorkspace agentId="cylena" active />); const preview = await screen.findByRole('button', { name: 'Preview 日本語.txt' });
  expect(access.requestFile).not.toHaveBeenCalled(); fireEvent.click(preview); await screen.findByText(/this file is empty/i);
  access.requestFile.mockResolvedValueOnce({ kind: 'bytes', blob: new NodeBlob(['<script>literal</script>'], { type: 'text/plain' }), filename: '日本語.txt', truncated: false });
  const close = screen.getByRole('button', { name: 'Close preview' });
  expect(document.activeElement).toBe(document.body); fireEvent.click(close);
  expect(document.activeElement).toBe(preview); fireEvent.click(preview);
  await screen.findByText('<script>literal</script>'); expect(document.querySelector('script')).toBeNull();
  expect(screen.getByRole('status', { name: 'Preview status' })).toHaveTextContent('Preview ready: 日本語.txt');
});
it('uses the existing unlock gate and performs no workspace RPCs while locked', async () => {
  access.state = 'locked'; render(<AgentWorkspace agentId="cylena" active />);
  await screen.findByRole('heading', { name: 'Unlock task details' });
  await waitFor(() => expect(access.request.mock.calls.every(([path]) => String(path).endsWith('/status'))).toBe(true));
  expect(screen.queryByLabelText('Conversation')).toBeNull(); expect(access.requestFile).not.toHaveBeenCalled();
});
it.each([false, true])('restores focused previews after automatic invalidation (removed=%s)', async removed => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<AgentWorkspace agentId="cylena" active />);
  const trigger = await screen.findByRole('button', { name: 'Preview 日本語.txt' }); fireEvent.click(trigger);
  const close = await screen.findByRole('button', { name: 'Close preview' }); close.focus();
  access.request.mockImplementation(async path => String(path).endsWith('/status') ? access.status : { ...page,
    entries: removed ? page.entries.filter(entry => entry.path !== report.path) : page.entries.map(entry => entry.path === report.path ? { ...entry, updatedAtMs: 101 } : entry),
    totalEntries: removed ? 3 : 4 });
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(screen.queryByRole('button', { name: 'Close preview' })).toBeNull();
  expect(document.activeElement).toBe(removed ? screen.getByRole('button', { name: 'Workspace root' }) : trigger);
});
it('accepts manual Refresh during a pending poll and ignores its late failure', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true }); render(<AgentWorkspace agentId="cylena" active />);
  fireEvent.click(await screen.findByRole('button', { name: 'Preview 日本語.txt' }));
  await screen.findByRole('button', { name: 'Close preview' });
  const changed = { ...page, entries: page.entries.map(entry => entry.path === report.path ? { ...entry, updatedAtMs: 101 } : entry) };
  access.request.mockImplementation(async path => String(path).endsWith('/status') ? access.status : changed);
  await act(() => vi.advanceTimersByTimeAsync(5000)); expect(screen.getByRole('alert')).toHaveTextContent(/workspace selection changed/i);
  let rejectPoll!: (error: Error) => void; let signal!: AbortSignal; let first = true;
  access.request.mockImplementation(async (path, init) => {
    if (String(path).endsWith('/status')) return access.status;
    if (first) { first = false; signal = init.signal; return new Promise((_resolve, reject) => { rejectPoll = reject; }); }
    return changed;
  });
  await act(() => vi.advanceTimersByTimeAsync(5000));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
  expect(signal.aborted).toBe(true); expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => { rejectPoll(Error('superseded poll')); });
  expect(screen.queryByRole('alert')).toBeNull();
});
it('shows overlong child paths without offering an unusable read', async () => {
  const parent = Array(8).fill('a'.repeat(254)).join('/');
  // Navigate via a valid chain of native single-directory pages.
  const parts = parent.split('/'); let depth = 0;
  access.request.mockImplementation(async (path) => {
    if (String(path).endsWith('/status')) return access.status;
    const directory = parts.slice(0, depth).join('/');
    return { ...page, path: directory, totalEntries: 1, entries: depth < parts.length
      ? [{ path: parts.slice(0, depth + 1).join('/'), name: parts[depth], kind: 'directory' }]
      : [{ ...report, path: `${parent}/child.txt`, name: 'child.txt' }] };
  });
  render(<AgentWorkspace agentId="cylena" active />);
  for (; depth < parts.length;) {
    const button = await screen.findByRole('button', { name: `Open folder ${parts[depth]}` }); depth++; fireEvent.click(button);
  }
  await screen.findByText(/exceeds the 2,048-character/);
  const button = screen.getByRole('button', { name: 'Preview child.txt' });
  expect(button).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(button); expect(access.requestFile).not.toHaveBeenCalled();
});
