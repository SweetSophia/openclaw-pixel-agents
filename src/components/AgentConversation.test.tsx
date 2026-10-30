import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentConversation } from './AgentConversation';
const f = vi.hoisted(() => ({ send: vi.fn(), setDraft: vi.fn(), setIntent: vi.fn(), intent: 'followup', draft: 'hello', disabledReason: '', retryDisabledReason: '', ready: true, pending: false, isNew: false, retryPending: vi.fn(), newConversation: vi.fn(), submission: null as null | { phase: string } }));
vi.mock('../control/useConversation', () => ({ useConversation: () => ({ ...f, messages: [{ id: 'a1', role: 'assistant', text: '<script>literal</script>', truncated: false }], loading: false, error: null }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); f.disabledReason = ''; f.submission = null; f.intent = 'followup'; f.isNew = false; });
describe('conversation composer', () => {
  it('shows explanation instead of model controls in the reactive new-draft mode', () => {
    f.isNew = true; render(<AgentConversation target={{ agentId: 'cylena', sessionKey: 'agent:cylena:main', sessionId: 'session-1' }} agentId="cylena" active />);
    expect(screen.getByText(/Model selection is available for the live conversation only/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Model preference' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('hello');
  });
  it('suppresses model controls immediately when the existing live parent reports known busy activity', () => {
    render(<AgentConversation target={{ agentId: 'cylena', sessionKey: 'agent:cylena:main', sessionId: 'session-1' }} agentId="cylena" active busy />);
    expect(screen.getByText(/Model changes are disabled while this conversation has active work/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh models' })).toBeNull();
  });
  it('makes steering explicit and explains admission-time targeting without promising the observed run', () => {
    const view = render(<AgentConversation target={null} agentId="cylena" active busy />);
    expect(screen.getByRole('combobox', { name: 'Message delivery' })).toHaveValue('followup');
    expect(screen.getByRole('button', { name: 'Send follow-up' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Message delivery' }), { target: { value: 'steer' } }); expect(f.setIntent).toHaveBeenCalledWith('steer');
    f.intent = 'steer'; view.rerender(<AgentConversation target={null} agentId="cylena" active busy />);
    expect(screen.getByText(/at admission/)).toHaveTextContent(/new turn.*idle/);
    fireEvent.click(screen.getByRole('button', { name: 'Steer conversation' })); expect(f.send).toHaveBeenCalledOnce();
  });
  it('allows original retry in a newly created empty conversation while fresh sends stay blocked', () => {
    f.disabledReason = 'Start a new conversation to send from an empty or unsupported transcript.'; f.submission = { phase: 'unknown' };
    render(<AgentConversation target={null} agentId="cylena" active />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry original submission' })); expect(f.retryPending).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
  it('uses Enter for newline and only sends on explicit button or Ctrl/Cmd+Enter', () => {
    render(<AgentConversation target={null} agentId="cylena" active />);
    const box = screen.getByRole('textbox', { name: 'Message' }); fireEvent.keyDown(box, { key: 'Enter' }); expect(f.send).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true }); fireEvent.keyDown(box, { key: 'Enter', metaKey: true }); fireEvent.click(screen.getByRole('button', { name: 'Send' })); expect(f.send).toHaveBeenCalledTimes(3);
    expect(screen.getByText('<script>literal</script>')).toBeInTheDocument(); expect(document.querySelector('script')).toBeNull(); expect(box).toHaveAttribute('maxLength', '8000');
  });
  it('explains disabled sending without losing the visible recovery draft', () => {
    f.disabledReason = 'Sending requires a write grant.'; render(<AgentConversation target={null} agentId="cylena" active />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('hello'); expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(screen.getByRole('button', { name: 'Send' })); expect(f.send).not.toHaveBeenCalled(); expect(screen.getByText(f.disabledReason)).toBeInTheDocument();
  });
});
