import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { parseScheduleDraft, type ScheduleDraft, type ScheduleOperation, type ScheduleRow } from '../../shared/controlSchedules';
import { useControlAccess } from '../control/ControlAccess';
import { useSchedules } from '../control/useSchedules';
import { ControlAccessPanel } from './ControlAccessPanel';
import './AgentSchedules.css';

interface Props { agentId: string; active: boolean; historical: boolean; onReturnToLive(): void }
interface FormFields { name: string; message: string; kind: 'every' | 'cron'; seconds: string; expr: string; tz: string }
interface Editor { fields: FormFields; target: { id: string; revision: string; enabled: boolean } | null }
type Errors = Partial<Record<keyof FormFields | 'draft', string>>;
const initialFields = (): FormFields => ({ name: '', message: '', kind: 'every', seconds: '60', expr: '', tz: '' });
function fieldsFrom(draft: ScheduleDraft): FormFields {
  return { ...initialFields(), name: draft.name, message: draft.message, kind: draft.schedule.kind,
    ...(draft.schedule.kind === 'every' ? { seconds: String(draft.schedule.everyMs / 1000) } : { expr: draft.schedule.expr, tz: draft.schedule.tz }) };
}
function validate(fields: FormFields): { errors: Errors; draft: ScheduleDraft | null } {
  const errors: Errors = {};
  if (!fields.name.trim() || fields.name.length > 128) errors.name = 'Enter a schedule name of 1–128 characters.';
  if (!fields.message.trim() || new TextEncoder().encode(fields.message).byteLength > 16384) errors.message = 'Enter a task prompt up to 16 KiB UTF-8.';
  const everyMs = Number(fields.seconds) * 1000;
  if (fields.kind === 'every' && (!fields.seconds.trim() || !Number.isSafeInteger(everyMs) || everyMs < 60000 || everyMs > 31536000000)) errors.seconds = 'Enter an interval from 60 through 31,536,000 seconds (one minute to 365 days).';
  if (fields.kind === 'cron') {
    if (!fields.expr.trim() || fields.expr.length > 128 || fields.expr.trim().split(/\s+/).length !== 5) errors.expr = 'Enter exactly five cron fields, up to 128 characters.';
    try { if (!fields.tz || !/^[A-Za-z][A-Za-z0-9_+\/-]*$/.test(fields.tz)) throw Error(); new Intl.DateTimeFormat('en', { timeZone: fields.tz }); }
    catch { errors.tz = 'Enter a valid IANA timezone, such as Europe/Berlin or UTC.'; }
  }
  const draft = parseScheduleDraft({ name: fields.name, message: fields.message,
    schedule: fields.kind === 'every' ? { kind: 'every', everyMs } : { kind: 'cron', expr: fields.expr, tz: fields.tz } });
  if (!draft && !Object.keys(errors).length) errors.draft = 'Remove unsupported control characters or invalid text before reviewing.';
  return { errors, draft };
}
function timing(draft: ScheduleDraft): string {
  return draft.schedule.kind === 'every' ? `Every ${draft.schedule.everyMs / 1000} seconds` : `${draft.schedule.expr} · ${draft.schedule.tz}`;
}
function nativeTiming(row: ScheduleRow): React.ReactNode {
  return <>
    {row.timingMetadata?.anchorMs !== undefined && <p>Native interval anchor: {row.timingMetadata.anchorMs} ms</p>}
    {row.timingMetadata?.staggerMs !== undefined && <p>Native stagger: {row.timingMetadata.staggerMs} ms</p>}
  </>;
}
function outcomeText(operation: ScheduleOperation): string {
  if (operation.state === 'confirmed') return 'Native change acknowledged — this is not evidence of task execution or completion.';
  if (operation.state === 'observed') return 'Native state observed — reconciliation does not prove which caller made the change or that a task ran.';
  if (operation.state === 'changed') return 'Native state changed — inspect the current schedule; task execution is not established.';
  if (operation.state === 'not-sent') return 'Change was not sent to OpenClaw.';
  return 'Outcome unknown — do not repeat this submission. Reconcile by reading native state.';
}

