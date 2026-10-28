import { CONTROL_LIMITS, controlByteSize, controlRecord, type ControlTarget } from '../../shared/control';
import { currentDirectRun, parseControlStopRequest, type ControlStopReceipt, type ControlStopRequest } from '../../shared/controlRun';
import { isControlRunId } from '../../shared/controlRunHistory';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';
import { ControlError, type TaskService } from './taskService';

export interface RunControlService { stop(input: unknown, signal?: AbortSignal): Promise<ControlStopReceipt>; close(): void }
const identity = (target: ControlTarget) => [target.agentId, target.sessionKey, target.sessionId, target.lifecycleRevision ?? null, target.branchId ?? null];
function parseStopAcknowledgement(value: unknown): { aborted: boolean; runIds: string[] } | null {
  const row = controlRecord(value);
  if (!row || controlByteSize(row) > CONTROL_LIMITS.responseBytes || Object.keys(row).some(key => !['ok', 'aborted', 'runIds'].includes(key))
    || row.ok !== true || typeof row.aborted !== 'boolean' || !Array.isArray(row.runIds) || row.runIds.length > 64 || !row.runIds.every(isControlRunId)) return null;
  return { aborted: row.aborted, runIds: row.runIds };
}
export function createRunControlService(gateway: ControlGateway, tasks: TaskService): RunControlService {
  // Retain attempted mutations for this service's lifetime: uncertain cancellation must never be replayed.
  const attempts = new Map<string, Promise<ControlStopReceipt>>(); const controllers = new Set<AbortController>();
  let recent: number[] = []; let closed = false;
  function authority(): void {
    const status = gateway.status();
    if (closed || !status.canRead) throw new ControlError('unavailable');
    if (!status.canStop) throw new ControlError(status.stopDisabledReason ?? 'unsupported');
  }
  async function perform(input: ControlStopRequest, signal: AbortSignal, attempted: () => void): Promise<ControlStopReceipt> {
    const task = await tasks.getTask(input.target, signal, { fresh: true, coalesce: false, requireUnchangedObservation: true });
    if (JSON.stringify(identity(task.target)) !== JSON.stringify(identity(input.target)) || currentDirectRun(task) !== input.runId) throw new ControlError('session-changed');
    const row = await tasks.verifyTarget(input.target, signal);
    if (row.sendDisabledReason || row.sharingRole === 'viewer' || row.readOnly === true || row.sendPolicy === 'deny') throw new ControlError('stop-denied');
    if (row.hasActiveRun !== true || !Array.isArray(row.activeRunIds) || row.activeRunIds.length !== 1 || row.activeRunIds[0] !== input.runId) throw new ControlError('session-changed');
    if (signal.aborted) throw new ControlError('unavailable');
    if (currentDirectRun(task) !== input.runId) throw new ControlError('session-changed');
    authority();
    attempted();
    let reply: unknown;
    try {
      reply = await gateway.request('chat.abort', { agentId: input.target.agentId, sessionKey: input.target.sessionKey, runId: input.runId }, signal);
    } catch (error) {
      if (error instanceof GatewayRequestError && ['stop-denied', 'session-changed', 'unsupported', 'scope-required'].includes(error.code)) throw new ControlError(error.code);
      return { ...input, phase: 'unknown' };
    }
    const result = parseStopAcknowledgement(reply);
    if (!result) throw new ControlError('invalid-source');
    if (result.aborted && result.runIds.length === 1 && result.runIds[0] === input.runId) return { ...input, phase: 'requested' };
    if (!result.aborted && result.runIds.length === 0) return { ...input, phase: 'not-running' };
    throw new ControlError('invalid-source');
  }
  return {
    async stop(value, signal) {
      const input = parseControlStopRequest(value); if (!input) throw new ControlError('invalid-request');
      if (signal?.aborted) throw new ControlError('unavailable');
      authority();
      const key = JSON.stringify([...identity(input.target), input.runId]); let flight = attempts.get(key);
      if (!flight) {
        const now = Date.now(); recent = recent.filter(at => now - at < 60000);
        if (recent.length >= 10 || attempts.size >= 1000) throw new ControlError('rate-limited');
        recent.push(now);
        const controller = new AbortController(); controllers.add(controller); let attempted = false;
        // HTTP disconnects do not cancel an operation already admitted by this boundary.
        flight = perform(input, controller.signal, () => { attempted = true; }).catch(error => {
          if (closed || controller.signal.aborted) throw new ControlError('unavailable');
          if (error instanceof ControlError || error instanceof GatewayRequestError) throw error;
          throw new ControlError('unavailable');
        }).finally(() => { controllers.delete(controller); if (!attempted) attempts.delete(key); });
        attempts.set(key, flight);
      }
      return structuredClone(await flight);
    },
    close() { closed = true; controllers.forEach(controller => controller.abort()); controllers.clear(); attempts.clear(); recent = []; },
  };
}
