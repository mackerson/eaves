import { useCallback, useEffect, useState } from 'react';
import { useUIStore } from '@/stores';
import { CollapsibleSection } from './CollapsibleSection';
import { formatCost, formatEnergy } from '@/lib/usageFormat';
import type { UsageRollup } from '@/types';

/** Local midnight — "today" should mean the user's today, not UTC's. */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Refresh cadence. A turn's cost lands when it ends, not while it streams, so
 * polling faster than this buys nothing but wakeups.
 */
const POLL_MS = 60_000;

/**
 * Today's spend at a glance, and the way into the system view.
 *
 * Shows the top few agents rather than a single total: the total answers
 * "how much", which the header already covers, while the list answers "because
 * of what" — the question that actually leads somewhere.
 */
export function SystemSection() {
  const { setView, view } = useUIStore();
  const [totals, setTotals] = useState<UsageRollup | null>(null);
  const [byAgent, setByAgent] = useState<UsageRollup[]>([]);

  const refresh = useCallback(async () => {
    const result = await window.electron.getUsageSummary({
      startTime: startOfToday(),
      bucket: 'hour',
    });
    if (result.success && result.summary) {
      setTotals(result.summary.totals);
      setByAgent(result.summary.byAgent.slice(0, 4));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const open = () => setView('system');

  return (
    <CollapsibleSection
      title="System"
      onTitleClick={open}
      isExpandedByDefault={false}
    >
      {!totals || totals.turns === 0 ? (
        <div className="section-empty">Nothing spent today</div>
      ) : (
        <div className="section-list">
          <button className={`section-item ${view === 'system' ? 'active' : ''}`} onClick={open}>
            <span className="item-label text-xs">Today</span>
            <span className="item-time text-xs">
              {formatCost(totals.costUsd)}
              {/* A total built from unpriced turns is a floor. One character
                  is enough to say so where there is no room to explain. */}
              {totals.unpricedTurns > 0 ? '+' : ''}
            </span>
          </button>
          <button className={`section-item ${view === 'system' ? 'active' : ''}`} onClick={open}>
            <span className="item-label text-xs">Energy</span>
            <span className="item-time text-xs">
              {formatEnergy(totals.energyWh)}
              {!totals.energyMeasured ? '~' : ''}
            </span>
          </button>
          {byAgent.map(agent => (
            <button
              key={agent.key}
              className={`section-item ${view === 'system' ? 'active' : ''}`}
              onClick={open}
              title={`${agent.label}: ${agent.turns} turns today`}
            >
              <span className="item-label truncate text-xs">{agent.label}</span>
              <span className="item-time text-xs">{formatCost(agent.costUsd)}</span>
            </button>
          ))}
          <button className="section-item section-more" onClick={open}>
            <span className="item-label text-xs">View all usage...</span>
          </button>
        </div>
      )}
    </CollapsibleSection>
  );
}
