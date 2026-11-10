import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScheduleConfirmation, ScheduleDraft, ScheduleIntent, ScheduleOperation, ScheduleSnapshot } from '../../shared/controlSchedules';
import { ControlApiError } from './api';
import { useSchedules } from './useSchedules';

const access = vi.hoisted(() => ({ request: vi.fn(), generation: 1, state: 'unlocked', canRead: true }));
vi.mock('./ControlAccess', () => ({ useControlAccess: () => ({ ...access, status: { canRead: access.canRead } }) }));
const id = '11111111-1111-4111-8111-111111111111';
const draft: ScheduleDraft = { name: 'Synthetic schedule', message: 'Synthetic private prompt', schedule: { kind: 'every', everyMs: 60000 } };
const intent: ScheduleIntent = { kind: 'create', draft };
const outcome = (state: ScheduleOperation['state'] = 'unknown'): ScheduleOperation => ({ operationId: id, agentId: 'cylena', action: 'create', state });
const snapshot = (changes: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot => ({ agentId: 'cylena', source: { state: 'current', observedAt: 1234 },
  management: { configured: true, state: 'ready', canManage: true, epoch: 'epoch-1', reason: null },
  jobs: [{ id: 'job-1', agentId: 'cylena', name: draft.name, enabled: false, revision: 'revision-1', scheduleKind: 'every', draft, readOnlyReason: null }],
  operations: [], scanned: 1, truncated: false, ...changes });
const confirmation = (input: ScheduleIntent = intent): ScheduleConfirmation => ({ operationId: id, agentId: 'cylena', intent: input, expiresAt: 1, epoch: 'epoch-1', currentEnabled: input.kind === 'create' ? null : false });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const submits = () => access.request.mock.calls.filter(([path]) => String(path).endsWith('/submit'));
const reads = () => access.request.mock.calls.filter(([path]) => /\/schedules(?:\?|$)/.test(String(path)));
const lastRequest = () => access.request.mock.calls[access.request.mock.calls.length - 1];
let latest: ScheduleSnapshot;
let visibility: DocumentVisibilityState;
beforeEach(() => {
  latest = snapshot(); visibility = 'visible'; access.generation = 1; access.state = 'unlocked'; access.canRead = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  access.request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/prepare')) return confirmation(JSON.parse(String(init?.body)).intent);
    if (path.endsWith('/submit')) return outcome('confirmed');
    if (path.endsWith('/reconcile')) return outcome('observed');
    if (/\/operations(?:\?|$)/.test(path)) return { agentId: 'cylena', operations: [] };
    return latest;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function ready() {
  const hook = renderHook(() => useSchedules({ agentId: 'cylena', active: true, historical: false }));
  await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull()); return hook;
}
async function prepared() { const hook = await ready(); act(() => hook.result.current.setDraft(draft)); await act(() => hook.result.current.prepare(intent)); expect(hook.result.current.confirmation?.operationId).toBe(id); return hook; }

it('reads_without_conversation_target', async () => {
  const { result } = await ready();
  expect(result.current.snapshot?.jobs[0].id).toBe('job-1');
  expect(access.request.mock.calls[0][0]).toBe('/api/control/agents/cylena/schedules');
  expect(access.request.mock.calls[0][1]).not.toHaveProperty('body');
});

it.each(['draft', 'agent', 'generation', 'epoch', 'history'] as const)('invalidates_confirmation_on_draft_agent_generation_epoch_or_history_change: %s', async change => {
  let agentId = 'cylena'; let historical = false;
  const { result, rerender } = renderHook(() => useSchedules({ agentId, active: true, historical }));
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  act(() => result.current.setDraft(draft)); await act(() => result.current.prepare(intent));
  const retained = result.current.submit;
  if (change === 'draft') act(() => result.current.setDraft({ ...draft, message: 'Changed synthetic prompt' }));
  if (change === 'agent') agentId = 'other-agent';
  if (change === 'generation') access.generation++;
  if (change === 'history') historical = true;
  if (change === 'epoch') { latest = snapshot({ management: { ...latest.management, epoch: 'epoch-2' } }); await act(() => result.current.refresh()); }
  rerender(); await act(() => retained());
  expect(result.current.confirmation).toBeNull(); expect(submits()).toHaveLength(0);
  if (change === 'agent' || change === 'generation') expect(result.current.draft).toBeNull();
});

it('clears_private_payload_on_lock including a deliberately delayed read', async () => {
  const { result, rerender } = await prepared(); const delayed = deferred<ScheduleSnapshot>();
  access.request.mockImplementation(() => delayed.promise);
  let request!: Promise<void>; act(() => { request = result.current.refresh(); });
  const signal = lastRequest()[1]!.signal!;
  access.state = 'locked'; access.generation++; rerender(); expect(signal.aborted).toBe(true);
  await act(async () => { delayed.resolve(snapshot()); await request; });
  expect(result.current.snapshot).toBeNull(); expect(result.current.draft).toBeNull(); expect(result.current.confirmation).toBeNull();
});

it('late_hidden_response_cannot_restore_data and unmount aborts reads', async () => {
  const delayed = deferred<ScheduleSnapshot>(); access.request.mockImplementation(() => delayed.promise);
  const { result, unmount } = renderHook(() => useSchedules({ agentId: 'cylena', active: true, historical: false }));
  const signal = access.request.mock.calls[0][1]!.signal!;
  visibility = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(signal.aborted).toBe(true);
  await act(async () => { delayed.resolve(snapshot()); await delayed.promise; }); expect(result.current.snapshot).toBeNull();
  const next = deferred<ScheduleSnapshot>(); access.request.mockImplementation(() => next.promise);
  visibility = 'visible'; act(() => document.dispatchEvent(new Event('visibilitychange')));
  const unmountSignal = lastRequest()[1]!.signal!; unmount(); expect(unmountSignal.aborted).toBe(true);
});

it('keeps a mounted draft on ordinary tab navigation but invalidates confirmation and stops reads', async () => {
  let active = true; const { result, rerender } = renderHook(() => useSchedules({ agentId: 'cylena', active, historical: false }));
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  act(() => result.current.setDraft(draft)); await act(() => result.current.prepare(intent));
  active = false; rerender(); const count = access.request.mock.calls.length;
  await act(() => result.current.refresh()); await act(() => result.current.submit());
  expect(result.current.draft).toEqual(draft); expect(result.current.confirmation).toBeNull(); expect(access.request).toHaveBeenCalledTimes(count);
  active = true; rerender(); expect(result.current.draft).toEqual(draft); expect(submits()).toHaveLength(0);
});

it('preserves_draft_on_revision_conflict and refresh invalidates old confirmation', async () => {
  const { result } = await prepared();
  access.request.mockRejectedValueOnce(new ControlApiError('schedule-changed'));
  await act(() => result.current.submit()); expect(result.current.draft).toEqual(draft); expect(result.current.confirmation).toBeNull();
  expect(result.current.error?.code).toBe('schedule-changed');
  latest = snapshot({ jobs: [{ ...latest.jobs[0], revision: 'revision-2' }] }); await act(() => result.current.refresh());
  expect(result.current.draft).toEqual(draft);
});

it('refreshing a changed native revision prevents an edit confirmation', async () => {
  const { result } = await ready(); act(() => result.current.setDraft(draft));
  const edit: ScheduleIntent = { kind: 'edit', jobId: 'job-1', revision: 'revision-1', draft };
  await act(() => result.current.prepare(edit)); expect(result.current.confirmation).not.toBeNull();
  latest = snapshot({ jobs: [{ ...latest.jobs[0], revision: 'revision-2' }] }); await act(() => result.current.refresh());
  await act(() => result.current.submit()); expect(submits()).toHaveLength(0); expect(result.current.confirmation).toBeNull(); expect(result.current.draft).toEqual(draft);
});

it.each(['unavailable', 'invalid-source', 'timed-out'] as const)('unknown_submit_never_replays_on_remount after %s', async code => {
  const first = await prepared(); access.request.mockRejectedValueOnce(new ControlApiError(code));
  await act(async () => { await Promise.all([first.result.current.submit(), first.result.current.submit()]); });
  expect(submits()).toHaveLength(1); expect(first.result.current.operation?.state).toBe('unknown');
  expect(first.result.current.error?.code).toBe('schedule-outcome-unknown'); first.unmount();
  latest = snapshot({ operations: [outcome()] }); const second = await ready(); await act(() => second.result.current.submit());
  await act(() => second.result.current.refresh()); expect(submits()).toHaveLength(1);
  expect(second.result.current.draft).toBeNull(); expect(second.result.current.confirmation).toBeNull();
});

it('recovery_after_reload_has_no_saved_prompt and reconciles only on explicit action', async () => {
  latest = snapshot({ operations: [outcome()] }); const { result } = await ready();
  expect(result.current.draft).toBeNull(); expect(result.current.confirmation).toBeNull(); expect(result.current.snapshot?.operations[0].state).toBe('unknown');
  expect(access.request.mock.calls.some(([path]) => path.endsWith('/reconcile'))).toBe(false);
  await act(() => result.current.reconcile(id)); expect(result.current.operation?.state).toBe('observed'); expect(submits()).toHaveLength(0);
});

it('late_submit_reply_cannot_replace_newer_reconciliation in the same owner and management epoch', async () => {
  const { result } = await prepared(); const delayed = deferred<ScheduleOperation>();
  const original = access.request.getMockImplementation()!;
  access.request.mockImplementation((path, init) => path.endsWith('/submit') ? delayed.promise : original(path, init));
  let submitted!: Promise<void>; act(() => { submitted = result.current.submit(); });
  await act(() => result.current.reconcile(id)); expect(result.current.operation?.state).toBe('observed');
  await act(async () => { delayed.resolve(outcome('confirmed')); await submitted; });
  expect(result.current.operation?.state).toBe('observed'); expect(result.current.snapshot?.operations.find(row => row.operationId === id)?.state).toBe('observed');
});

it('older recovery metadata cannot replace a newer explicit reconciliation', async () => {
  latest = snapshot({ operations: [outcome()], operationsCursor: 'metadata-1' }); const { result } = await ready();
  const delayed = deferred<unknown>(); const original = access.request.getMockImplementation()!;
  access.request.mockImplementation((path, init) => path.includes('/operations?') ? delayed.promise : original(path, init));
  let metadata!: Promise<void>; act(() => { metadata = result.current.loadMoreOperations(); });
  await act(() => result.current.reconcile(id));
  await act(async () => { delayed.resolve({ agentId: 'cylena', operations: [outcome()] }); await metadata; });
  expect(result.current.operation?.state).toBe('observed'); expect(result.current.snapshot?.operations[0].state).toBe('observed');
});

it('keeps native browsing, recovery metadata and native reconciliation cursors separate', async () => {
  latest = snapshot({ scanned: 200, truncated: true, nextCursor: 'native-200', operations: [outcome()], operationsCursor: 'metadata-50' });
  const { result } = await ready(); expect(reads()).toHaveLength(1);
  const original = access.request.getMockImplementation()!;
  access.request.mockImplementation(async (path, init) => {
    if (path.includes('?cursor=native-')) {
      const scanned = Number(path.split('native-')[1]) + 200;
      return snapshot({ jobs: [{ ...latest.jobs[0], id: 'job-2' }], scanned, truncated: true, ...(scanned < 2000 ? { nextCursor: `native-${scanned}` } : {}) });
    }
    if (path.endsWith('/reconcile')) return { ...outcome(), recovery: { scanned: 200, truncated: true, nextCursor: 'reconcile-200' } };
    return original(path, init);
  });
  await act(() => result.current.loadMoreOperations());
  expect(lastRequest()[0]).toBe('/api/control/agents/cylena/schedules/operations?cursor=metadata-50');
  await act(() => result.current.reconcile(id)); await act(() => result.current.reconcile(id));
  expect(JSON.parse(String(lastRequest()[1]!.body))).toEqual({ cursor: 'reconcile-200' });
  for (let page = 0; page < 9; page++) await act(() => result.current.loadMore());
  expect(result.current.snapshot?.jobs.map(job => job.id)).toEqual(['job-1', 'job-2']);
  expect(result.current.snapshot?.scanned).toBe(2000); const count = reads().length; await act(() => result.current.loadMore()); expect(reads()).toHaveLength(count);
});

it('preserves native browse on operationsError but blocks unsafe create, not edits', async () => {
  latest = snapshot({ operationsError: 'storage-unavailable' }); const { result } = await ready(); act(() => result.current.setDraft(draft));
  await act(() => result.current.prepare(intent)); expect(result.current.confirmation).toBeNull(); expect(result.current.snapshot?.jobs).toHaveLength(1);
  const edit: ScheduleIntent = { kind: 'edit', jobId: 'job-1', revision: 'revision-1', draft };
  await act(() => result.current.prepare(edit)); expect(result.current.confirmation?.intent.kind).toBe('edit');
});

it('isolates metadata storage errors and discards invalid continuation until an explicit fresh read', async () => {
  latest = snapshot({ operations: [outcome()], operationsCursor: 'metadata-50', nextCursor: 'native-50', scanned: 50, truncated: true });
  const { result } = await ready(); access.request.mockRejectedValueOnce(new ControlApiError('schedule-storage-unavailable'));
  await act(() => result.current.loadMoreOperations()); expect(result.current.snapshot?.jobs).toHaveLength(1);
  expect(result.current.snapshot?.operationsError).toBe('storage-unavailable');
  access.request.mockRejectedValueOnce(new ControlApiError('schedule-changed')); await act(() => result.current.loadMore());
  expect(result.current.stale).toBe(true); const count = reads().length; await act(() => result.current.loadMore()); expect(reads()).toHaveLength(count);
});

it.each(['schema', 'agent'] as const)('drops response %s mismatch before private state mutation', async mismatch => {
  access.request.mockResolvedValue(mismatch === 'schema' ? { ...snapshot(), unexpected: 'private-extra' } : snapshot({ agentId: 'other-agent', jobs: [] }));
  const { result } = renderHook(() => useSchedules({ agentId: 'cylena', active: true, historical: false }));
  await waitFor(() => expect(result.current.error?.code).toBe('invalid-source')); expect(result.current.snapshot).toBeNull();
});

it('uses local monotonic expiry despite server/browser wall-clock skew', async () => {
  let monotonic = 100; vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  const { result } = await prepared(); vi.spyOn(Date, 'now').mockReturnValue(-1000000);
  monotonic = 60101; await act(() => result.current.submit()); expect(submits()).toHaveLength(0); expect(result.current.confirmation).toBeNull();
});

it('clones draft and confirmation bindings so retained caller objects cannot change submitted intent', async () => {
  const { result } = await ready(); const editable = { ...draft, schedule: { ...draft.schedule } };
  act(() => result.current.setDraft(editable)); await act(() => result.current.prepare({ kind: 'create', draft: editable }));
  editable.message = 'External mutation'; await act(() => result.current.submit());
  expect(JSON.parse(String(submits()[0][1]!.body)).intent.draft.message).toBe('Synthetic private prompt');
});

it('refreshes at most every fifteen seconds, pauses for dirty editing and never polls an unknown mutation', async () => {
  vi.useFakeTimers(); const { result } = renderHook(() => useSchedules({ agentId: 'cylena', active: true, historical: false }));
  await act(async () => {}); expect(result.current.snapshot).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(14999); }); expect(reads()).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(reads()).toHaveLength(2);
  act(() => result.current.setDraft(draft)); await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(reads()).toHaveLength(2); expect(result.current.stale).toBe(true);
  await act(() => result.current.prepare(intent)); const count = reads().length;
  access.request.mockRejectedValueOnce(new ControlApiError('unavailable')); await act(() => result.current.submit());
  await act(async () => { await vi.advanceTimersByTimeAsync(45000); }); expect(reads()).toHaveLength(count); expect(submits()).toHaveLength(1);
});

