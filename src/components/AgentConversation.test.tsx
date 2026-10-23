import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentConversation } from './AgentConversation';
const f = vi.hoisted(() => ({ send: vi.fn(), setDraft: vi.fn(), draft: 'hello', disabledReason: '', ready: true, pending: false, retryPending: vi.fn(), newConversation: vi.fn() }));
vi.mock('../control/useConversation', () => ({ useConversation: () => ({ ...f, messages: [{ id: 'a1', role: 'assistant', text: '<script>literal</script>', truncated: false }], loading: false, error: null, submission: null }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); f.disabledReason = ''; });
describe('conversation composer', () => {
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
