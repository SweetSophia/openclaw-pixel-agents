import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ConversationUsage } from './ConversationUsage';
import type { ControlUsageSnapshot } from '../../shared/controlUsage';
afterEach(cleanup);
const snapshot: ControlUsageSnapshot = { target: { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 'fixture-1' },
  source: { state: 'current', observedAt: 2000 }, state: 'ready', tokens: { input: 0, output: 1000 }, cost: { usd: 0, missingEntries: 0 }, model: '<b>literal-model</b>', contextLimit: 128000, computedAt: 1000 };
it('shows reported zero separately from missing metrics without a fabricated context percentage', () => {
  render(<ConversationUsage snapshot={snapshot} loading={false} selected />);
  expect(screen.getByText('0')).toBeVisible(); expect(screen.getByText('1,000')).toBeVisible(); expect(screen.getByText('0.00 USD')).toBeVisible();
  expect(screen.getByText('<b>literal-model</b>')).toBeVisible(); expect(document.querySelector('b')).toBeNull();
  expect(screen.getByText('Not reported by this Gateway')).toBeVisible(); expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getAllByText('Not reported').length).toBeGreaterThan(0);
});
it('labels stale/partial pricing and does not portray an all-missing-price zero as a free session', () => {
  render(<ConversationUsage snapshot={{ ...snapshot, source: { state: 'stale', observedAt: 2000 }, state: 'partial', cost: { usd: 0, missingEntries: 3 } }} loading={false} selected />);
  expect(screen.getByText(/Last known/)).toBeVisible(); expect(screen.getByText(/3 recorded entries/)).toBeVisible(); expect(screen.queryByText('0.00 USD')).toBeNull();
  expect(screen.getByText(/not a provider invoice/)).toBeVisible();
});
it.each(['unsupported', 'loading', 'unavailable'] as const)('explains %s without showing invented counters', state => {
  render(<ConversationUsage snapshot={{ ...snapshot, state, tokens: {}, cost: {} }} loading={false} selected />);
  expect(screen.getByRole('status')).toBeVisible(); expect(screen.queryByText('0')).toBeNull();
});
it('distinguishes a failed selected-conversation read from needing to select a conversation', () => {
  const { rerender } = render(<ConversationUsage snapshot={null} loading={false} selected />);
  expect(screen.getByRole('status')).toHaveTextContent('Usage is not available for this conversation yet. Refresh to check again.');
  rerender(<ConversationUsage snapshot={null} loading={true} selected={false} />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading conversation usage');
  rerender(<ConversationUsage snapshot={null} loading={false} selected={false} />);
  expect(screen.getByRole('status')).toHaveTextContent('Choose a conversation');
});
