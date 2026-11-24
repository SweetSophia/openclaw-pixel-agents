import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentForm } from '../control/useImageAttachments';
import { ConversationAttachment } from './ConversationAttachment';

const target = { agentId: 'main', sessionKey: 'agent:main:one', sessionId: 'one', activeLeafEntryId: 'leaf-1' };
function form(changes: Partial<AttachmentForm> = {}): AttachmentForm {
  return { status: { enabled: true, canPrepare: true, reason: null, epoch: 'epoch', maxBytes: 1024 }, selection: null, review: null, receipt: null, originalTarget: null,
    phase: 'idle', pending: false, disabledReason: '', error: '', select: vi.fn(), prepare: vi.fn(), confirm: vi.fn(), check: vi.fn(), remove: vi.fn(), ...changes };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('attachment metadata controls', () => {
  it.each(['disabled', 'permission', 'unsupported', 'unavailable'] as const)('explains %s without exposing a usable file picker', reason => {
    render(<ConversationAttachment target={target} form={form({ status: { enabled: reason !== 'disabled', canPrepare: false, reason, epoch: null, maxBytes: null }, disabledReason: 'Image sending is unavailable for this connection.' })} />);
    expect(screen.queryByLabelText('Attach image')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent({ disabled: /not enabled/, permission: /permission/, unsupported: /not support/, unavailable: /unavailable/ }[reason]);
  });
  it('shows the current target and negotiated limit before any selection', () => {
    render(<ConversationAttachment target={target} form={form()} />);
    expect(screen.getByText('agent:main:one')).toBeInTheDocument();
    expect(screen.getByText(/1,024 bytes/)).toHaveTextContent(/PNG.*JPEG/);
    expect(screen.getByLabelText('Attach image')).toHaveAttribute('accept', 'image/png,image/jpeg');
    expect(screen.queryByRole('img')).toBeNull();
  });
  it('updates one persistent live region with phase, evidence, and a typed error', () => {
    const view = render(<ConversationAttachment target={target} form={form()} />);
    const live = screen.getByRole('status');
    view.rerender(<ConversationAttachment target={target} form={form({ phase: 'preparing' })} />);
    expect(screen.getByRole('status')).toBe(live);
    expect(live).toHaveTextContent(/Uploading to the private office server/);
    view.rerender(<ConversationAttachment target={target} form={form({ phase: 'unknown', pending: true,
      receipt: { operationId: 'op-1', target, phase: 'unknown', nativeInvoked: true, imageEvidence: 'unverified', runId: 'op-1' },
      disabledReason: 'Check the original image submission.', error: 'The original image receipt expired.' })} />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toBe(live);
    expect(live).toHaveTextContent(/Image outcome unknown/);
    expect(live).toHaveTextContent(/Attachment evidence is unverified/);
    expect(live).toHaveTextContent(/receipt expired/);
  });
  it.each(['   ', '/stop'])('blocks a selected-image review with invalid ordinary text: %j', message => {
    const state = form({ selection: { filename: 'photo.png', mimeType: 'image/png', bytes: 33, width: 1, height: 1 }, disabledReason: `Invalid text: ${message}` });
    render(<ConversationAttachment target={target} form={state} />);
    expect(screen.getByRole('button', { name: 'Review image message' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Review image message' }));
    expect(state.prepare).not.toHaveBeenCalled();
    expect(screen.getByText(/office server/)).toHaveTextContent(/not.*OpenClaw/);
  });
  it('does not offer another image or confirmation while an operation is admitted', () => {
    const state = form({ phase: 'unknown', pending: true, disabledReason: 'Check the original image submission.' });
    render(<ConversationAttachment target={target} form={state} />);
    expect(screen.queryByLabelText('Attach image')).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry|Resend|Send image/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check original submission' })); expect(state.check).toHaveBeenCalledOnce();
  });
  it('returns focus to the heading when terminal recovery has no surviving picker', () => {
    const view = render(<ConversationAttachment target={target} form={form({ phase: 'unknown', pending: true })} />);
    screen.getByRole('button', { name: 'Check original submission' }).focus();
    view.rerender(<ConversationAttachment target={target} form={form({ phase: 'recorded', status: null })} />);
    expect(screen.getByRole('heading', { name: 'Image follow-up' })).toHaveFocus();
  });
  it('does not steal focus from outside the attachment controls on terminal recovery', () => {
    const tree = (phase: AttachmentForm['phase']) => <><button>Other drawer control</button><ConversationAttachment target={target} form={form({ phase, pending: phase === 'unknown' })} /></>;
    const view = render(tree('unknown'));
    screen.getByRole('button', { name: 'Check original submission' }).focus();
    const elsewhere = screen.getByRole('button', { name: 'Other drawer control' }); elsewhere.focus();
    view.rerender(tree('recorded')); expect(elsewhere).toHaveFocus();
  });
  it('does not restore recovery focus while the page is hidden', () => {
    const view = render(<ConversationAttachment target={target} form={form({ phase: 'unknown', pending: true })} />);
    screen.getByRole('button', { name: 'Check original submission' }).focus();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    view.rerender(<ConversationAttachment target={target} form={form({ phase: 'recorded' })} />);
    expect(screen.getByLabelText('Attach image')).not.toHaveFocus();
    expect(screen.getByRole('heading', { name: 'Image follow-up' })).not.toHaveFocus();
  });
  it('does not restore focus when the attachment form unmounts', () => {
    const view = render(<ConversationAttachment target={target} form={form({ phase: 'unknown', pending: true })} />);
    screen.getByRole('button', { name: 'Check original submission' }).focus();
    view.unmount(); expect(document.body).toHaveFocus();
  });
});
