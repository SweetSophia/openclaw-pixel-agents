import React, { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ControlTarget } from '../../shared/control';
import type { AttachmentForm } from '../control/useImageAttachments';
import './ConversationAttachment.css';

const sharingWarning = 'The image, including embedded metadata, will be sent to OpenClaw and may be processed by its model and tools. OpenClaw sharing and retention settings apply, including existing or later public session shares. The office does not make the image exclusive to this conversation. Sending cannot be undone by Lock or closing this panel.';
function Target({ target }: { target: ControlTarget }) {
  return <dl className="attachment-metadata">
    <dt>Agent ID</dt><dd>{target.agentId}</dd><dt>Conversation</dt><dd>{target.sessionKey}</dd><dt>Session ID</dt><dd>{target.sessionId}</dd>
    {target.lifecycleRevision && <><dt>Lifecycle</dt><dd>{target.lifecycleRevision}</dd></>}
    {target.branchId && <><dt>Branch</dt><dd>{target.branchId}</dd></>}
    {target.activeLeafEntryId && <><dt>Active leaf</dt><dd>{target.activeLeafEntryId}</dd></>}
  </dl>;
}
function Review({ form }: { form: AttachmentForm }) {
  const [acknowledged, setAcknowledged] = useState(false); const heading = useRef<HTMLHeadingElement>(null);
  const warningId = useId(); const checkboxId = useId(); const review = form.review!;
  useLayoutEffect(() => { heading.current?.focus(); }, []);
  return <section aria-label="Image message review" className="attachment-review" onKeyDownCapture={event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); }
  }}>
    <h3 ref={heading} tabIndex={-1}>Review image message</h3>
    <p>The image is staged on the private office server. No native send has been invoked. Confirmation sends only this frozen review, not later draft edits.</p>
    <Target target={review.target} />
    <h4>Full submitted message</h4><p className="attachment-message">{review.message}</p>
    <dl className="attachment-metadata"><dt>Filename</dt><dd>{review.image.filename}</dd><dt>Detected format</dt><dd>{review.image.mimeType}</dd>
      <dt>Bytes</dt><dd>{review.image.bytes.toLocaleString()}</dd><dt>Dimensions</dt><dd>{review.image.width} × {review.image.height}</dd>
      <dt>Image SHA-256</dt><dd>{review.image.sha256}</dd><dt>Manifest digest</dt><dd>{review.manifestDigest}</dd></dl>
    <p id={warningId}>{sharingWarning}</p>
    <label className="attachment-acknowledgment" htmlFor={checkboxId}><input id={checkboxId} type="checkbox" checked={acknowledged} aria-describedby={warningId} onChange={event => setAcknowledged(event.target.checked)} />I acknowledge this image sharing and retention warning.</label>
    <button type="button" disabled={!acknowledged || !!form.disabledReason || form.pending} onClick={() => { if (acknowledged && !form.disabledReason && !form.pending) void form.confirm(true); }}>Send image follow-up</button>
  </section>;
}
const outcomes = {
  reading: 'Reading image locally. Nothing has been uploaded.',
  preparing: 'Uploading to the private office server for preparation. No native send is invoked by this step.',
  confirming: 'One image submission is admitted. Waiting for its outcome; a native upload may not have begun.',
  accepted: 'Native message accepted — transcript persistence, image processing and task success are not established.',
  recorded: 'Message recorded in the conversation. This does not verify image bytes or that the model saw the image, and does not establish task success.',
  unknown: 'Image outcome unknown. The original may have been accepted. No replacement is sent automatically; check the original submission.',
  'not-dispatched': 'The original image submission did not invoke native send. Select an image to explicitly review a new submission.',
  rejected: 'The native image upload was rejected. This does not change other task panels.',
};
const unavailable = { disabled: 'Image sending is not enabled for this office.', permission: 'Image sending requires permission from the current connection.', unsupported: 'This connection does not support image follow-ups.', unavailable: 'Image sending is unavailable for this connection.' };
export function ConversationAttachment({ form, target }: { form: AttachmentForm; target: ControlTarget | null }) {
  const inputId = useId(); const hintId = useId(); const picker = useRef<HTMLInputElement>(null); const check = useRef<HTMLButtonElement>(null); const heading = useRef<HTMLHeadingElement>(null);
  const previousReview = useRef(false);
  const recoveryOwnedFocus = useRef(false);
  const setCheck = useCallback((node: HTMLButtonElement | null) => {
    // Capture ownership before removal resets document focus to the body.
    if (!node && check.current === document.activeElement) recoveryOwnedFocus.current = true;
    check.current = node;
  }, []);
  const admitted = ['confirming', 'unknown', 'accepted'].includes(form.phase);
  useLayoutEffect(() => {
    const prior = previousReview.current; previousReview.current = !!form.review;
    const restoreRecovery = recoveryOwnedFocus.current; recoveryOwnedFocus.current = false;
    if (document.visibilityState === 'hidden') return;
    if (prior && !form.review) (admitted ? check.current : picker.current ?? heading.current)?.focus();
    else if (restoreRecovery && !check.current && document.activeElement === document.body) (picker.current ?? heading.current)?.focus();
  });
  const reason = form.status?.reason ? unavailable[form.status.reason] : form.disabledReason;
  return <section className="conversation-attachment" aria-label="Image follow-up">
    <h3 ref={heading} tabIndex={-1}>Image follow-up</h3>
    {!form.review && target && <Target target={target} />}
    {form.status?.canPrepare && !admitted && <>
      <label htmlFor={inputId}>Attach image</label>
      <input ref={picker} id={inputId} type="file" accept="image/png,image/jpeg" disabled={form.pending} aria-describedby={hintId} onChange={event => {
        const file = event.target.files?.[0] ?? null; event.target.value = ''; void form.select(file);
      }} />
      <p id={hintId}>One PNG or JPEG, at most {form.status.maxBytes?.toLocaleString()} bytes. No thumbnail is created.</p>
    </>}
    {form.selection && !form.review && <dl className="attachment-metadata"><dt>Filename</dt><dd>{form.selection.filename}</dd><dt>Detected format</dt><dd>{form.selection.mimeType}</dd>
      <dt>Bytes</dt><dd>{form.selection.bytes.toLocaleString()}</dd><dt>Dimensions</dt><dd>{form.selection.width} × {form.selection.height}</dd></dl>}
    {form.selection && !admitted && <button type="button" disabled={form.pending} onClick={() => { form.remove(); picker.current?.focus(); }}>Remove image</button>}
    {form.selection && !form.review && <>
      <p>Review uploads the image to the private office server for preparation, not to OpenClaw yet.</p>
      <button type="button" disabled={!!form.disabledReason || form.pending} onClick={() => { if (!form.disabledReason && !form.pending) void form.prepare(); }}>Review image message</button>
    </>}
    {form.review && <Review key={form.review.operationId} form={form} />}
    {form.phase in outcomes && <p role="status">{outcomes[form.phase as keyof typeof outcomes]}</p>}
    {form.receipt && <p role="status">{form.receipt.imageEvidence === 'reference-recorded' ? 'Attachment reference recorded. A reference is not verification of image bytes or provider processing.' : form.receipt.imageEvidence === 'omitted' ? 'The native source reports the attachment was omitted.' : 'Attachment evidence is unverified.'}</p>}
    {reason && <p role="status">{reason}</p>}
    {admitted && <button type="button" ref={setCheck} onClick={() => { void form.check(); }}>Check original submission</button>}
  </section>;
}
