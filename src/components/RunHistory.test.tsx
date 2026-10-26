import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RunHistoryPicker, HistoricalConversation } from './RunHistory';
afterEach(cleanup);
it('keeps a selected run visible after a refreshed window no longer contains it and offers explicit live return', () => {
  const select = vi.fn(); const earlier = vi.fn();
  render(<RunHistoryPicker snapshot={{ target: { agentId: 'a', sessionId: 's', sessionKey: 'agent:a:x' }, source: { state: 'current', observedAt: 100 }, runs: [], runsTruncated: false, loadedRecords: 200, limitReached: false, nextCursor: 'cursor', messages: [], messagesTruncated: false, selectedRunId: 'older' }} runId="older" loading={false} error={null} onSelect={select} onRefresh={() => {}} onEarlier={earlier} />);
  expect(screen.getByRole('combobox', { name: 'Task / run' })).toHaveValue('older'); expect(screen.getByText(/No facts for this run/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier runs' })); expect(earlier).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } }); expect(select).toHaveBeenCalledWith(undefined);
});
it('historical conversation has no send controls and renders display text as text', () => {
  render(<HistoricalConversation snapshot={{ target: { agentId: 'a', sessionId: 's', sessionKey: 'agent:a:x' }, source: { state: 'current', observedAt: 100 }, runs: [{ runId: 'older' }], runsTruncated: false, loadedRecords: 1, limitReached: false, selectedRunId: 'older', messages: [{ id: 'message', role: 'assistant', text: '<script>fixture</script>', runId: 'older', truncated: false }], messagesTruncated: false }} />);
  expect(screen.getByText('<script>fixture</script>')).toBeInTheDocument(); expect(document.querySelector('script')).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByRole('button', { name: /send/i })).toBeNull();
});
