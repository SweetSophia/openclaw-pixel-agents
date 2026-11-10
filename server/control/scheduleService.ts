import { randomBytes } from 'node:crypto';
import { CONTROL_LIMITS, controlByteSize, controlRecord, isControlAgentId } from '../../shared/control';
import type { ScheduleManagement, ScheduleOperation, ScheduleSnapshot } from '../../shared/controlSchedules';
import type { ControlGateway, ScheduleGateway } from './gatewayClient';
import { ControlError } from './errors';
import type { ScheduleConfig } from './scheduleConfig';
import { readScheduleRecovery } from './scheduleJournal';
import { isCanonicalScheduleAgentId, projectScheduleJob } from './scheduleProjection';

export interface ScheduleService {
  read(agentId: string, cursor?: string, signal?: AbortSignal): Promise<ScheduleSnapshot>;
  operations(agentId: string): Promise<ScheduleOperation[]>;
  close(): Promise<void>;
}
interface Cursor { agentId: string; epoch: string; offset: number; scanned: number; revision: string; expires: number }
interface NativePage { jobs: Record<string, unknown>[]; snapshotRevision: string; hasMore: boolean }
const PAGE = 50; const AUTOMATIC = 200; const MAXIMUM = 2000;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function page(value: unknown, offset: number): NativePage {
  const record = controlRecord(value);
  const fields = ['jobs', 'snapshotRevision', 'total', 'offset', 'limit', 'hasMore', 'nextOffset'];
  if (!record || Reflect.ownKeys(record).some(key => typeof key !== 'string' || !fields.includes(key))
    || !Array.isArray(record.jobs) || record.jobs.length > PAGE || !record.jobs.every(row => controlRecord(row) !== null)
    || typeof record.snapshotRevision !== 'string' || !record.snapshotRevision.length || record.snapshotRevision.length > 128
    || /[\u0000-\u001f\u007f-\u009f]/.test(record.snapshotRevision) || /[\ud800-\udfff]/u.test(record.snapshotRevision)
    || !integer(record.total) || record.offset !== offset || record.limit !== PAGE || offset > record.total
    || record.jobs.length !== Math.min(PAGE, record.total - offset)
    || record.hasMore !== (offset + record.jobs.length < record.total)
    || record.nextOffset !== (record.hasMore ? offset + record.jobs.length : null)) throw new ControlError('invalid-source');
  return { jobs: record.jobs as Record<string, unknown>[], snapshotRevision: record.snapshotRevision, hasMore: record.hasMore as boolean };
}