it('pauses automatic refresh for incomplete local editing without blocking explicit refresh', async () => {
  vi.useFakeTimers(); let editing = false;
  const { result, rerender } = renderHook(() => useSchedules({ agentId: 'cylena', active: true, historical: false, editing }));
  await act(async () => {}); expect(result.current.snapshot).not.toBeNull();
  editing = true; rerender();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(reads()).toHaveLength(1); expect(result.current.draft).toBeNull();
  await act(() => result.current.refresh()); expect(reads()).toHaveLength(2);
});

it('does not overlap reads and marks a timed-out last-known snapshot stale without changing verification time', async () => {
  const { result } = await ready(); vi.useFakeTimers();
  access.request.mockImplementation((_path, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new ControlApiError('unavailable')), { once: true })));
  let pending!: Promise<void>; act(() => { pending = result.current.refresh(); }); await act(() => result.current.refresh()); expect(reads()).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); await pending; });
  expect(result.current.error?.code).toBe('timed-out'); expect(result.current.stale).toBe(true); expect(result.current.snapshot?.source.observedAt).toBe(1234);
});

it('expired reconciliation cursors require an explicit fresh browse, not a scan restart or timer', async () => {
  latest = snapshot({ operations: [{ ...outcome(), recovery: { scanned: 200, truncated: true, nextCursor: 'expired-recovery' } }] });
  vi.useFakeTimers(); const { result } = renderHook(() => useSchedules({ agentId: 'cylena', active: true, historical: false })); await act(async () => {});
  access.request.mockRejectedValueOnce(new ControlApiError('schedule-changed')); await act(() => result.current.reconcile(id));
  const count = access.request.mock.calls.length; await act(() => result.current.reconcile(id));
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(access.request).toHaveBeenCalledTimes(count);
  latest = snapshot({ operations: [outcome()] }); await act(() => result.current.refresh()); await act(() => result.current.reconcile(id));
  expect(JSON.parse(String(lastRequest()[1]!.body))).toEqual({}); expect(result.current.operation?.state).toBe('observed');
});

