import { CONTROL_LIMITS, controlByteSize, controlRecord, parseControlTarget, type ControlTarget, type ControlTaskSnapshot } from '../../shared/control';
import { CONTROL_RESULT_LIMITS, parseControlFileRequest, parseControlResultsSnapshot, type ControlFileRequest, type ControlArtifactScope, type ControlArtifactSummary, type ControlResultsSnapshot } from '../../shared/controlResults';
import { artifactQuery, artifactScope, artifactTargetIdentity, nativeArtifactSummary, sameArtifactScope } from './artifactProtocol';
import { ControlError } from './errors';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';
import type { TaskService } from './taskService';
import { downloadArtifact, type ArtifactContent } from './artifactTransfer';

export interface ArtifactService {
  read(target: ControlTarget, signal?: AbortSignal): Promise<ControlResultsSnapshot>;
  file(input: ControlFileRequest, signal?: AbortSignal): Promise<ArtifactContent>;
  clear(): void; close(): void;
}
interface Cached { snapshot: ControlResultsSnapshot; at: number; valid: boolean }
interface Flight { target: ControlTarget; controller: AbortController; users: number; observation: { dirty: boolean }; promise: Promise<ControlResultsSnapshot> }
export function createArtifactService(gateway: ControlGateway, tasks: TaskService): ArtifactService {
  const cache = new Map<string, Cached>(); const flights = new Map<string, Flight>();
  const contentWork = new Set<AbortController>();
  let closed = false; let epoch = 0;
  const stamp = () => { const connection = gateway.artifactConnection?.(); return JSON.stringify([epoch, connection?.id ?? null, connection?.generation ?? null]); };
  function denied(): void {
    if (gateway.status().state === 'auth-error') throw new ControlError('scope-required');
    if (gateway.status().state === 'pairing-required') throw new ControlError('pairing-required');
  }
  function guard(signal: AbortSignal, connection: string): void {
    denied();
    if (connection !== stamp()) throw new ControlError('session-changed');
    if (closed || signal.aborted) throw new ControlError('unavailable');
  }
  function trim(): void {
    for (const [key, entry] of cache) if (Date.now() - entry.at >= CONTROL_RESULT_LIMITS.metadataExpiryMs) cache.delete(key);
    while (cache.size > CONTROL_RESULT_LIMITS.metadataSelections) cache.delete(cache.keys().next().value!);
  }
  function previous(target: ControlTarget, scope?: ControlArtifactScope): Cached | undefined {
    trim();
    return [...cache.values()].reverse().find(entry => artifactTargetIdentity(entry.snapshot.target) === artifactTargetIdentity(target)
      && (!scope || sameArtifactScope(entry.snapshot.scope, scope)));
  }
  const stale = (entry: Cached): ControlResultsSnapshot => ({ ...structuredClone(entry.snapshot), artifactState: 'unavailable', source: { ...entry.snapshot.source, state: 'stale' } });
  function project(task: ControlTaskSnapshot, artifacts: ControlArtifactSummary[], artifactState: ControlResultsSnapshot['artifactState'], truncated = false): ControlResultsSnapshot {
    const response = task.result ?? task.latestResponse;
    const snapshot: ControlResultsSnapshot = { target: task.target, scope: artifactScope(task), source: task.source, runState: task.runState,
      responseKind: task.result ? 'result' : response ? 'latest' : 'none', ...(response ? { response } : {}),
      artifacts, artifactState, artifactsTruncated: truncated };
    while (controlByteSize(snapshot) > CONTROL_LIMITS.responseBytes && snapshot.artifacts.length) { snapshot.artifacts.pop(); snapshot.artifactsTruncated = true; }
    const checked = parseControlResultsSnapshot(snapshot); if (!checked) throw new ControlError('invalid-source'); return checked;
  }
  function clear(): void {
    epoch++; cache.clear(); for (const flight of flights.values()) flight.controller.abort(); flights.clear();
    for (const controller of contentWork) controller.abort(); contentWork.clear();
  }
  async function perform(target: ControlTarget, signal: AbortSignal, connection: string, observation: { dirty: boolean }): Promise<ControlResultsSnapshot> {
    guard(signal, connection); let task: ControlTaskSnapshot;
    try { task = await tasks.getTask(target, signal); }
    catch (error) {
      guard(signal, connection);
      const old = previous(target);
      if (old && error instanceof ControlError && error.code === 'unavailable') return stale(old);
      throw error;
    }
    guard(signal, connection);
    const scope = artifactScope(task); const key = JSON.stringify([artifactTargetIdentity(task.target), scope, connection]);
    trim(); const old = cache.get(key);
    if (task.source.state === 'stale') {
      const known = old ?? previous(task.target, scope); return known ? stale(known) : project(task, [], 'unavailable');
    }
    const reused = old?.valid && Date.now() - old.at < CONTROL_RESULT_LIMITS.metadataReuseMs;
    let raw: unknown; let failed = false; let unsupported = false;
    if (!reused) {
      try { raw = await gateway.request('artifacts.list', artifactQuery(task.target, scope), signal); }
      catch (error) {
        if ((error instanceof GatewayRequestError || error instanceof ControlError) && ['scope-required', 'pairing-required', 'session-changed', 'invalid-target'].includes(error.code)) {
          clear(); throw new ControlError(error.code);
        }
        failed = true; unsupported = (error instanceof GatewayRequestError || error instanceof ControlError) && error.code === 'unsupported';
      }
    }
    guard(signal, connection);
    const current = await tasks.getTask(task.target, signal, { fresh: true });
    guard(signal, connection);
    if (artifactTargetIdentity(current.target) !== artifactTargetIdentity(task.target) || !sameArtifactScope(artifactScope(current), scope)) throw new ControlError('session-changed');
    if (current.source.state !== 'current') return old ? stale(old) : project(current, [], 'unavailable');
    if (reused) return structuredClone(old.snapshot);
    if (failed && !unsupported) return old ? stale(old) : project(current, [], 'unavailable');
    let normalized: ControlArtifactSummary[] = []; let truncated = false;
    if (!unsupported) {
      try {
        const row = controlRecord(raw); if (!row || !Array.isArray(row.artifacts)) throw new ControlError('invalid-source');
        const all = row.artifacts.map(value => nativeArtifactSummary(value, task.target, scope))
          .sort((a, b) => (b.messageSeq ?? -1) - (a.messageSeq ?? -1));
        const seen = new Set<string>();
        normalized = all.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; }).slice(0, CONTROL_RESULT_LIMITS.artifacts);
        truncated = normalized.length !== all.length;
      } catch { return old ? stale(old) : project(current, [], 'unavailable'); }
    }
    const snapshot = project(current, normalized, unsupported ? 'unsupported' : 'ready', truncated);
    guard(signal, connection); cache.delete(key); cache.set(key, { snapshot: structuredClone(snapshot), at: Date.now(), valid: !observation.dirty }); trim();
    return snapshot;
  }
  const unsubscribe = gateway.onEvent(event => {
    if (event.event !== 'source.invalidated' && event.event !== 'sessions.changed' && event.event !== 'source.ready') return;
    const payload = controlRecord(event.payload);
    const destructive = payload && ['reset', 'delete', 'branch', 'branch-switch', 'rewind'].includes(String(payload.reason));
    if (destructive || gateway.status().state === 'auth-error' || gateway.status().state === 'pairing-required') { clear(); return; }
    if (event.event !== 'sessions.changed') {
      epoch++; for (const flight of flights.values()) flight.controller.abort(); flights.clear();
      for (const controller of contentWork) controller.abort(); contentWork.clear();
    }
    const nested = controlRecord(payload?.session); const key = payload?.sessionKey ?? nested?.key;
    const agent = payload?.agentId ?? nested?.agentId;
    const affected = (target: ControlTarget) => (typeof key !== 'string' || key === target.sessionKey) && (typeof agent !== 'string' || agent === target.agentId);
    for (const entry of cache.values()) if (event.event !== 'sessions.changed' || affected(entry.snapshot.target)) entry.valid = false;
    for (const flight of flights.values()) if (affected(flight.target)) flight.observation.dirty = true;
  });
  return {
    async file(value, signal) {
      const input = parseControlFileRequest(value); if (!input) throw new ControlError('invalid-request');
      const controller = new AbortController(); contentWork.add(controller);
      const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]); const connection = stamp();
      const timer = setTimeout(() => controller.abort(), CONTROL_RESULT_LIMITS.contentDeadlineMs); timer.unref?.();
      const verify = async () => {
        guard(combined, connection); const task = await tasks.getTask(input.target, combined, { fresh: true }); guard(combined, connection);
        if (task.source.state !== 'current') throw new ControlError('unavailable');
        if (!sameArtifactScope(artifactScope(task), input.scope)) throw new ControlError('session-changed');
      };
      try {
        await verify(); let content: ArtifactContent | undefined; let failure: unknown;
        try { content = await downloadArtifact(gateway, input, combined); } catch (error) { failure = error; }
        await verify(); if (failure) throw failure; return content!;
      } finally { clearTimeout(timer); contentWork.delete(controller); }
    },
    read(input, signal) {
      const target = parseControlTarget(input);
      if (!target) return Promise.reject(new ControlError('invalid-target'));
      if (closed || signal?.aborted) return Promise.reject(new ControlError('unavailable'));
      const connection = stamp(); const key = JSON.stringify([artifactTargetIdentity(target), connection]);
      let flight = flights.get(key);
      if (!flight) {
        const controller = new AbortController(); const observation = { dirty: false };
        const pending: Flight = { target, controller, users: 0, observation, promise: perform(target, controller.signal, connection, observation) };
        flight = pending; flights.set(key, flight);
        void pending.promise.finally(() => { if (flights.get(key) === pending) flights.delete(key); }).catch(() => {});
      }
      const current = flight; current.users++;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return false; settled = true; signal?.removeEventListener('abort', abort); current.users--;
          if (!current.users) { if (flights.get(key) === current) flights.delete(key); current.controller.abort(); } return true;
        };
        const abort = () => { if (finish()) reject(new ControlError('unavailable')); };
        signal?.addEventListener('abort', abort, { once: true });
        current.promise.then(value => { if (finish()) resolve(structuredClone(value)); }, error => { if (finish()) reject(error); });
      });
    }, clear,
    close() { closed = true; unsubscribe(); clear(); },
  };
}
