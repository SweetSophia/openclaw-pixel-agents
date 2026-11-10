import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CONTROL_LIMITS, controlByteSize, controlRecord } from '../../shared/control';
import { parseScheduleConfirmation, parseScheduleIntent, parseScheduleSubmit, type ScheduleConfirmation, type ScheduleIntent, type ScheduleOperation, type ScheduleRow, type ScheduleSubmit } from '../../shared/controlSchedules';
import { GatewayRequestError, type ScheduleGateway } from './gatewayClient';
import type { ScheduleJournal, ScheduleReservation } from './scheduleJournal';
import { ControlError } from './errors';
import { buildScheduleCreate, buildScheduleUpdate, isCanonicalScheduleAgentId, parseScheduleNativePage, projectScheduleJob, scheduleCreateDigest } from './scheduleProjection';

export interface ScheduleMutations {
  prepare(agentId: string, intent: ScheduleIntent, signal?: AbortSignal): Promise<ScheduleConfirmation>;
  submit(agentId: string, input: ScheduleSubmit): Promise<ScheduleOperation>;
  reconcile(agentId: string, operationId: string, cursor?: string, signal?: AbortSignal): Promise<ScheduleOperation>;
  close(): Promise<void>;
}
type Binding = NonNullable<ReturnType<ScheduleGateway['connection']>>;
interface Ticket { confirmation: ScheduleConfirmation; binding: Binding; definition?: string }
interface Attempt { agentId: string; digest: string; binding?: Binding; action: ScheduleIntent['kind']; jobId?: string; expected?: string; result?: ScheduleOperation; promise: Promise<ScheduleOperation> }
interface RecoveryCursor { agentId: string; operationId: string; binding: Binding; scanned: number; expires: number }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameBinding = (a: Binding, b: Binding) => a.epoch === b.epoch && a.gatewayUrl === b.gatewayUrl && a.deviceId === b.deviceId;
const configuration = (row: ScheduleRow, declarationKey: unknown) => hash({ draft: row.draft, enabled: row.enabled, declarationKey: declarationKey ?? null });
const definition = (value: unknown, agentId: string): string | undefined => {
  const row = projectScheduleJob(value, agentId); const job = controlRecord(value);
  return row && row.readOnlyReason === null ? hash({ id: row.id, draft: row.draft, enabled: row.enabled, revision: row.revision, declarationKey: job?.declarationKey ?? null }) : undefined;
};
function operation(record: ScheduleReservation): ScheduleOperation {
  return { operationId: record.operationId, agentId: record.agentId, action: 'create',
    state: record.state === 'observed' || record.state === 'changed' ? record.state : 'unknown',
    ...(record.jobId === undefined ? {} : { jobId: record.jobId }) };
}
function addJob(value: unknown): Record<string, unknown> | null {
  const receipt = controlRecord(value);
  if (!receipt || controlByteSize(receipt) > CONTROL_LIMITS.responseBytes) return null;
  if ('job' in receipt) {
    if (receipt.created !== true || ('updated' in receipt && typeof receipt.updated !== 'boolean')
      || Reflect.ownKeys(receipt).some(key => !['created', 'updated', 'job', 'deliveryPreview'].includes(String(key)))) return null;
    return controlRecord(receipt.job);
  }
  return receipt;
}
export function createScheduleMutations(options: {
  manager: ScheduleGateway; journal: () => ScheduleJournal; registeredAgents: () => ReadonlySet<string>; readerReady: () => boolean;
  acquireRead: () => () => void;
}): ScheduleMutations {
  const { manager, journal, registeredAgents, readerReady } = options;
  const tickets = new Map<string, Ticket>(); const attempts = new Map<string, Attempt>(); const pending = new Map<string, Attempt>();
  const cursors = new Map<string, RecoveryCursor>(); const readers = new Set<AbortController>(); const waiters = new Set<AbortController>(); const activeAgents = new Set<string>();
  const work = new Set<Promise<unknown>>(); let recent: number[] = []; let closed = false; let closePromise: Promise<void> | undefined;
  function registered(agentId: string): void {
    if (closed) throw new ControlError('unavailable');
    if (!registeredAgents().has(agentId)) throw new ControlError('invalid-target');
    if (!isCanonicalScheduleAgentId(agentId)) throw new ControlError('schedule-denied');
  }
  function authority(agentId: string, expected?: Binding, signal?: AbortSignal): Binding {
    registered(agentId);
    const status = manager.status(); const current = manager.connection();
    if (!readerReady() || signal?.aborted) throw new ControlError('unavailable');
    if (!status.configured || status.state !== 'ready' || !status.canManage || !current || status.epoch !== current.epoch) throw new ControlError('schedule-denied');
    if (expected && !sameBinding(expected, current)) throw new ControlError('schedule-changed');
    return { ...current };
  }
  function prune(): void {
    for (const [id, row] of tickets) if (row.confirmation.expiresAt <= Date.now()) tickets.delete(id);
    for (const [id, row] of cursors) if (row.expires <= Date.now()) cursors.delete(id);
    for (const [id, row] of attempts) {
      if (attempts.size < 500) break;
      // Consumed tickets prevent update replay; durable creation metadata remains in the journal.
      if (!pending.has(id) && (row.action === 'create' || row.result?.state !== 'unknown')) attempts.delete(id);
    }
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    work.add(promise); void promise.then(() => work.delete(promise), () => work.delete(promise)); return promise;
  }
  function waitForDispatch(attempt: Attempt, signal?: AbortSignal): Promise<void> {
    if (waiters.size >= 4) return Promise.reject(new ControlError('rate-limited'));
    const controller = new AbortController(); waiters.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 5000); timer.unref?.();
    return track(new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); waiters.delete(controller); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancelled); };
      const cancelled = () => { cleanup(); reject(new ControlError('unavailable')); };
      const settled = () => { cleanup(); resolve(); };
      controller.signal.addEventListener('abort', cancelled, { once: true });
      if (signal?.aborted || closed) cancelled();
      else void attempt.promise.then(settled, settled);
    }));
  }
  function read<T>(agentId: string, action: (signal: AbortSignal, binding: Binding) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let binding: Binding; let release: () => void;
    try {
      binding = authority(agentId, undefined, signal);
      if (readers.size >= 4) throw new ControlError('rate-limited');
      release = options.acquireRead();
    } catch (error) { return Promise.reject(error); }
    const controller = new AbortController(); readers.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 5000); timer.unref?.();
    return track(Promise.resolve().then(async () => {
      try { authority(agentId, binding, controller.signal); return await action(controller.signal, binding); }
      finally { clearTimeout(timer); readers.delete(controller); signal?.removeEventListener('abort', abort); release(); }
    }));
  }
  async function preflight(agentId: string, intent: Exclude<ScheduleIntent, { kind: 'create' }>, binding: Binding, signal?: AbortSignal) {
    const native = await manager.request('cron.get', { id: intent.jobId }, signal); authority(agentId, binding, signal);
    const row = projectScheduleJob(native, agentId); const digest = definition(native, agentId);
    if (!row || row.id !== intent.jobId || !digest) throw new ControlError('schedule-denied');
    if (row.revision !== intent.revision) throw new ControlError('schedule-changed');
    return { definition: digest, enabled: row.enabled, row, declarationKey: controlRecord(native)?.declarationKey };
  }
  function storage(): ScheduleJournal {
    try { return journal(); } catch (error) { if (error instanceof ControlError) throw error; throw new ControlError('schedule-storage-unavailable'); }
  }
  function bound(record: ScheduleReservation, binding: Binding): void {
    if (record.bindingDigest !== hash({ gatewayUrl: binding.gatewayUrl, deviceId: binding.deviceId })) throw new ControlError('schedule-changed');
  }
  function reviewed(ticket: Ticket, agentId: string, input: ScheduleSubmit): void {
    prune(); authority(agentId, ticket.binding);
    if (tickets.get(input.operationId) !== ticket || ticket.confirmation.agentId !== agentId
      || hash(ticket.confirmation.intent) !== hash(input.intent)) throw new ControlError('schedule-changed');
  }
  async function dispatch(agentId: string, input: ScheduleSubmit, attempt: Attempt): Promise<ScheduleOperation> {
    registered(agentId);
    if (input.intent.kind === 'create') {
      const previous = storage().list(agentId).find(row => row.operationId === input.operationId);
      if (previous) {
        if (previous.requestDigest !== scheduleCreateDigest(agentId, input.intent.draft)) throw new ControlError('schedule-changed');
        bound(previous, authority(agentId)); return operation(previous);
      }
    }
    const ticket = tickets.get(input.operationId); if (!ticket) throw new ControlError('schedule-changed');
    reviewed(ticket, agentId, input);
    recent = recent.filter(time => Date.now() - time < 60000);
    if (activeAgents.has(agentId) || activeAgents.size >= 4 || recent.length >= 10 || attempts.size >= 500) throw new ControlError('rate-limited');
    // Reserve the minute slot synchronously with agent/global admission, before any preflight or durable await.
    activeAgents.add(agentId); recent.push(Date.now()); attempts.set(input.operationId, attempt);
    const unknown: ScheduleOperation = { operationId: input.operationId, agentId, action: input.intent.kind, state: 'unknown',
      ...(input.intent.kind === 'create' ? {} : { jobId: input.intent.jobId }) };
    try {
      let reservation: ScheduleReservation | undefined; let params: Record<string, unknown>;
      if (input.intent.kind === 'create') {
        const store = storage();
        try { reservation = await store.reserve({ operationId: input.operationId, agentId, requestDigest: scheduleCreateDigest(agentId, input.intent.draft) }); }
        catch (error) { if (error instanceof ControlError) throw error; throw new ControlError('schedule-storage-unavailable'); }
        // An existing uncertain reservation is recovery metadata, never permission to send again.
        if (!('reserved' in reservation) || reservation.reserved !== true) return operation(reservation);
        params = buildScheduleCreate(agentId, reservation.declarationKey, input.intent.draft);
        try { reviewed(ticket, agentId, input); } catch { return unknown; }
      } else {
        const current = await read(agentId, signal => preflight(agentId, input.intent as Exclude<ScheduleIntent, { kind: 'create' }>, ticket.binding, signal));
        reviewed(ticket, agentId, input);
        if (current.definition !== ticket.definition) throw new ControlError('schedule-changed');
        params = buildScheduleUpdate(input.intent);
        attempt.expected = configuration({ ...current.row, draft: input.intent.kind === 'edit' ? input.intent.draft : current.row.draft,
          enabled: input.intent.kind === 'enabled' ? input.intent.enabled : current.enabled }, current.declarationKey);
        attempt.jobId = input.intent.jobId;
      }
      tickets.delete(input.operationId); attempt.binding = ticket.binding;
      try {
        // No browser cancellation signal: once admitted, only the native outcome/recovery can settle this work.
        const receipt = await manager.request(input.intent.kind === 'create' ? 'cron.add' : 'cron.update', params);
        authority(agentId, ticket.binding);
        const job = input.intent.kind === 'create' ? addJob(receipt) : controlRecord(receipt);
        const row = projectScheduleJob(job, agentId);
        if (!row || row.readOnlyReason !== null || (input.intent.kind !== 'create' && row.id !== input.intent.jobId)) return unknown;
        if (input.intent.kind === 'create') {
          if (job?.declarationKey !== reservation!.declarationKey || controlRecord(job.owner)?.agentId !== agentId || row.enabled
            || job.deleteAfterRun !== false || scheduleCreateDigest(agentId, row.draft!) !== reservation!.requestDigest) return unknown;
          try { await storage().record(input.operationId, 'acknowledged', row.id); } catch { return { ...unknown, jobId: row.id }; }
        } else if (configuration(row, job?.declarationKey) !== attempt.expected) return unknown;
        return { ...unknown, state: 'confirmed', jobId: row.id };
      } catch (error) {
        if (error instanceof GatewayRequestError && error.code === 'schedule-changed') throw new ControlError('schedule-changed');
        return unknown;
      }
    } finally { activeAgents.delete(agentId); }
  }
  async function reconcile(agentId: string, operationId: string, token: string | undefined, signal: AbortSignal, binding: Binding): Promise<ScheduleOperation> {
    prune();
    const attempt = attempts.get(operationId);
    if (attempt && attempt.action !== 'create') {
      if (token !== undefined || attempt.agentId !== agentId || !attempt.binding || !sameBinding(attempt.binding, binding) || !attempt.jobId) throw new ControlError('schedule-changed');
      const unknown: ScheduleOperation = { operationId, agentId, action: attempt.action, state: 'unknown', jobId: attempt.jobId };
      try {
        const native = await manager.request('cron.get', { id: attempt.jobId }, signal); authority(agentId, binding, signal);
        const row = projectScheduleJob(native, agentId);
        if (!row || row.id !== attempt.jobId) return unknown;
        return { ...unknown, state: row.readOnlyReason === null && configuration(row, controlRecord(native)?.declarationKey) === attempt.expected ? 'observed' : 'changed' };
      } catch { authority(agentId, binding, signal); return unknown; }
    }
    const record = storage().list(agentId).find(row => row.operationId === operationId);
    if (!record) throw new ControlError('schedule-changed'); bound(record, binding);
    const previous = token === undefined ? undefined : cursors.get(token);
    if (token !== undefined && (!previous || previous.operationId !== operationId || previous.agentId !== agentId || !sameBinding(previous.binding, binding))) throw new ControlError('schedule-changed');
    if (token !== undefined) cursors.delete(token);
    let scanned = previous?.scanned ?? 0; let more = false;
    const unknown: ScheduleOperation = { ...operation(record), state: 'unknown' };
    async function found(job: Record<string, unknown>): Promise<ScheduleOperation | undefined> {
      if (job.declarationKey !== record!.declarationKey) return;
      const row = projectScheduleJob(job, agentId);
      if (!row || (record!.jobId !== undefined && row.id !== record!.jobId)) return;
      const state = row.readOnlyReason === null && controlRecord(job.owner)?.agentId === agentId && !row.enabled && job.deleteAfterRun === false
        && scheduleCreateDigest(agentId, row.draft!) === record!.requestDigest ? 'observed' : 'changed';
      try { await storage().record(operationId, state, row.id); }
      catch { return { ...unknown, jobId: row.id, recovery: { scanned, truncated: more } }; }
      authority(agentId, binding, signal);
      return { ...unknown, state, jobId: row.id, recovery: { scanned, truncated: more } };
    }
    if (!previous && record.jobId) {
      try {
        const job = controlRecord(await manager.request('cron.get', { id: record.jobId }, signal)); authority(agentId, binding, signal);
        if (job) { const result = await found(job); if (result) return result; }
      } catch (error) { authority(agentId, binding, signal); if (error instanceof ControlError) throw error; }
    }
    const initial = scanned;
    while (scanned - initial < 200 && scanned < 2000) {
      const response = await manager.request('cron.list', { agentId, includeDisabled: true, includeDeliveryPreviews: false, limit: 50, offset: scanned }, signal);
      authority(agentId, binding, signal);
      const page = parseScheduleNativePage(response, scanned); more = page.hasMore;
      for (let i = 0; i < page.jobs.length; i++) {
        scanned++; const job = page.jobs[i];
        const result = await found(job); if (result) return result;
      }
      if (!more) break;
    }
    const recovery: NonNullable<ScheduleOperation['recovery']> = { scanned, truncated: more };
    if (more && scanned < 2000) {
      recovery.nextCursor = randomBytes(32).toString('base64url');
      cursors.set(recovery.nextCursor, { agentId, operationId, binding, scanned, expires: previous?.expires ?? Date.now() + 60000 });
      while (cursors.size > 100) cursors.delete(cursors.keys().next().value!);
    }
    return { ...unknown, recovery };
  }
  return {
    prepare(agentId, value, signal) {
      return read(agentId, async (readSignal, binding) => {
        const intent = parseScheduleIntent(value); if (!intent) throw new ControlError('invalid-request');
        const current = intent.kind === 'create' ? undefined : await preflight(agentId, intent, binding, readSignal);
        authority(agentId, binding, readSignal); prune();
        const confirmation = parseScheduleConfirmation({ operationId: randomUUID(), agentId, intent, expiresAt: Date.now() + 60000,
          epoch: binding.epoch, currentEnabled: current?.enabled ?? null, current: current?.row ?? null });
        if (!confirmation) throw new ControlError('invalid-source');
        tickets.set(confirmation.operationId, { confirmation: structuredClone(confirmation), binding, definition: current?.definition });
        while (tickets.size > 100) tickets.delete(tickets.keys().next().value!);
        return confirmation;
      }, signal);
    },
    submit(agentId, value) {
      let input: ScheduleSubmit; try { registered(agentId); const parsed = parseScheduleSubmit(value); if (!parsed) throw new ControlError('invalid-request'); input = parsed; }
      catch (error) { return Promise.reject(error); }
      const digest = hash({ agentId, intent: input.intent }); const existing = attempts.get(input.operationId) ?? pending.get(input.operationId);
      if (existing) return existing.agentId === agentId && existing.digest === digest
        ? existing.result ? Promise.resolve(structuredClone(existing.result)) : existing.promise.then(result => structuredClone(result))
        : Promise.reject(new ControlError('schedule-changed'));
      const attempt: Attempt = { agentId, digest, action: input.intent.kind, promise: Promise.resolve().then(() => dispatch(agentId, input, attempt)) };
      pending.set(input.operationId, attempt); track(attempt.promise);
      void attempt.promise.then(result => { attempt.result = structuredClone(result); pending.delete(input.operationId); }, () => pending.delete(input.operationId));
      return attempt.promise.then(result => structuredClone(result));
    },
    async reconcile(agentId, operationId, cursor, signal) {
      const binding = authority(agentId, undefined, signal); const inflight = pending.get(operationId);
      if (inflight) {
        if (inflight.agentId !== agentId) throw new ControlError('schedule-changed');
        // Wait before acquiring a read lease: dispatch may itself need the shared preflight budget.
        await waitForDispatch(inflight, signal); authority(agentId, binding, signal);
      }
      return read(agentId, (readSignal, binding) => reconcile(agentId, operationId, cursor, readSignal, binding), signal).then(result => {
        const attempt = attempts.get(operationId); if (attempt) attempt.result = structuredClone(result); return result;
      });
    },
    close() {
      if (closePromise) return closePromise;
      closed = true; tickets.clear(); cursors.clear(); for (const controller of readers) controller.abort();
      for (const controller of waiters) controller.abort();
      closePromise = Promise.allSettled([...work]).then(() => {}); return closePromise;
    },
  };
}