it('invalidates recovery continuation on a management epoch change', async () => {
  latest = snapshot({ operations: [{ ...outcome(), recovery: { scanned: 200, truncated: true, nextCursor: 'old-source-cursor' } }] });
  const { result } = await ready(); latest = snapshot({ management: { ...latest.management, epoch: 'epoch-2' }, operations: [outcome()] });
  await act(() => result.current.refresh()); await act(() => result.current.reconcile(id));
  expect(JSON.parse(String(lastRequest()[1]!.body))).toEqual({});
});

it('a late receipt from an old management epoch cannot resolve the current uncertain presentation', async () => {
  const { result } = await prepared(); const delayed = deferred<ScheduleOperation>(); const original = access.request.getMockImplementation()!;
  access.request.mockImplementation((path, init) => path.endsWith('/submit') ? delayed.promise : original(path, init));
  let submitted!: Promise<void>; act(() => { submitted = result.current.submit(); });
  latest = snapshot({ management: { ...latest.management, epoch: 'epoch-2' }, operations: [outcome()] });
  await act(() => result.current.refresh()); await act(async () => { delayed.resolve(outcome('confirmed')); await submitted; });
  expect(result.current.snapshot?.management.epoch).toBe('epoch-2'); expect(result.current.operation?.state).toBe('unknown');
});

