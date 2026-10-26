import { CONTROL_LIMITS, controlByteSize, controlRecord, parseControlTarget, type ControlSource, type ControlTarget } from './control';

export interface UsageTokens { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
export interface UsageCost { usd?: number; missingEntries?: number }
export interface ControlUsageSnapshot {
  target: ControlTarget; source: ControlSource;
  state: 'ready' | 'partial' | 'loading' | 'unsupported' | 'unavailable';
  tokens: UsageTokens; cost: UsageCost; model?: string; contextLimit?: number; computedAt?: number;
}
const closed = (row: Record<string, unknown>, keys: string[]) => Object.keys(row).every(key => keys.includes(key));
export const usageInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const usageTimestamp = (value: unknown): value is number => usageInteger(value) && value <= 8640000000000000;
export function parseControlUsageSnapshot(value: unknown): ControlUsageSnapshot | null {
  const row = controlRecord(value);
  if (!row || controlByteSize(row) > CONTROL_LIMITS.responseBytes || !closed(row, ['target', 'source', 'state', 'tokens', 'cost', 'model', 'contextLimit', 'computedAt'])) return null;
  const target = parseControlTarget(row.target); const source = controlRecord(row.source);
  const tokens = controlRecord(row.tokens); const cost = controlRecord(row.cost);
  if (!target || !source || !closed(source, ['state', 'observedAt']) || !usageTimestamp(source.observedAt)
    || (source.state !== 'current' && source.state !== 'stale')
    || typeof row.state !== 'string' || !['ready', 'partial', 'loading', 'unsupported', 'unavailable'].includes(row.state)
    || !tokens || !closed(tokens, ['input', 'output', 'cacheRead', 'cacheWrite', 'total'])
    || Object.values(tokens).some(value => !usageInteger(value))
    || !cost || !closed(cost, ['usd', 'missingEntries'])
    || (cost.usd !== undefined && (typeof cost.usd !== 'number' || !Number.isFinite(cost.usd) || cost.usd < 0 || cost.usd > Number.MAX_SAFE_INTEGER))
    || (cost.missingEntries !== undefined && !usageInteger(cost.missingEntries))
    || (row.model !== undefined && (typeof row.model !== 'string' || !row.model || row.model.length > 256 || /[\u0000-\u001f\u007f]/.test(row.model)))
    || (row.contextLimit !== undefined && (!usageInteger(row.contextLimit) || row.contextLimit === 0))
    || (row.computedAt !== undefined && !usageTimestamp(row.computedAt))) return null;
  return { target, source: { state: source.state, observedAt: source.observedAt }, state: row.state as ControlUsageSnapshot['state'],
    tokens: { ...tokens }, cost: { ...cost },
    ...(row.model === undefined ? {} : { model: row.model as string }),
    ...(row.contextLimit === undefined ? {} : { contextLimit: row.contextLimit as number }),
    ...(row.computedAt === undefined ? {} : { computedAt: row.computedAt as number }) };
}