export function AgentSchedules({ agentId, active, historical, onReturnToLive }: Props): React.JSX.Element {
  const access = useControlAccess(); const id = useId();
  const [editor, setEditor] = useState<Editor | null>(null); const [errors, setErrors] = useState<Errors>({});
  const formOwner = useRef(''); const owner = JSON.stringify([agentId, access.generation, access.state]);
  const schedules = useSchedules({ agentId, active, historical, editing: editor !== null && formOwner.current === owner });
  const snapshot = schedules.snapshot;
  const rootRef = useRef<HTMLElement>(null); const newRef = useRef<HTMLButtonElement>(null);
  const editorTrigger = useRef<HTMLButtonElement | null>(null); const confirmTrigger = useRef<HTMLButtonElement | null>(null);
  const submitted = useRef<{ operationId: string; editor: Editor | null } | null>(null);
  const pendingFocus = useRef<HTMLButtonElement | null>(null);
  const reviewRef = useRef<HTMLElement>(null); const previousHistorical = useRef(historical);
  // Partial fields are private tab memory, never placeholder valid drafts or shared caches.
  useLayoutEffect(() => { setEditor(null); setErrors({}); submitted.current = null; editorTrigger.current = null; confirmTrigger.current = null; pendingFocus.current = null; }, [agentId, access.generation, access.state]);
  const restore = (element: HTMLButtonElement | null) => {
    if (!active) return;
    const fallback = rootRef.current?.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    (element?.isConnected && !element.disabled ? element : newRef.current && !newRef.current.disabled ? newRef.current : fallback)?.focus();
  };
  useLayoutEffect(() => { if (pendingFocus.current) { restore(pendingFocus.current); pendingFocus.current = null; } });
  useEffect(() => {
    if (previousHistorical.current && !historical && active) void schedules.refresh();
    previousHistorical.current = historical;
  }, [historical, active, schedules.refresh]);
  useEffect(() => { if (active && schedules.confirmation) reviewRef.current?.focus(); }, [schedules.confirmation, active]);
  useEffect(() => {
    const receipt = submitted.current;
    if (receipt && schedules.operation?.operationId === receipt.operationId && schedules.operation.state === 'confirmed') {
      submitted.current = null;
      if (editor === receipt.editor) { setEditor(null); setErrors({}); schedules.setDraft(null); restore(editorTrigger.current); }
    }
  }, [schedules.operation, editor]); // A receipt closes only its unchanged submitted editor.
  useEffect(() => { if (active && editor) rootRef.current?.querySelector<HTMLInputElement>('[data-schedule-name]')?.focus(); }, [editor?.target?.id, editor !== null]);
  const manageable = active && !historical && access.state === 'unlocked' && access.status?.canRead === true
    && snapshot?.management.canManage === true && snapshot.source.state === 'current' && !schedules.stale;
  const controlsBusy = schedules.loading;
  const begin = (trigger: HTMLButtonElement, row?: ScheduleRow) => {
    if (!manageable || controlsBusy || (row && (!row.draft || !row.revision || row.readOnlyReason))) return;
    formOwner.current = owner;
    editorTrigger.current = trigger; setErrors({});
    setEditor({ fields: row?.draft ? fieldsFrom(row.draft) : initialFields(), target: row ? { id: row.id, revision: row.revision!, enabled: row.enabled } : null });
    schedules.setDraft(row?.draft ?? null);
  };
  const change = (field: keyof FormFields, value: string) => {
    if (!editor) return;
    const fields = { ...editor.fields, [field]: value };
    setEditor({ ...editor, fields }); setErrors({}); schedules.setDraft(validate(fields).draft);
  };
  const cancelEditor = () => { submitted.current = null; pendingFocus.current = editorTrigger.current; setEditor(null); setErrors({}); schedules.setDraft(null); };
  const review = async (trigger: HTMLButtonElement) => {
    if (!editor || historical) return;
    const checked = validate(editor.fields); setErrors(checked.errors);
    if (!checked.draft || Object.keys(checked.errors).length) return;
    schedules.setDraft(checked.draft); confirmTrigger.current = trigger;
    await schedules.prepare(editor.target ? { kind: 'edit', jobId: editor.target.id, revision: editor.target.revision, draft: checked.draft } : { kind: 'create', draft: checked.draft });
  };
  const enable = (row: ScheduleRow, trigger: HTMLButtonElement) => {
    if (!manageable || !row.revision || row.readOnlyReason || controlsBusy) return;
    confirmTrigger.current = trigger; void schedules.prepare({ kind: 'enabled', jobId: row.id, revision: row.revision, enabled: !row.enabled });
  };
  const confirmation = schedules.confirmation; const intent = confirmation?.intent;
  const currentTarget = editor?.target ? snapshot?.jobs.find(row => row.id === editor.target!.id) : undefined;
  const targetChanged = !!editor?.target && (!currentTarget || currentTarget.revision !== editor.target.revision || currentTarget.readOnlyReason !== null);
  const operations = [...new Map([...(snapshot?.operations ?? []), ...(schedules.operation ? [schedules.operation] : [])].map(operation => [operation.operationId, operation])).values()];
  const fieldError = (field: keyof FormFields) => errors[field] && <p id={`${id}-${field}-error`} role="alert">{errors[field]}</p>;
  const fieldProps = (field: keyof FormFields) => ({ id: `${id}-${field}`, 'aria-invalid': !!errors[field], 'aria-describedby': errors[field] ? `${id}-${field}-error` : undefined });
  const error = schedules.error?.code === 'schedule-storage-unavailable' && !snapshot?.operationsError
    ? 'Creation storage is unavailable. Recovery metadata remains readable; native browsing and revision-checked edits are independent. Ask the office operator to inspect storage. This submission will not be replayed.'
    : schedules.error?.message;
  return <ControlAccessPanel active={active} loading={schedules.loading} onRefresh={schedules.refresh} error={error}>
    <section className="agent-schedules" aria-label="Agent schedules" ref={rootRef}>
      <h3>Schedules</h3><p>Current native schedules for agent <strong>{agentId}</strong>. No conversation is required.</p>
      {historical && <div className="task-notice"><p>Viewing a recorded run. These are current schedules, read-only until you return to live.</p><button type="button" onClick={onReturnToLive}>Return to live schedules</button></div>}
      {schedules.loading && <p role="status">Loading schedules…</p>}
      {snapshot && <>
        <p className="task-muted">Read source: {snapshot.source.state} · Verified {new Date(snapshot.source.observedAt).toLocaleString()}</p>
        <p role="status">Management: {snapshot.management.state}{snapshot.management.reason ? ` · ${snapshot.management.reason}` : ''}{snapshot.management.canManage ? ' · available' : ' · read-only'}</p>
        {!snapshot.management.canManage && <p>Schedule management is separately opt-in. {snapshot.management.state === 'pairing-required' ? 'The scheduling device needs operator approval; this panel does not pair it.' : 'Ask the office operator to check scheduling management. Native reads remain independent.'}</p>}
        {schedules.stale && <p className="task-notice">Last known schedules — refresh before making changes. Drafts are retained.</p>}
        {snapshot.operationsError && <p className="task-notice" role="alert">Recovery metadata could not be read. New creation is blocked for safety; native schedules and verified edits remain available. Refresh for a fresh recovery read.</p>}
        {snapshot.truncated && <p className="task-notice">Partial schedule source: {snapshot.scanned} native positions scanned, including filtered rows. This is not a complete inventory.{snapshot.scanned >= 2000 ? ' The 2,000-position browsing limit was reached.' : ''}</p>}
      </>}
      <button type="button" ref={newRef} disabled={!manageable || controlsBusy || !!snapshot?.operationsError || editor !== null} onClick={event => begin(event.currentTarget)}>New schedule</button>
      {snapshot && !snapshot.jobs.length && <p>{snapshot.truncated ? 'No matching schedules in the scanned portion.' : 'No schedules found for this agent.'}</p>}
      <ul className="schedule-list" aria-label="Native schedules">
        {snapshot?.jobs.map(row => <li key={row.id}>
          <h4>{row.name}</h4><p>Job: {row.id} · {row.enabled ? 'Enabled' : 'Paused'}</p>
          {row.draft && <section aria-label={`Definition for ${row.name}`}><p>{timing(row.draft)}</p><p>Verified revision: {row.revision}</p><p className="task-text">{row.draft.message}</p></section>}{nativeTiming(row)}
          {row.nextRunAt !== undefined && <p>Native next run: {new Date(row.nextRunAt).toLocaleString()}</p>}
          {row.lastRunAt !== undefined && <p>Native last run: {new Date(row.lastRunAt).toLocaleString()}{row.lastRunStatus ? ` · ${row.lastRunStatus}` : ''}</p>}
          {row.readOnlyReason ? <p>Read-only: {row.readOnlyReason}. Unsupported native payloads are not shown.</p> : <div className="schedule-actions">
            <button type="button" disabled={!manageable || controlsBusy || editor !== null} onClick={event => begin(event.currentTarget, row)} aria-label={`Edit ${row.name}`}>Edit</button>
            <button type="button" disabled={!manageable || controlsBusy || editor !== null} onClick={event => enable(row, event.currentTarget)} aria-label={`${row.enabled ? 'Pause' : 'Enable'} ${row.name}`}>{row.enabled ? 'Pause' : 'Enable'}</button>
          </div>}
        </li>)}
      </ul>
      {snapshot?.nextCursor && <button type="button" disabled={controlsBusy || schedules.stale} onClick={() => void schedules.loadMore()}>Load more schedules</button>}
      {editor && <form className="schedule-editor" aria-label={editor.target ? 'Edit schedule' : 'New schedule'} noValidate onSubmit={event => event.preventDefault()}>
        <h4>{editor.target ? 'Edit schedule' : 'Create a disabled schedule'}</h4>
        <p>Agent: {agentId}{editor.target ? ` · Job: ${editor.target.id} · Revision: ${editor.target.revision}` : ''}</p>
        {editor.target?.enabled && <p className="task-notice">This schedule is enabled. Saving changes affects future runs.</p>}
        {targetChanged && <section className="task-notice" aria-label="Changed schedule target">
          <h4>The native target changed</h4><p>Your typed fields and original revision are retained. Inspect the current definition before choosing a new revision for review.</p>
          {currentTarget ? <><p>Name: {currentTarget.name} · Revision: {currentTarget.revision ?? 'unavailable'}</p>
            {currentTarget.draft && <><p>{timing(currentTarget.draft)}</p><p className="task-text">{currentTarget.draft.message}</p></>}
            {nativeTiming(currentTarget)}
            {currentTarget.draft && currentTarget.revision && !currentTarget.readOnlyReason && <button type="button" disabled={historical || controlsBusy || !manageable} onClick={() => {
              schedules.setDraft(validate(editor.fields).draft);
              setEditor({ ...editor, target: { id: currentTarget.id, revision: currentTarget.revision!, enabled: currentTarget.enabled } });
            }}>Use current revision for review</button>}
          </> : <p>The original job is not in the current read. Refresh or inspect native schedules; do not recreate it as a recovery action.</p>}
        </section>}
        <p className="task-muted">Changing an interval can reanchor its timing in OpenClaw. Cron uses native default staggering unless a native stagger is already set. No next-run time is estimated here.</p>
        <fieldset disabled={historical || controlsBusy || !!confirmation}>
          <label htmlFor={`${id}-name`}>Schedule name</label><input {...fieldProps('name')} data-schedule-name maxLength={128} value={editor.fields.name} onChange={event => change('name', event.target.value)} />{fieldError('name')}
          <label htmlFor={`${id}-message`}>Task prompt</label><textarea {...fieldProps('message')} rows={5} value={editor.fields.message} onChange={event => change('message', event.target.value)} />{fieldError('message')}
          <label htmlFor={`${id}-kind`}>Timing</label><select {...fieldProps('kind')} value={editor.fields.kind} onChange={event => change('kind', event.target.value)}><option value="every">Interval</option><option value="cron">Five-field cron</option></select>
          {editor.fields.kind === 'every' ? <><label htmlFor={`${id}-seconds`}>Interval (seconds)</label><input {...fieldProps('seconds')} type="number" min="60" max="31536000" step="0.001" value={editor.fields.seconds} onChange={event => change('seconds', event.target.value)} />{fieldError('seconds')}<p className="task-muted">One minute through 365 days.</p></> : <>
            <label htmlFor={`${id}-expr`}>Five-field cron expression</label><input {...fieldProps('expr')} maxLength={128} value={editor.fields.expr} onChange={event => change('expr', event.target.value)} />{fieldError('expr')}
            <label htmlFor={`${id}-tz`}>IANA timezone</label><input {...fieldProps('tz')} maxLength={128} value={editor.fields.tz} onChange={event => change('tz', event.target.value)} />{fieldError('tz')}
          </>}
        </fieldset>
        {errors.draft && <p role="alert">{errors.draft}</p>}
        <div className="schedule-actions"><button type="button" disabled={historical || controlsBusy || !!confirmation || targetChanged || !snapshot?.management.canManage || (!editor.target && !!snapshot?.operationsError)} onClick={event => void review(event.currentTarget)}>{editor.target ? 'Review edit' : 'Review disabled creation'}</button>
          <button type="button" onClick={cancelEditor}>Cancel editing</button></div>
      </form>}
      {confirmation && intent && <section className="schedule-review task-notice" aria-label="Review schedule change" tabIndex={-1} ref={reviewRef}>
        <h4>Review schedule change</h4><p>Agent: {confirmation.agentId}</p>
        {intent.kind !== 'create' && <p>Job: {intent.jobId} · Revision: {intent.revision}</p>}
        <p>Current state: {confirmation.currentEnabled === null ? 'Not created' : confirmation.currentEnabled ? 'Enabled' : 'Paused'}</p>
        {confirmation.current?.draft && <section aria-label="Current native definition"><h4>Current native definition</h4>
          <p>Name: {confirmation.current.draft.name}</p><p>{timing(confirmation.current.draft)}</p><p className="task-text">{confirmation.current.draft.message}</p>
          {nativeTiming(confirmation.current)}
        </section>}
        {intent.kind !== 'enabled' && <section aria-label="Resulting definition"><h4>Resulting definition</h4><p>Name: {intent.draft.name}</p><p>{timing(intent.draft)}</p><p className="task-text">{intent.draft.message}</p></section>}
        <p>Resulting state: {intent.kind === 'create' ? 'Paused (disabled)' : (intent.kind === 'enabled' ? intent.enabled : confirmation.currentEnabled) ? 'Enabled' : 'Paused'}</p>
        {intent.kind === 'create' ? <p>Created disabled in an isolated session; no announcements or failure alerts. Enabling requires a separate review and confirmation.</p>
          : intent.kind === 'enabled' ? intent.enabled ? <p>Enabling permits future execution. Ordinary tools can act externally despite no announcements or failure alerts. Native default staggering may apply.</p> : <p>Pausing stops future scheduling; existing runs may continue.</p>
            : <p>{confirmation.currentEnabled ? 'This enabled schedule changes future runs.' : 'The schedule remains paused.'} Changing interval timing can reanchor the schedule; cron retains native default staggering.</p>}
        <p className="task-muted">Review applies only to this exact target and revision. Confirmation expires within 60 seconds; a refresh or navigation cancels it.</p>
        <div className="schedule-actions"><button type="button" disabled={!manageable || controlsBusy} onClick={() => { submitted.current = { operationId: confirmation.operationId, editor }; void schedules.submit(); }}>{intent.kind === 'create' ? 'Create disabled schedule' : intent.kind === 'edit' ? 'Confirm edit' : intent.enabled ? 'Confirm enable' : 'Confirm pause'}</button>
          <button type="button" onClick={() => { pendingFocus.current = confirmTrigger.current; schedules.setDraft(schedules.draft); }}>Cancel confirmation</button></div>
      </section>}
      <section aria-label="Schedule recovery records" className="schedule-recovery">
        <h4>Recovery records</h4><p className="task-muted">Creation recovery metadata does not contain saved prompts. Acknowledgements and observations are not task results.</p>
        {!operations.length && !snapshot?.operationsError && snapshot && <p>{snapshot.operationsCursor ? 'More recovery records are available.' : 'No recovery records in this read.'}</p>}
        <ul className="schedule-list">{operations.map(operation => <li key={operation.operationId}>
          <p>Operation: {operation.operationId} · {operation.action}{operation.jobId ? ` · Job: ${operation.jobId}` : ''}</p><p role="status">{outcomeText(operation)}</p>
          {operation.recovery && <p>Reconciliation: {operation.recovery.scanned} native positions scanned.{operation.recovery.truncated ? ' Partial result.' : ''}{operation.recovery.scanned >= 2000 ? ' The 2,000-position reconciliation limit was reached; inspect current native schedules.' : ''}</p>}
          {operation.state === 'unknown' && <button type="button" disabled={!active || historical || controlsBusy || (operation.recovery?.scanned ?? 0) >= 2000} onClick={() => void schedules.reconcile(operation.operationId)}>{operation.recovery?.nextCursor ? 'Continue reconciliation' : 'Reconcile'}</button>}
        </li>)}</ul>
        {snapshot?.operationsCursor && <button type="button" disabled={controlsBusy} onClick={() => void schedules.loadMoreOperations()}>Load more recovery records</button>}
      </section>
    </section>
  </ControlAccessPanel>;
}