it('a malformed submit receipt stays uncertain and the original intent cannot get a replacement ticket', async () => {
  const { result } = await prepared(); access.request.mockResolvedValueOnce({ ...outcome('confirmed'), agentId: 'wrong-agent' });
  await act(() => result.current.submit()); expect(result.current.operation?.state).toBe('unknown'); expect(result.current.error?.code).toBe('schedule-outcome-unknown');
  const count = access.request.mock.calls.length; await act(() => result.current.prepare(intent)); expect(access.request).toHaveBeenCalledTimes(count);
  expect(result.current.confirmation).toBeNull(); expect(submits()).toHaveLength(1);
});

it('rejects a confirmation that misrepresents the current enabled state', async () => {
  const { result } = await ready(); const original = access.request.getMockImplementation()!;
  access.request.mockImplementation(async (path, init) => path.endsWith('/prepare') ? { ...confirmation(JSON.parse(String(init?.body)).intent), currentEnabled: true } : original(path, init));
  await act(() => result.current.prepare({ kind: 'enabled', jobId: 'job-1', revision: 'revision-1', enabled: true }));
  expect(result.current.confirmation).toBeNull(); expect(result.current.error?.code).toBe('invalid-source');
});

it('stops reconciliation at the cumulative 2000 cap', async () => {
  latest = snapshot({ operations: [{ ...outcome(), recovery: { scanned: 2000, truncated: true } }] });
  const { result } = await ready(); const count = access.request.mock.calls.length;
  await act(() => result.current.reconcile(id)); expect(access.request).toHaveBeenCalledTimes(count);
});

