import React from 'react';
import type { ControlUsageSnapshot } from '../../shared/controlUsage';
import type { ControlApiError } from '../control/api';
import './ConversationUsage.css';

const number = (value?: number) => value === undefined ? 'Not reported' : value.toLocaleString();
function cost(value?: number): string {
  if (value === undefined) return 'Not reported';
  if (value === 0) return '0.00 USD';
  if (value < 0.000001) return '<0.000001 USD';
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USD`;
}
export function ConversationUsage({ snapshot, loading, selected, error }: { snapshot: ControlUsageSnapshot | null; loading: boolean; selected: boolean; error?: ControlApiError | null }) {
  if (error && (!snapshot || error.code === 'usage-denied')) return <p role="alert">{error.message}</p>;
  if (!snapshot) return <p role="status">{loading ? 'Loading conversation usage…' : selected ? 'Usage is not available for this conversation yet. Refresh to check again.' : 'Choose a conversation to see its recorded usage.'}</p>;
  const missing = snapshot.cost.missingEntries ?? 0;
  const reportedCost = missing > 0 && snapshot.cost.usd === 0 ? undefined : snapshot.cost.usd;
  const notices = {
    ready: 'Recorded usage for this conversation instance.',
    partial: 'Partial usage — some history, usage reports or prices are unavailable or still refreshing.',
    loading: 'OpenClaw is computing usage. Refresh will check again.',
    unsupported: 'This Gateway does not support conversation usage. Other office panels remain available.',
    unavailable: 'No usage report is available for this conversation yet.',
  };
  return <section className="conversation-usage" aria-label="Conversation usage">
    {error && <p role="alert">{error.message}</p>}
    <h3>Conversation usage</h3>
    <p className="task-muted">Retained history for this session instance, across its recorded model calls. These are not current-task totals.</p>
    <p role="status">{snapshot.source.state === 'stale' ? 'Last known — refresh unavailable. ' : ''}{notices[snapshot.state]}</p>
    <p className="task-muted">Checked {new Date(snapshot.source.observedAt).toLocaleString()}{snapshot.computedAt === undefined ? ' · Usage computation time not reported' : ` · Usage computed ${new Date(snapshot.computedAt).toLocaleString()}`}</p>
    <dl className="usage-metrics" aria-label="Recorded token totals">
      {([['Input tokens', snapshot.tokens.input], ['Output tokens', snapshot.tokens.output], ['Cache read tokens', snapshot.tokens.cacheRead], ['Cache write tokens', snapshot.tokens.cacheWrite], ['Total tokens', snapshot.tokens.total]] as const).map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd>{number(value)}</dd></div>)}
    </dl>
    <div className="usage-cost"><h4>{missing > 0 || snapshot.state === 'partial' ? 'Known cost subtotal' : 'Recorded cost estimate'}</h4><p>{cost(reportedCost)}</p>
      {missing > 0 && <p className="task-muted">Pricing is missing for {number(missing)} recorded entries. The cost is incomplete.</p>}
      <p className="task-muted">Costs are reported or estimated by OpenClaw, not a provider invoice. Missing or interrupted usage reports may be absent from these totals.</p>
    </div>
    <h4>Conversation configuration</h4>
    <dl className="usage-configuration"><div><dt>Model</dt><dd>{snapshot.model ?? 'Not reported'}</dd></div><div><dt>Context window limit</dt><dd>{number(snapshot.contextLimit)}</dd></div><div><dt>Occupied context</dt><dd>Not reported by this Gateway</dd></div></dl>
    <p className="task-muted">Cumulative usage tokens are separate from occupied context. No context percentage is inferred.</p>
  </section>;
}
