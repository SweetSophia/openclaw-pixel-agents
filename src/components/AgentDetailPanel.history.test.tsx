import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentDetailPanel } from './AgentDetailPanel';
import { parseControlTarget } from '../../shared/control';
import type { AgentState } from '../../shared/types';
const f = vi.hoisted(() => ({ request: vi.fn(), state: 'unlocked', generation: 1, sourceState: 'ready' }));
vi.mock('../control/ControlAccess', () => ({ useConversationDrafts: () => undefined, useControlAccess: () => ({ ...f, status: { configured: true, state: f.sourceState, canRead: f.sourceState === 'ready', canSend: f.sourceState === 'ready' }, refreshStatus: vi.fn(), lock: vi.fn() }) }));
// Keep the actual panel/hook/API selection path while observing the composer mount boundary.
vi.mock('./AgentConversation', () => ({ AgentConversation: ({ active }: { active: boolean }) => { const [draft, setDraft] = useState(''); return <textarea aria-label="Fixture draft" data-active={active} value={draft} onChange={event => setDraft(event.target.value)} />; } }));
const agent: AgentState = { id: 'cylena', name: 'Cylena', activity: 'idle', model: 'fixture', sessionKey: 'agent:cylena:test', pixelEnabled: true, active: true, tags: [], lastActivity: 0 };
const selected = { agentId: 'cylena', sessionKey: agent.sessionKey, sessionId: 'session-1', name: 'Fixture conversation', isChild: false, hasActiveRun: false };
afterEach(() => { cleanup(); f.request.mockReset(); f.sourceState = 'ready'; });
it('keeps one recorded run across tabs, never labels conversation Usage as that run, and preserves the inactive composer draft', async () => {
  f.state = 'unlocked'; f.generation = 1;
  f.request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/sessions')) return { sessions: [selected], source: { state: 'current', observedAt: 100 } };
    const input = JSON.parse(String(init?.body)); const target = parseControlTarget(input); const runId = input.runId ?? 'current-run';
    const task = { target, source: { state: 'current', observedAt: 100 }, hasActiveRun: null, runId, runState: 'unknown', request: { id: `request-${runId}`, role: 'user', text: `Request ${runId}`, truncated: false, runId }, requestAssociation: 'run', requestState: 'found', activity: [], children: [], childrenComplete: false, loadedRecords: 4 };
    if (path.endsWith('/runs')) return { target, source: task.source, runs: [{ runId: 'older-run' }, { runId: 'current-run' }], runsTruncated: false, limitReached: false, loadedRecords: 4, messagesTruncated: false,
      ...(input.runId ? { selectedRunId: input.runId, task } : {}), messages: input.runId ? [{ id: 'old-response', role: 'assistant', runId, text: `Response ${runId}`, truncated: false }] : [] };
    if (path.endsWith('/results')) return { target, source: task.source, sourceRevision: 'fixture-revision', scope: { kind: 'run', runId }, runState: 'unknown', responseKind: 'latest', response: { id: 'response', role: 'assistant', text: `Results ${runId}`, runId, truncated: false }, artifactState: 'ready', artifacts: [], artifactsTruncated: false };
    return task;
  });
  render(<AgentDetailPanel agent={agent} onClose={() => {}} />);
  await screen.findByRole('option', { name: /older-run/ });
  fireEvent.click(screen.getByRole('tab', { name: 'Conversation' })); fireEvent.change(screen.getByRole('textbox', { name: 'Fixture draft' }), { target: { value: 'Keep this unsent draft' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Task / run' }), { target: { value: 'older-run' } });
  await screen.findByText('Response older-run'); expect(screen.queryByRole('textbox', { name: 'Fixture draft' })).toBeNull();
  f.request.mockClear(); fireEvent.click(screen.getByRole('tab', { name: 'Usage' }));
  await screen.findByText(/Per-run usage is unavailable/); expect(f.request.mock.calls.some(([path]) => String(path).endsWith('/usage'))).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: 'Results' })); await screen.findByText('Results older-run');
  expect(JSON.parse(String(f.request.mock.calls.find(([path]) => String(path).endsWith('/results'))?.[1].body)).runId).toBe('older-run');
  fireEvent.click(screen.getByRole('tab', { name: 'Task' })); await screen.findByText('Request older-run'); expect(screen.queryByText('Request current-run')).toBeNull();
  fireEvent.change(screen.getByRole('combobox', { name: 'Task / run' }), { target: { value: '' } }); fireEvent.click(screen.getByRole('tab', { name: 'Conversation' }));
  expect(screen.getByRole('textbox', { name: 'Fixture draft' })).toHaveValue('Keep this unsent draft'); expect(screen.getByRole('textbox', { name: 'Fixture draft' })).toHaveAttribute('data-active', 'true');
});
it('returns to the live selection when private reads become unavailable', async () => {
  f.state = 'unlocked'; f.generation = 1; f.sourceState = 'ready';
  f.request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/sessions')) return { sessions: [selected], source: { state: 'current', observedAt: 100 } };
    const input = JSON.parse(String(init?.body)); const target = parseControlTarget(input); const runId = input.runId ?? 'current-run';
    const task = { target, source: { state: 'current', observedAt: 100 }, hasActiveRun: null, runId, runState: 'unknown', request: { id: `request-${runId}`, role: 'user', text: `Request ${runId}`, truncated: false, runId }, requestAssociation: 'run', requestState: 'found', activity: [], children: [], childrenComplete: false, loadedRecords: 4 };
    if (path.endsWith('/runs')) return { target, source: task.source, runs: [{ runId: 'older-run' }], runsTruncated: false, limitReached: false, loadedRecords: 4, messagesTruncated: false,
      ...(input.runId ? { selectedRunId: input.runId, task } : {}), messages: [] };
    return task;
  });
  const rendered = render(<AgentDetailPanel agent={agent} onClose={() => {}} />); await screen.findByRole('option', { name: /older-run/ });
  fireEvent.change(screen.getByRole('combobox', { name: 'Task / run' }), { target: { value: 'older-run' } }); await screen.findByText('Request older-run');
  f.sourceState = 'unavailable'; rendered.rerender(<AgentDetailPanel agent={agent} onClose={() => {}} />); await waitFor(() => expect(screen.getByRole('combobox', { name: 'Task / run' })).toHaveValue(''));
  f.request.mockClear(); f.sourceState = 'ready'; rendered.rerender(<AgentDetailPanel agent={agent} onClose={() => {}} />);
  await waitFor(() => expect(f.request.mock.calls.some(([path]) => String(path).endsWith('/task'))).toBe(true));
  expect(screen.getByRole('combobox', { name: 'Task / run' })).toHaveValue('');
});