it('late submit failures cannot replace a newer reconciliation outcome or error state', async () => {
  const { result } = await prepared(); const delayed = deferred<ScheduleOperation>(); const original = access.request.getMockImplementation()!;
  access.request.mockImplementation((path, init) => path.endsWith('/submit') ? delayed.promise : original(path, init));
  let submitted!: Promise<void>; act(() => { submitted = result.current.submit(); }); await act(() => result.current.reconcile(id));
  await act(async () => { delayed.reject(new ControlApiError('unavailable')); await submitted; });
  expect(result.current.operation?.state).toBe('observed'); expect(result.current.error).toBeNull(); expect(submits()).toHaveLength(1);
});

it('hiding an admitted mutation aborts its reply without replay or loss of uncertainty', async () => {
  const { result } = await prepared(); const delayed = deferred<ScheduleOperation>(); access.request.mockImplementation(() => delayed.promise);
  let submitted!: Promise<void>; act(() => { submitted = result.current.submit(); }); const signal = lastRequest()[1]!.signal!;
  visibility = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(signal.aborted).toBe(true);
  expect(result.current.operation?.state).toBe('unknown'); expect(result.current.confirmation).toBeNull(); expect(result.current.draft).toEqual(draft);
  await act(async () => { delayed.resolve(outcome('confirmed')); await submitted; });
  visibility = 'visible'; act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(result.current.operation?.state).toBe('unknown'); expect(submits()).toHaveLength(1);
});

