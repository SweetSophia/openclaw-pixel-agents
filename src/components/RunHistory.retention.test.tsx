import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { HistoricalConversation, RunHistoryPicker } from './RunHistory';
import type { ControlRunHistorySnapshot } from '../../shared/controlRunHistory';
afterEach(cleanup);
it('labels retained original-time text separately from the new 200-record discovery window', () => {
  const target = { agentId: 'a', sessionId: 's', sessionKey: 'agent:a:x' };
  const fresh: ControlRunHistorySnapshot = { target, source: { state: 'current', observedAt: 61000 }, runs: [], runsTruncated: false, loadedRecords: 200,
    limitReached: false, nextCursor: 'fresh-cursor', selectedRunId: 'older', messages: [], messagesTruncated: false };
  const retained: ControlRunHistorySnapshot = { ...fresh, source: { state: 'current', observedAt: 100 }, loadedRecords: 262, runs: [{ runId: 'older' }], nextCursor: undefined,
    task: { target, source: { state: 'current', observedAt: 100 }, hasActiveRun: null, runId: 'older', runState: 'unknown', requestAssociation: 'unknown', requestState: 'unavailable', activity: [], children: [], childrenComplete: false, loadedRecords: 262 },
    messages: [{ id: 'old-answer', role: 'assistant', text: 'Previously loaded response', truncated: false, runId: 'older' }] };
  render(<><RunHistoryPicker snapshot={fresh} lastKnown={retained} runId="older" loading={false} error={null} onSelect={() => {}} onRefresh={() => {}} onEarlier={() => {}} /><HistoricalConversation snapshot={retained} /></>);
  expect(screen.getByText(/200 records loaded/)).toBeInTheDocument();
  expect(screen.getByText(/262 records in that snapshot/)).toHaveTextContent(/not been reverified in the current window/);
  expect(screen.getByText(/Results and files are unavailable/)).toBeInTheDocument();
  expect(screen.getByText('Previously loaded response')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Load earlier runs' })).toBeInTheDocument();
});