export function createScheduleService(options: {
  reader: ControlGateway; manager: ScheduleGateway; config: ScheduleConfig; registeredAgents: () => ReadonlySet<string>;
}): ScheduleService {
  const { reader, manager, config, registeredAgents } = options;
  const cursors = new Map<string, Cursor>(); const admitted = new Set<Promise<unknown>>(); const controllers = new Set<AbortController>();
  let closed = false; let epoch = 0; let managerStarted = false; let closePromise: Promise<void> | undefined;
  const off = reader.onEvent(event => { if (event.event === 'source.invalidated') { epoch++; cursors.clear(); } });
  function registered(agentId: string): void {
    if (closed) throw new ControlError('unavailable');
    if (!isControlAgentId(agentId) || !registeredAgents().has(agentId)) throw new ControlError('invalid-target');
    // Native normalization lowercases IDs. Never silently operate on a different configured identity.
    if (!isCanonicalScheduleAgentId(agentId)) throw new ControlError('schedule-denied');
  }
  function readerEpoch(): string {
    const status = reader.status();
    if (status.state === 'pairing-required') throw new ControlError('pairing-required');
    if (status.state === 'auth-error') throw new ControlError('scope-required');
    if (!status.configured || !status.canRead || status.state !== 'ready') throw new ControlError('unavailable');
    const connection = reader.artifactConnection?.();
    return JSON.stringify([epoch, connection?.id ?? null, connection?.generation ?? null]);
  }
  function current(agentId: string, expected: string, signal: AbortSignal): void {
    registered(agentId);
    if (signal.aborted) throw new ControlError('unavailable');
    if (readerEpoch() !== expected) throw new ControlError('schedule-changed');
  }
  function admission<T>(agentId: string, action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try { registered(agentId); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController(); const abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    controllers.add(controller);
    const work = Promise.resolve().then(() => { registered(agentId); if (controller.signal.aborted) throw new ControlError('unavailable'); return action(controller.signal); });
    admitted.add(work);
    void work.then(cleanup, cleanup);
    function cleanup() { admitted.delete(work); controllers.delete(controller); signal?.removeEventListener('abort', abort); }
    return work;
  }
  async function recovery(agentId: string): Promise<ScheduleOperation[]> {
    const records = await readScheduleRecovery(config.deviceDirectory, agentId); registered(agentId);
    // This read-only slice never resolves uncertainty with a new identity or replays an add.
    const operations: ScheduleOperation[] = records.map(row => ({ operationId: row.operationId, agentId: row.agentId, action: 'create',
      state: row.state === 'observed' ? 'observed' : row.state === 'changed' ? 'changed' : 'unknown',
      ...(row.jobId === undefined ? {} : { jobId: row.jobId }) }));
    if (controlByteSize(operations) > CONTROL_LIMITS.responseBytes) throw new ControlError('schedule-storage-unavailable');
    return operations;
  }
  function management(): ScheduleManagement {
    if (!config.enabled) return { configured: false, state: 'disabled', canManage: false, epoch: null, reason: 'disabled' };
    const status = manager.status();
    return { configured: status.configured, state: status.state, canManage: status.canManage, epoch: status.epoch, reason: status.reason };
  }
  function continuation(agentId: string, token: string | undefined, expected: string): Cursor {
    const now = Date.now();
    for (const [key, row] of cursors) if (row.expires <= now) cursors.delete(key);
    if (token === undefined) return { agentId, epoch: expected, offset: 0, scanned: 0, revision: '', expires: now + 60000 };
    const row = cursors.get(token);
    if (!row || row.agentId !== agentId || row.epoch !== expected) throw new ControlError('schedule-changed');
    return { ...row };
  }
  return {
    read(agentId, cursor, signal) {
      return admission(agentId, async requestSignal => {
        const expected = readerEpoch(); const position = continuation(agentId, cursor, expected); const initialScanned = position.scanned;
        const operations = await recovery(agentId); current(agentId, expected, requestSignal);
        // Only an authenticated new browse reaches here; recovery/history and HTTP listening do not pair management.
        if (config.enabled && cursor === undefined && !managerStarted) { manager.start(); managerStarted = true; }
        const snapshot: ScheduleSnapshot = { agentId, source: { state: 'current', observedAt: Date.now() },
          management: management(), jobs: [], operations, scanned: position.scanned, truncated: cursor !== undefined };
        // Reserve the exact opaque-token footprint before adding rows, including JSON-escaping costs.
        const token = randomBytes(32).toString('base64url');
        const fits = () => controlByteSize({ ...snapshot, nextCursor: token }) <= CONTROL_LIMITS.responseBytes;
        if (!fits()) throw new ControlError('schedule-storage-unavailable');
        let processed = 0; let more = false; let stop = false;
        while (!stop && processed < AUTOMATIC && position.scanned < MAXIMUM && snapshot.jobs.length < PAGE) {
          const response = await reader.request('cron.list', { agentId, includeDisabled: true, includeDeliveryPreviews: false, limit: PAGE, offset: position.offset }, requestSignal);
          current(agentId, expected, requestSignal);
          // Native deletions clamp the offset; a changed revision means refresh, not malformed/empty data.
          const responseRevision = controlRecord(response)?.snapshotRevision;
          if (position.revision && typeof responseRevision === 'string' && position.revision !== responseRevision) throw new ControlError('schedule-changed');
          const native = page(response, position.offset);
          position.revision = native.snapshotRevision;
          snapshot.source.observedAt = Date.now();
          more = native.hasMore;
          for (let index = 0; index < native.jobs.length; index++) {
            const row = projectScheduleJob(native.jobs[index], agentId);
            snapshot.scanned = position.scanned + 1;
            if (row) snapshot.jobs.push(row); else snapshot.truncated = true;
            if (!fits()) {
              if (row) snapshot.jobs.pop();
              snapshot.scanned = position.scanned; more = true; stop = true; break;
            }
            // Scanned counts consumed native rows, including omitted foreign/unsupported ownership, never the DTO count.
            position.offset++; position.scanned++; processed++; snapshot.scanned = position.scanned;
            if (snapshot.jobs.length === PAGE || processed === AUTOMATIC || position.scanned === MAXIMUM) {
              more = index + 1 < native.jobs.length || native.hasMore; stop = true; break;
            }
          }
          if (!native.hasMore) break;
        }
        current(agentId, expected, requestSignal);
        if (position.scanned === initialScanned && (more || cursor !== undefined)) {
          throw new ControlError(more ? 'schedule-storage-unavailable' : 'schedule-changed');
        }
        if (more) {
          snapshot.truncated = true;
          if (position.scanned < MAXIMUM) {
            snapshot.nextCursor = token; cursors.set(token, position);
            while (cursors.size > 100) cursors.delete(cursors.keys().next().value!);
          }
        }
        if (controlByteSize(snapshot) > CONTROL_LIMITS.responseBytes) throw new ControlError('invalid-source');
        return snapshot;
      }, signal);
    },
    operations(agentId) { return admission(agentId, () => recovery(agentId)); },
    close() {
      if (closePromise) return closePromise;
      closed = true; off(); cursors.clear();
      for (const controller of controllers) controller.abort();
      let failure = false;
      try { manager.close(); } catch { failure = true; }
      closePromise = Promise.allSettled([...admitted]).then(() => { if (failure) throw new ControlError('unavailable'); });
      return closePromise;
    },
  };
}