it('explicit unrelated creation is not banned by incomplete unresolved metadata', async () => {
  latest = snapshot({ operations: [outcome()], operationsCursor: 'more-recovery' });
  const { result } = await prepared(); expect(result.current.confirmation?.intent.kind).toBe('create');
});

it('historical and stale reads remain browse-only', async () => {
  let historical = true; const { result, rerender } = renderHook(() => useSchedules({ agentId: 'cylena', active: true, historical }));
  await waitFor(() => expect(result.current.snapshot).not.toBeNull()); act(() => result.current.setDraft(draft));
  await act(() => result.current.prepare(intent)); expect(result.current.confirmation).toBeNull();
  historical = false; rerender(); latest = snapshot({ source: { state: 'stale', observedAt: 1234 } });
  await act(() => result.current.prepare(intent)); expect(result.current.confirmation).toBeNull(); expect(submits()).toHaveLength(0);
});

it('retains all 500 recovery records through explicit metadata pages without following the native cursor', async () => {
  const rows = (offset: number) => Array.from({ length: 50 }, (_, index) => ({ ...outcome(), operationId: `11111111-1111-4111-8111-${String(offset + index).padStart(12, '0')}` }));
  latest = snapshot({ operations: rows(0), operationsCursor: 'metadata-50', nextCursor: 'native-1', truncated: true });
  const { result } = await ready(); const original = access.request.getMockImplementation()!;
  access.request.mockImplementation(async (path, init) => {
    if (path.includes('/operations?')) { const offset = Number(path.split('metadata-')[1]); return { agentId: 'cylena', operations: rows(offset), ...(offset < 450 ? { nextCursor: `metadata-${offset + 50}` } : {}) }; }
    return original(path, init);
  });
  for (let page = 0; page < 9; page++) await act(() => result.current.loadMoreOperations());
  expect(result.current.snapshot?.operations).toHaveLength(500); expect(result.current.snapshot?.operationsCursor).toBeUndefined(); expect(reads()).toHaveLength(1);
  const count = access.request.mock.calls.length; await act(() => result.current.loadMoreOperations()); expect(access.request).toHaveBeenCalledTimes(count);
});

it.each(['unavailable', 'locked'] as const)('superseded prepare rejection %s cannot clear a newer draft or confirmation', async code => {
  const { result } = await ready(); const delayed = deferred<ScheduleConfirmation>(); const original = access.request.getMockImplementation()!;
  let preparations = 0;
  access.request.mockImplementation((path, init) => {
    if (path.endsWith('/prepare') && ++preparations === 1) return delayed.promise;
    return original(path, init);
  });
  act(() => result.current.setDraft(draft)); let previous!: Promise<void>;
  act(() => { previous = result.current.prepare(intent); });
  await waitFor(() => expect(preparations).toBe(1)); const signal = lastRequest()[1]!.signal!;
  const replacement = { ...draft, message: 'Newer synthetic draft' };
  act(() => result.current.setDraft(replacement)); expect(signal.aborted).toBe(true);
  await act(() => result.current.prepare({ kind: 'create', draft: replacement }));
  expect(result.current.confirmation?.intent).toEqual({ kind: 'create', draft: replacement });
  await act(async () => { delayed.reject(new ControlApiError(code)); await previous; });
  expect(result.current.draft).toEqual(replacement); expect(result.current.confirmation?.intent).toEqual({ kind: 'create', draft: replacement });
  expect(result.current.snapshot?.source).toEqual({ state: 'current', observedAt: 1234 }); expect(result.current.stale).toBe(false); expect(result.current.error).toBeNull();
});

