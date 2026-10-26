import { CONTROL_LIMITS, controlByteSize, controlRecord, parseControlTarget, type ControlTarget } from '../../shared/control';
import { parseControlUsageSnapshot, usageInteger, usageTimestamp, type ControlUsageSnapshot } from '../../shared/controlUsage';
import { ControlError } from './errors';
import { GatewayRequestError, type ControlGateway } from './gatewayClient';
import { projectSession } from './projection';
import type { TaskService } from './taskService';

export interface UsageService { read(target: ControlTarget, signal?: AbortSignal): Promise<ControlUsageSnapshot>; close(): void }
export function createUsageService(gateway: ControlGateway, tasks: TaskService): UsageService {
  const reads = new Set<AbortController>(); let closed = false; let epoch = 0;
  const invalidate = () => { epoch++; for (const read of reads) read.abort(); };
  const unsubscribe = gateway.onEvent(event => {
    const reason = controlRecord(event.payload)?.reason;
    if (['source.invalidated', 'source.ready', 'config.changed'].includes(event.event)
      || (event.event === 'sessions.changed' && ['reset', 'delete', 'branch', 'branch-switch', 'rewind'].includes(String(reason)))) invalidate();
  });
  return {
    async read(input, signal) {
      const target = parseControlTarget(input); if (!target) throw new ControlError('invalid-target');
      const controller = new AbortController(); reads.add(controller);
      const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]); const generation = epoch;
      const guard = () => {
        if (closed || combined.aborted || generation !== epoch) throw new ControlError('unavailable');
        if (!gateway.status().canRead) throw new ControlError(gateway.status().state === 'auth-error' ? 'scope-required' : gateway.status().state === 'pairing-required' ? 'pairing-required' : 'unavailable');
      };
      try {
        guard(); await tasks.verifyTarget(target, combined); guard();
        let raw: unknown; let unsupported = false;
        try { raw = await gateway.request('sessions.usage', { key: target.sessionKey, agentId: target.agentId, range: 'all', groupBy: 'instance', limit: 1, includeContextWeight: false }, combined); }
        catch (error) { if (error instanceof GatewayRequestError && error.code === 'unsupported') unsupported = true; else throw error; }
        guard(); const current = await tasks.verifyTarget(target, combined); guard();
        const snapshot: ControlUsageSnapshot = { target, source: { state: 'current', observedAt: Date.now() }, state: unsupported ? 'unsupported' : 'unavailable', tokens: {}, cost: {} };
        const model = projectSession(current, target.agentId)?.model;
        if (model && !/[\u0000-\u001f\u007f]/.test(model)) snapshot.model = model;
        if (usageInteger(current.contextTokens) && current.contextTokens > 0) snapshot.contextLimit = current.contextTokens;
        if (!unsupported) {
          const report = controlRecord(raw);
          if (!report || controlByteSize(report) > 2 * 1024 * 1024 || !Array.isArray(report.sessions) || report.sessions.length > 1) throw new ControlError('invalid-source');
          if (report.sessions.length) {
            const row = controlRecord(report.sessions[0]);
            const included = row?.includedSessionIds;
            const singleInstance = Array.isArray(included) && included.length === 1 && included[0] === target.sessionId;
            if (!row || row.key !== target.sessionKey || row.agentId !== target.agentId || row.sessionId !== target.sessionId
              || (row.scope !== undefined && row.scope !== 'instance')
              || (row.scope !== 'instance' && !singleInstance)
              || (included !== undefined && !singleInstance)) throw new ControlError('invalid-source');
            const usage = row.usage === null || row.usage === undefined ? null : controlRecord(row.usage);
            if (!usage && row.usage !== null && row.usage !== undefined) throw new ControlError('invalid-source');
            if (!usage) snapshot.state = row.computing === true ? 'loading' : 'unavailable';
            else {
              const cache = report.cacheStatus === undefined ? null : controlRecord(report.cacheStatus);
              if (report.cacheStatus !== undefined && report.cacheStatus !== null && (!cache || !['fresh', 'partial', 'stale', 'refreshing'].includes(String(cache.status)))) throw new ControlError('invalid-source');
              snapshot.state = (cache && cache.status !== 'fresh') || usage.refreshing === true || (usage.staleSince !== undefined && usage.staleSince !== null) || (typeof usage.missingCostEntries === 'number' && usage.missingCostEntries > 0) ? 'partial' : 'ready';
              for (const [native, key] of [['input', 'input'], ['output', 'output'], ['cacheRead', 'cacheRead'], ['cacheWrite', 'cacheWrite'], ['totalTokens', 'total']] as const) {
                if (usage[native] !== undefined && usage[native] !== null) snapshot.tokens[key] = usage[native] as number;
              }
              if (usage.totalCost !== undefined && usage.totalCost !== null) snapshot.cost.usd = usage.totalCost as number;
              if (usage.missingCostEntries !== undefined && usage.missingCostEntries !== null) snapshot.cost.missingEntries = usage.missingCostEntries as number;
              if (usageTimestamp(usage.computedAt)) snapshot.computedAt = usage.computedAt;
              if (!Object.keys(snapshot.tokens).length && snapshot.cost.usd === undefined) {
                snapshot.state = row.computing === true || usage.refreshing === true ? 'loading' : 'unavailable';
                if (snapshot.cost.missingEntries) snapshot.state = 'partial';
              }
            }
          }
        }
        const checked = parseControlUsageSnapshot(snapshot);
        if (!checked || controlByteSize(checked) > CONTROL_LIMITS.responseBytes) throw new ControlError('invalid-source');
        return checked;
      } finally { reads.delete(controller); }
    },
    close() { closed = true; unsubscribe(); invalidate(); },
  };
}
