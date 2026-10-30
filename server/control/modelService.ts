import { randomUUID } from 'node:crypto';
import { CONTROL_LIMITS, controlByteSize, controlRecord, type ControlTarget } from '../../shared/control';
import {
  CONTROL_MODEL_LIMITS, isControlModelId, modelTargetIdentity, parseControlModelChoice, parseControlModelSelection,
  parseControlModelSnapshot, parseModelTarget, type ControlModelChoice, type ControlModelDisabledReason,
  type ControlModelOutcome, type ControlModelSelection, type ControlModelSnapshot,
} from '../../shared/controlModels';
import type { ControlGateway } from './gatewayClient';
import { ControlError, type TaskService } from './taskService';

export interface ModelService {
  read(target: unknown, signal?: AbortSignal): Promise<ControlModelSnapshot>;
  select(value: unknown): Promise<ControlModelOutcome>;
  close(): void;
}
interface Observation { snapshot: ControlModelSnapshot; epoch: number; binding?: string }
interface Operation { binding: string; promise: Promise<ControlModelOutcome> }

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ControlError('unavailable'));
    if (signal.aborted) {
      void promise.catch(() => {});
      reject(new ControlError('unavailable'));
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}

function presentation(row: Record<string, unknown>): string | null {
  return isControlModelId(row.modelProvider) && isControlModelId(row.model) && isControlModelId(`${row.modelProvider}/${row.model}`)
    ? `${row.modelProvider}/${row.model}` : null;
}
function catalogChoices(value: unknown): ControlModelChoice[] {
  const row = controlRecord(value);
  if (!row || controlByteSize(row) > CONTROL_LIMITS.responseBytes || !Array.isArray(row.models) || row.models.length > CONTROL_MODEL_LIMITS.choices) throw new ControlError('invalid-source');
  const choices = row.models.map(value => {
    const model = controlRecord(value);
    if (!model || !isControlModelId(model.provider) || model.provider.includes('/') || !isControlModelId(model.id)
      || (model.manualSelectionAllowed !== undefined && typeof model.manualSelectionAllowed !== 'boolean')
      || (model.available !== undefined && typeof model.available !== 'boolean')) throw new ControlError('invalid-source');
    const choice = parseControlModelChoice({ id: `${model.provider}/${model.id}`, label: model.name,
      selectable: model.manualSelectionAllowed === true, available: model.available ?? null });
    if (!choice) throw new ControlError('invalid-source');
    return choice;
  });
  if (new Set(choices.map(choice => choice.id)).size !== choices.length) throw new ControlError('invalid-source');
  return choices;
}
function committedModel(value: unknown, input: ControlModelSelection): string | null {
  const receipt = controlRecord(value);
  const entry = controlRecord(receipt?.entry);
  const resolved = controlRecord(receipt?.resolved);
  if (!receipt || controlByteSize(receipt) > CONTROL_LIMITS.responseBytes || receipt.ok !== true || receipt.key !== input.target.sessionKey
    || !entry || !resolved || entry.sessionId !== input.target.sessionId || entry.lifecycleRevision !== input.target.lifecycleRevision) return null;
  const model = presentation(resolved);
  if (!model) return null;
  if (input.model === null) {
    return entry.modelOverrideSource === 'default'
      && ['providerOverride', 'modelOverride', 'modelOverrideRouteResolution'].every(key => !Object.prototype.hasOwnProperty.call(entry, key)) ? model : null;
  }
  const separator = input.model.indexOf('/');
  return separator > 0 && model === input.model && entry.providerOverride === input.model.slice(0, separator)
    && entry.modelOverride === input.model.slice(separator + 1) && entry.modelOverrideSource === 'user'
    && entry.modelOverrideRouteResolution === 'resolved' ? model : null;
}
export function createModelService(gateway: ControlGateway, tasks: TaskService): ModelService {
  const observations = new Map<string, Observation>();
  // Attempt identities deliberately outlive both observations and Gateway generations.
  const attempts = new Map<string, Operation>();
  const pending = new Map<string, Operation>();
  const activeTargets = new Set<string>();
  const readers = new Set<AbortController>();
  let epoch = 0;
  let closed = false;
  let recentApplies: number[] = [];
  function authority(): void {
    const status = gateway.status();
    if (status.state === 'auth-error') throw new ControlError('scope-required');
    if (status.state === 'pairing-required') throw new ControlError('pairing-required');
    if (closed || !status.canRead) throw new ControlError('unavailable');
    if (!gateway.modelCapabilities?.().canRead) throw new ControlError('unsupported');
  }
  function fence(observedEpoch: number, signal?: AbortSignal): void {
    authority();
    if (signal?.aborted) throw new ControlError('unavailable');
    if (observedEpoch !== epoch) throw new ControlError('session-changed');
  }
  function disabled(row: Record<string, unknown>): ControlModelDisabledReason {
    if (!gateway.modelCapabilities?.().canChange || row.readOnly === true) return 'read-only';
    if (row.sendPolicy === 'deny') return 'permission';
    if (row.hasActiveRun === true) return 'busy';
    if (row.hasActiveRun !== false) return 'activity-unknown';
    if (presentation(row) === null) return 'selection-unknown';
    return null;
  }
  function prune(): void {
    for (const [id, item] of observations) if (Date.now() - item.snapshot.observedAt >= CONTROL_MODEL_LIMITS.lifetime) observations.delete(id);
    while (observations.size >= CONTROL_MODEL_LIMITS.observations) observations.delete(observations.keys().next().value!);
  }
  async function catalog(target: ControlTarget, signal?: AbortSignal): Promise<ControlModelChoice[]> {
    return catalogChoices(await gateway.request('models.list', {
      agentId: target.agentId, sessionKey: target.sessionKey, view: 'configured', includeDetails: true,
    }, signal));
  }
  async function read(value: unknown, signal?: AbortSignal): Promise<ControlModelSnapshot> {
    const target = parseModelTarget(value);
    if (!target) throw new ControlError('invalid-request');
    authority();
    if (signal?.aborted) throw new ControlError('unavailable');
    if (readers.size >= CONTROL_MODEL_LIMITS.concurrentReads) throw new ControlError('rate-limited');
    const controller = new AbortController();
    const abort = () => controller.abort();
    readers.add(controller);
    signal?.addEventListener('abort', abort, { once: true });
    const observedEpoch = epoch;
    try {
      await abortable(tasks.verifyTarget(target, controller.signal), controller.signal);
      fence(observedEpoch, controller.signal);
      const choices = await abortable(catalog(target, controller.signal), controller.signal);
      fence(observedEpoch, controller.signal);
      const row = await abortable(tasks.verifyTarget(target, controller.signal), controller.signal);
      fence(observedEpoch, controller.signal);
      const reason = disabled(row);
      const snapshot = parseControlModelSnapshot({ target, selectionId: randomUUID(), observedAt: Date.now(),
        currentModel: presentation(row), choices, canChange: reason === null, disabledReason: reason });
      if (!snapshot) throw new ControlError('invalid-source');
      prune();
      observations.set(snapshot.selectionId, { snapshot: structuredClone(snapshot), epoch: observedEpoch });
      return snapshot;
    } finally {
      readers.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }
  function observed(input: ControlModelSelection, item: Observation): void {
    fence(item.epoch);
    if (observations.get(input.selectionId) !== item || Date.now() - item.snapshot.observedAt >= CONTROL_MODEL_LIMITS.lifetime
      || modelTargetIdentity(input.target) !== modelTargetIdentity(item.snapshot.target)) throw new ControlError('session-changed');
  }
  function preflightRow(row: Record<string, unknown>, item: Observation): void {
    const reason = disabled(row);
    if (reason === 'busy' || reason === 'activity-unknown') throw new ControlError('model-busy');
    if (reason !== null) throw new ControlError('model-denied');
    if (presentation(row) !== item.snapshot.currentModel) throw new ControlError('session-changed');
  }
  async function apply(input: ControlModelSelection, item: Observation, operation: Operation): Promise<ControlModelOutcome> {
    const key = modelTargetIdentity(input.target);
    if (activeTargets.has(key)) throw new ControlError('model-busy');
    activeTargets.add(key);
    try {
      observed(input, item);
      if (!item.snapshot.canChange) throw new ControlError(item.snapshot.disabledReason === 'busy' || item.snapshot.disabledReason === 'activity-unknown' ? 'model-busy' : 'model-denied');
      if (input.model !== null && !item.snapshot.choices.some(choice => choice.id === input.model && choice.selectable && choice.available === true)) throw new ControlError('model-denied');
      const initial = await tasks.verifyTarget(input.target);
      observed(input, item);
      preflightRow(initial, item);
      const choices = await catalog(input.target);
      observed(input, item);
      if (input.model !== null && !choices.some(choice => choice.id === input.model && choice.selectable && choice.available === true)) throw new ControlError('model-denied');
      const row = await tasks.verifyTarget(input.target);
      observed(input, item);
      preflightRow(row, item);
      recentApplies = recentApplies.filter(at => Date.now() - at < 60000);
      if (recentApplies.length >= CONTROL_MODEL_LIMITS.appliesPerMinute || attempts.size >= CONTROL_MODEL_LIMITS.attempts) throw new ControlError('rate-limited');
      // Commit the immutable attempted identity before handing any bytes to the Gateway.
      attempts.set(input.selectionId, operation);
      recentApplies.push(Date.now());
      const unknown: ControlModelOutcome = { target: input.target, outcome: 'unknown' };
      try {
        const receipt = await gateway.request('sessions.patch', {
          key: input.target.sessionKey, agentId: input.target.agentId, expectedSessionId: input.target.sessionId,
          ...(input.target.lifecycleRevision !== undefined ? { expectedLifecycleRevision: input.target.lifecycleRevision } : {}), model: input.model,
        });
        fence(item.epoch);
        const committed = committedModel(receipt, input);
        if (!committed) return unknown;
        const snapshot = await read(input.target);
        fence(item.epoch);
        if (snapshot.currentModel !== committed) return unknown;
        return { target: input.target, outcome: 'confirmed', snapshot };
      } catch { return unknown; }
    } finally { activeTargets.delete(key); }
  }
  const unsubscribe = gateway.onEvent(event => {
    if (event.event === 'source.invalidated' || event.event === 'sessions.changed' || event.event === 'source.ready') {
      epoch++;
      observations.clear();
      for (const controller of readers) controller.abort();
    }
  });
  return {
    read,
    select(value) {
      const parsed = parseControlModelSelection(value);
      if (!parsed) return Promise.reject(new ControlError('invalid-request'));
      try { authority(); } catch (error) { return Promise.reject(error); }
      const input = structuredClone(parsed);
      const binding = JSON.stringify([input.target, input.model]);
      const existing = attempts.get(input.selectionId) ?? pending.get(input.selectionId);
      if (existing) return existing.binding === binding ? existing.promise.then(result => structuredClone(result)) : Promise.reject(new ControlError('invalid-request'));
      const item = observations.get(input.selectionId);
      if (!item) return Promise.reject(new ControlError('session-changed'));
      if (item.binding !== undefined && item.binding !== binding) return Promise.reject(new ControlError('invalid-request'));
      item.binding = binding;
      // Schedule after installing the coalescing record; even synchronous failures share one result.
      const operation: Operation = { binding, promise: Promise.resolve().then(() => apply(input, item, operation)) };
      pending.set(input.selectionId, operation);
      void operation.promise.finally(() => { pending.delete(input.selectionId); }).catch(() => {});
      return operation.promise.then(result => structuredClone(result));
    },
    close() {
      closed = true;
      epoch++;
      observations.clear();
      unsubscribe();
      for (const controller of readers) controller.abort();
    },
  };
}