it('an aborted old metadata rejection cannot poison a verified replacement management epoch', async () => {
  latest = snapshot({ operations: [outcome()], operationsCursor: 'old-metadata' }); const { result } = await ready();
  const delayed = deferred<unknown>(); const original = access.request.getMockImplementation()!;
  access.request.mockImplementation((path, init) => path.includes('/operations?') ? delayed.promise : original(path, init));
  let previous!: Promise<void>; act(() => { previous = result.current.loadMoreOperations(); }); const signal = lastRequest()[1]!.signal!;
  latest = snapshot({ management: { ...latest.management, epoch: 'epoch-2' }, operations: [outcome('changed')] });
  await act(() => result.current.refresh()); expect(signal.aborted).toBe(true);
  await act(async () => { delayed.reject(new ControlApiError('unavailable')); await previous; });
  expect(result.current.snapshot?.management.epoch).toBe('epoch-2'); expect(result.current.snapshot?.operationsError).toBeUndefined();
  expect(result.current.snapshot?.operations[0].state).toBe('changed'); expect(result.current.stale).toBe(false); expect(result.current.error).toBeNull();
});

it('an aborted snapshot-derived reconciliation rejection cannot restore an old epoch operation', async () => {
  latest = snapshot({ operations: [outcome()] }); const { result } = await ready();
  const delayed = deferred<ScheduleOperation>(); const original = access.request.getMockImplementation()!;
  access.request.mockImplementation((path, init) => path.endsWith('/reconcile') ? delayed.promise : original(path, init));
  let previous!: Promise<void>; act(() => { previous = result.current.reconcile(id); }); const signal = lastRequest()[1]!.signal!;
  latest = snapshot({ management: { ...latest.management, epoch: 'epoch-2' }, operations: [outcome('changed')] });
  await act(() => result.current.refresh()); expect(signal.aborted).toBe(true);
  await act(async () => { delayed.reject(new ControlApiError('unavailable')); await previous; });
  expect(result.current.snapshot?.management.epoch).toBe('epoch-2'); expect(result.current.stale).toBe(false); expect(result.current.error).toBeNull();
  await act(() => result.current.refresh()); expect(result.current.snapshot?.operations[0].state).toBe('changed'); expect(result.current.operation).toBeNull();
});

it.each([false, true])('canceling preparation without replacement recomputes loading with another read active: %s', async otherRead => {
  latest = snapshot({ operations: [outcome()], operationsCursor: 'metadata-50' }); const { result } = await ready();
  const preparation = deferred<ScheduleConfirmation>(); const metadata = deferred<unknown>(); const original = access.request.getMockImplementation()!;
  access.request.mockImplementation((path, init) => path.endsWith('/prepare') ? preparation.promise : path.includes('/operations?') ? metadata.promise : original(path, init));
  act(() => result.current.setDraft(draft)); let pending!: Promise<void>;
  act(() => { pending = result.current.prepare(intent); });
  await waitFor(() => expect(lastRequest()[0]).toMatch(/\/prepare$/)); const signal = lastRequest()[1]!.signal!;
  let otherPending: Promise<void> | undefined; if (otherRead) act(() => { otherPending = result.current.loadMoreOperations(); });
  const replacement = { ...draft, message: 'Retained draft without replacement preparation' };
  act(() => result.current.setDraft(replacement)); expect(signal.aborted).toBe(true); const afterCancel = result.current.loading;
  await act(async () => { preparation.reject(new ControlApiError('locked')); await pending; });
  expect(afterCancel).toBe(otherRead); expect(result.current.loading).toBe(otherRead);
  expect(result.current.draft).toEqual(replacement); expect(result.current.confirmation).toBeNull(); expect(result.current.error).toBeNull();
  if (otherRead) await act(async () => { metadata.resolve({ agentId: 'cylena', operations: [] }); await otherPending; });
  expect(result.current.loading).toBe(false);
});
