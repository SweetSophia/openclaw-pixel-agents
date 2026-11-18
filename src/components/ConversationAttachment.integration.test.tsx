import React, { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlAccessProvider, useControlAccess, type ControlAccess } from '../control/ControlAccess';
import type { AttachmentReceipt } from '../../shared/controlAttachments';
import { AgentConversation } from './AgentConversation';
import { useConversation } from '../control/useConversation';
import { useImageAttachments } from '../control/useImageAttachments';

// Only the external socket transport is replaced; private access and both composer hooks are real.
vi.mock('socket.io-client', () => ({ io: () => ({ on() {}, emit() {}, connect() {}, disconnect() {} }) }));
const target = { agentId: 'main', sessionKey: 'agent:main:one', sessionId: 'one', lifecycleRevision: 'life-1', branchId: 'branch-1', activeLeafEntryId: 'leaf-1' };
const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const warning = 'The image, including embedded metadata, will be sent to OpenClaw and may be processed by its model and tools. OpenClaw sharing and retention settings apply, including existing or later public session shares. The office does not make the image exclusive to this conversation. Sending cannot be undone by Lock or closing this panel.';
const json = (body: unknown) => new Response(JSON.stringify(body));
const capability = { enabled: true, canPrepare: true, reason: null, epoch: 'epoch-1', maxBytes: 4_194_304 };
let access: ControlAccess;
let requests: { path: string; body: any }[];
let confirmReply: () => Response | Promise<Response>;
let receiptReply: () => Response | Promise<Response>;
let textPhase: 'unknown' | 'persisted';
function receipt(phase: AttachmentReceipt['phase'] = 'unknown', imageEvidence: AttachmentReceipt['imageEvidence'] = 'unverified') {
  return json({ operationId: 'image-op-1', target, phase, nativeInvoked: !['prepared', 'not-dispatched'].includes(phase), imageEvidence,
    ...(phase === 'recorded' ? { runId: 'image-op-1', messageId: 'user-1', messageSeq: 1 } : {}) });
}
function Access() { access = useControlAccess(); return null; }
function Tree({ readOnly = false, show = true }: { readOnly?: boolean; show?: boolean }) {
  return <ControlAccessProvider><Access />{show && <AgentConversation target={target} agentId="main" active busy readOnly={readOnly} onCreated={() => {}} />}</ControlAccessProvider>;
}
async function setup() {
  const view = render(<Tree />); await act(() => access.unlock('synthetic-key'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send follow-up' })).toHaveAttribute('aria-disabled', 'true'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'original text\nsecond line' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send follow-up' })).toHaveAttribute('aria-disabled', 'false'));
  return view;
}
async function select(name = 'photo.png') {
  const file = new File([bytes], name, { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
  fireEvent.change(screen.getByLabelText('Attach image'), { target: { files: [file] } });
  await screen.findByText(name);
}
async function review() {
  await select(); fireEvent.click(screen.getByRole('button', { name: 'Review image message' }));
  await screen.findByRole('heading', { name: 'Review image message' });
}
const count = (suffix: string) => requests.filter(row => row.path.endsWith(suffix)).length;
beforeEach(() => {
  requests = []; confirmReply = () => receipt(); receiptReply = () => receipt(); textPhase = 'persisted';
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null; requests.push({ path, body });
    if (path === '/api/control/status') return json({ configured: true, state: 'ready', canRead: true, canSend: true });
    if (path.endsWith('/attachments/status')) return json(capability);
    if (path.endsWith('/history')) return json({ target, messages: [], source: { state: 'current', observedAt: 10 } });
    if (path.endsWith('/prepare')) return json({ operationId: 'image-op-1', reviewToken: 'private-token', target, message: body.message,
      image: { filename: body.image.filename, mimeType: 'image/png', bytes: 33, width: 1, height: 1, sha256: 'a'.repeat(64) }, manifestDigest: 'b'.repeat(64), expiresInMs: 300_000 });
    if (path.endsWith('/confirm')) return confirmReply();
    if (path.endsWith('/receipt')) return receiptReply();
    if (path.endsWith('/discard')) return json({ ok: true });
    if (path.endsWith('/send')) return json({ target, idempotencyKey: body.idempotencyKey, phase: textPhase, ...(textPhase === 'persisted' ? { messageId: 'text-1', messageSeq: 1 } : {}) });
    throw new Error(`Unexpected synthetic path: ${path}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('real private image composer coordination', () => {
  it('keyboard_reviews_but_never_confirms', async () => {
    await setup(); await select();
    expect(screen.queryByText(/Messages stay in this conversation/)).toBeNull();
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    const heading = await screen.findByRole('heading', { name: 'Review image message' });
    expect(heading).toHaveFocus(); expect(screen.getByText(warning)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull(); expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Send image follow-up' })).toBeDisabled();
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Send image follow-up' }), { key: 'Enter', ctrlKey: true });
    expect(count('/confirm')).toBe(0); expect(count('/send')).toBe(0); expect(count('/prepare')).toBe(1);
  });
  it('supports explicit keyboard acknowledgment and confirmation, then focuses read-only recovery', async () => {
    const user = userEvent.setup(); await setup(); await review();
    await user.tab(); expect(screen.getByRole('checkbox')).toHaveFocus();
    await user.keyboard(' '); expect(screen.getByRole('checkbox')).toBeChecked();
    await user.tab(); expect(screen.getByRole('button', { name: 'Send image follow-up' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check original submission' })).toHaveFocus());
    expect(count('/confirm')).toBe(1); expect(count('/send')).toBe(0);
  });
  it('original_review_survives_newer_draft and a late recorded receipt preserves that newer text', async () => {
    await setup(); await review();
    const region = screen.getByRole('region', { name: 'Image message review' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'newer text' } });
    expect(within(region).getByText('original text\nsecond line', { exact: true, normalizer: text => text })).toBeInTheDocument();
    for (const value of Object.values(target)) expect(within(region).getByText(value, { exact: true })).toBeInTheDocument();
    confirmReply = () => receipt('recorded', 'reference-recorded');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Send image follow-up' }));
    await screen.findByText(/Attachment reference recorded/);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('newer text');
    expect(screen.getByText(/does not verify image bytes/)).toBeInTheDocument();
    expect(requests.find(row => row.path.endsWith('/confirm'))?.body).toEqual({ operationId: 'image-op-1', reviewToken: 'private-token', sharingAcknowledged: true });
    expect(count('/send')).toBe(0);
  });
  it('clears a recorded image message only when the current draft still exactly matches', async () => {
    await setup(); await review(); confirmReply = () => receipt('recorded');
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Send image follow-up' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''));
    expect(screen.queryByText(/Messages stay in this conversation/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry original submission' })).toBeNull(); expect(count('/send')).toBe(0);
  });
  it.each(['recorded', 'rejected', 'not-dispatched'] as const)('returns recovery focus after a delayed %s confirmation', async phase => {
    await setup(); await review();
    let finish!: (value: Response) => void;
    confirmReply = () => new Promise(resolve => { finish = resolve; });
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Send image follow-up' }));
    expect(screen.getByRole('button', { name: 'Check original submission' })).toHaveFocus();
    await act(async () => finish(receipt(phase)));
    await waitFor(() => expect(screen.getByLabelText('Attach image')).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Check original submission' })).toBeNull();
    expect(count('/confirm')).toBe(1); expect(count('/send')).toBe(0);
  });
  it.each(['recorded', 'rejected', 'not-dispatched'] as const)('returns recovery focus when Check observes %s', async phase => {
    await setup(); await review();
    confirmReply = async () => { throw Error('lost confirmation reply'); };
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Send image follow-up' }));
    await screen.findByText(/Image outcome unknown/);
    const check = await screen.findByRole('button', { name: 'Check original submission' });
    expect(check).toHaveFocus();
    receiptReply = () => receipt(phase); fireEvent.click(check);
    await waitFor(() => expect(screen.getByLabelText('Attach image')).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Check original submission' })).toBeNull();
    expect(count('/receipt')).toBe(1); expect(count('/confirm')).toBe(1); expect(count('/send')).toBe(0);
  });
  it('preserves focus moved to the newer draft before a delayed terminal receipt', async () => {
    await setup(); await review();
    let finish!: (value: Response) => void;
    confirmReply = () => new Promise(resolve => { finish = resolve; });
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Send image follow-up' }));
    expect(screen.getByRole('button', { name: 'Check original submission' })).toHaveFocus();
    const message = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(message, { target: { value: 'newer draft' } }); message.focus();
    await act(async () => finish(receipt('recorded')));
    expect(message).toHaveFocus(); expect(message).toHaveValue('newer draft');
  });
  it('image_unknown_has_no_text_retry and survives mode changes, removal and remount', async () => {
    const view = await setup(); await review();
    let reject!: (error: Error) => void; confirmReply = () => new Promise((_, no) => { reject = no; });
    fireEvent.click(screen.getByRole('checkbox'));
    const confirm = screen.getByRole('button', { name: 'Send image follow-up' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(count('/confirm')).toBe(1));
    await act(async () => reject(Error('lost reply')));
    await screen.findByRole('button', { name: 'Check original submission' });
    expect(screen.queryByRole('button', { name: 'Remove image' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry original submission' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Message delivery' }), { target: { value: 'steer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Steer conversation' }));
    view.rerender(<Tree readOnly />); expect(screen.queryByLabelText('Attach image')).toBeNull();
    view.rerender(<Tree />);
    fireEvent.click(screen.getByRole('button', { name: 'Steer conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'new conversation text' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter', ctrlKey: true });
    expect(count('/send')).toBe(0); expect(count('/confirm')).toBe(1);
    expect(screen.queryByRole('button', { name: 'Retry original submission' })).toBeNull();
  });
  it('recorded_mode_has_no_image_controls and new/Steer remain text-only', async () => {
    const view = await setup(); view.rerender(<Tree readOnly />);
    expect(screen.queryByLabelText('Attach image')).toBeNull();
    view.rerender(<Tree />); await screen.findByLabelText('Attach image');
    fireEvent.change(screen.getByRole('combobox', { name: 'Message delivery' }), { target: { value: 'steer' } });
    expect(screen.queryByLabelText('Attach image')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Message delivery' }), { target: { value: 'followup' } });
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(screen.queryByLabelText('Attach image')).toBeNull();
  });
  it('removing or changing an unconfirmed image releases review authority and returns focus', async () => {
    await setup(); await review(); fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.getByLabelText('Attach image')).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('original text\nsecond line');
    await select('changed.png'); fireEvent.click(screen.getByRole('button', { name: 'Review image message' }));
    await screen.findByRole('checkbox'); expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(count('/confirm')).toBe(0);
    expect(count('/discard')).toBe(1);
  });
  it('preserves the ordinary text-only send path when no image is selected', async () => {
    await setup(); fireEvent.click(screen.getByRole('button', { name: 'Send follow-up' }));
    await waitFor(() => expect(count('/send')).toBe(1));
    expect(count('/prepare')).toBe(0); expect(count('/confirm')).toBe(0);
    expect(requests.find(row => row.path.endsWith('/send'))?.body).toMatchObject({ message: 'original text\nsecond line', intent: 'followup', target });
  });
  it.each([' ', '/stop'])('never prepares or text-sends a selected image with invalid text %j', async message => {
    await setup(); await select(); fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: message } });
    expect(screen.getByRole('button', { name: 'Review image message' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Send follow-up' }));
    expect(count('/prepare')).toBe(0); expect(count('/send')).toBe(0);
  });
  it('keeps pending ordinary text recovery separate and restores the original retry after image removal', async () => {
    await setup(); textPhase = 'unknown'; fireEvent.click(screen.getByRole('button', { name: 'Send follow-up' }));
    await screen.findByRole('button', { name: 'Retry original submission' });
    await select(); expect(screen.getByRole('button', { name: 'Review image message' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Retry original submission' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter', metaKey: true }); expect(count('/prepare')).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    textPhase = 'persisted'; fireEvent.click(screen.getByRole('button', { name: 'Retry original submission' }));
    await waitFor(() => expect(count('/send')).toBe(2));
    const sends = requests.filter(row => row.path.endsWith('/send')); expect(sends[0].body).toEqual(sends[1].body);
    expect(count('/confirm')).toBe(0);
  });
  it('leaving an unconfirmed review for Steer drops the image before ordinary text admission', async () => {
    await setup(); await review();
    fireEvent.change(screen.getByRole('combobox', { name: 'Message delivery' }), { target: { value: 'steer' } });
    expect(screen.queryByRole('checkbox')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Steer conversation' }));
    await waitFor(() => expect(count('/send')).toBe(1));
    expect(requests.find(row => row.path.endsWith('/send'))?.body).not.toHaveProperty('image');
    expect(count('/confirm')).toBe(0); expect(count('/discard')).toBe(1);
  });
  it('blocks retained imperative send and retry callbacks using real attachment selection state', async () => {
    let text!: ReturnType<typeof useConversation>; let image!: ReturnType<typeof useImageAttachments>;
    // A hook consumer allows direct admission calls, without a disabled button hiding a missing guard.
    function Composer() {
      const blocked = useRef(false);
      text = useConversation(target, true, { agentId: 'main', attachmentBlocked: () => blocked.current });
      image = useImageAttachments({ agentId: 'main', target, active: true, readOnly: false, isNew: text.isNew, intent: text.intent, message: text.draft, textPending: text.pending, onRecorded: text.clearRecordedDraft });
      blocked.current = !!image.selection || !!image.review || image.pending;
      return null;
    }
    render(<ControlAccessProvider><Access /><Composer /></ControlAccessProvider>);
    await act(() => access.unlock('synthetic-key'));
    await waitFor(() => { expect(text.ready).toBe(true); expect(image.status?.canPrepare).toBe(true); });
    act(() => text.setDraft('direct ordinary text')); const oldSend = text.send; const oldRetry = text.retryPending;
    const file = new File([bytes], 'photo.png', { type: 'image/png' }); Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
    await act(() => image.select(file)); await act(() => oldSend()); expect(count('/send')).toBe(0);
    act(() => image.remove()); textPhase = 'unknown'; await act(() => oldSend()); expect(count('/send')).toBe(1);
    await act(() => image.select(file)); await act(() => oldRetry()); expect(count('/send')).toBe(1);
    act(() => image.remove()); textPhase = 'persisted'; await act(() => oldRetry()); expect(count('/send')).toBe(2);
    const sends = requests.filter(row => row.path.endsWith('/send')); expect(sends[0].body).toEqual(sends[1].body);
  });
});
