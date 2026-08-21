import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Gauge, Loader2, RefreshCw, TriangleAlert, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/contexts/ThemeContext';
import { useSettingsStore } from '@/stores';
import { colorForKey, seriesPalette } from '@/lib/chartPalette';
import {
  cacheHitRate, energyComparison, formatCarbon, formatCost, formatEnergy,
  formatEnergyRange, formatTokens, isBackgroundKind, kindLabel, rollupCaveats,
} from '@/lib/usageFormat';
import { DEFAULT_GRID_INTENSITY_G_PER_KWH, energyToCarbonGrams } from '@shared/energy';
import type { UsageDimension, UsageRollup, UsageSummary } from '@/types';
import { cn } from '@/lib/utils';

/**
 * The master cost view.
 *
 * Three things drive its shape, and each is a deliberate rejection of a more
 * obvious design:
 *
 * 1. **One measure per chart, never two y-axes.** Cost, tokens and energy are
 *    different scales, and putting any two on one plot invites the reader to
 *    see a relationship in what is really an arbitrary choice of scaling. The
 *    measure toggle switches what the same chart shows instead.
 *
 * 2. **Every total says what it is missing.** Unpriced turns contribute
 *    nothing to a cost sum, and a turn that ended early reports a floor. Both
 *    are surfaced next to the number rather than hidden, because a total
 *    silently short is worse than one that admits it.
 *
 * 3. **Estimated and measured are never blended silently.** Cloud energy is a
 *    published-figure estimate with a wide range; local energy may be a real
 *    reading off RAPL. They carry different labels and the range travels with
 *    the estimate.
 */

type RangeKey = '24h' | '7d' | '30d' | 'all';
type Measure = 'cost' | 'tokens' | 'energy';

const RANGES: Array<{ key: RangeKey; label: string; ms: number | null; bucket: 'hour' | 'day' | 'week' }> = [
  { key: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000, bucket: 'hour' },
  { key: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000, bucket: 'day' },
  { key: '30d', label: '30 days', ms: 30 * 24 * 60 * 60 * 1000, bucket: 'day' },
  { key: 'all', label: 'All time', ms: null, bucket: 'week' },
];

const MEASURES: Array<{ key: Measure; label: string }> = [
  { key: 'cost', label: 'Cost' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'energy', label: 'Energy' },
];

const DIMENSIONS: Array<{ key: UsageDimension; label: string; field: keyof UsageSummary }> = [
  { key: 'agent', label: 'Agent', field: 'byAgent' },
  { key: 'provider', label: 'Provider', field: 'byProvider' },
  { key: 'model', label: 'Model', field: 'byModel' },
  { key: 'project', label: 'Project', field: 'byProject' },
  { key: 'kind', label: 'Work type', field: 'byKind' },
];

function measureValue(rollup: UsageRollup, measure: Measure): number {
  if (measure === 'cost') return rollup.costUsd;
  if (measure === 'tokens') return rollup.inputTokens + rollup.outputTokens;
  return rollup.energyWh;
}

function formatMeasure(value: number, measure: Measure): string {
  if (measure === 'cost') return formatCost(value);
  if (measure === 'tokens') return formatTokens(value);
  return formatEnergy(value);
}

/**
 * A headline figure. No plot, so no tooltip — the caveat line beneath carries
 * everything the number cannot say on its own.
 */
function StatTile({
  label, value, sub, caveat, accent,
}: {
  label: string;
  value: string;
  sub?: string | null;
  caveat?: string | null;
  accent?: 'normal' | 'warn';
}) {
  return (
    <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--text-tertiary)]">{label}</div>
      <div
        className={cn(
          'mt-1 text-2xl font-semibold tabular-nums',
          accent === 'warn' ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]',
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-sm text-[var(--text-secondary)]">{sub}</div>}
      {caveat && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-[var(--text-tertiary)]">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{caveat}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Horizontal bars, sorted by magnitude, with the value written on each row.
 *
 * The direct labels are not decoration: three of the light-mode palette slots
 * fall below 3:1 against a light surface, and a visible label is the relief
 * that makes that legal. It also means identity never rests on colour alone.
 *
 * Label above, bar below, rather than side by side in fixed columns — a
 * three-column row leaves the bar whatever pixels the labels did not want,
 * which on a narrow window is none of them.
 */
function BreakdownBars({
  rows, measure, isDark, emptyLabel, labelFor,
}: {
  rows: UsageRollup[];
  measure: Measure;
  isDark: boolean;
  emptyLabel: string;
  labelFor?: (row: UsageRollup) => string;
}) {
  const ranked = useMemo(
    () => [...rows]
      // Ranked by value but *kept* on turns. A row worth $0 is not a row worth
      // hiding: an unpriced model contributes nothing to the cost total, and
      // dropping it here would remove the only place the user could discover
      // which model that is.
      .map(r => ({ ...r, value: measureValue(r, measure) }))
      .filter(r => r.turns > 0)
      .sort((a, b) => b.value - a.value || b.turns - a.turns)
      .slice(0, 12),
    [rows, measure],
  );

  if (ranked.length === 0) {
    return <div className="py-8 text-center text-sm text-[var(--text-tertiary)]">{emptyLabel}</div>;
  }

  const max = Math.max(...ranked.map(r => r.value));

  return (
    <div className="space-y-2.5">
      {ranked.map(row => {
        const label = labelFor ? labelFor(row) : row.label;
        const unpriced = measure === 'cost' && row.value === 0 && row.unpricedTurns > 0;
        return (
          <div key={row.key}>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm text-[var(--text-secondary)]" title={label}>
                {label}
              </span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="text-sm tabular-nums text-[var(--text-primary)]">
                  {unpriced ? 'unpriced' : formatMeasure(row.value, measure)}
                </span>
                <span className="text-xs tabular-nums text-[var(--text-tertiary)]">
                  {row.turns.toLocaleString()} {row.turns === 1 ? 'turn' : 'turns'}
                </span>
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
              <div
                className="h-full rounded-full"
                style={{
                  width: max > 0 ? `${Math.max(row.value > 0 ? 2 : 0, (row.value / max) * 100)}%` : '0%',
                  backgroundColor: colorForKey(row.key, isDark),
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SystemView() {
  const { isDark } = useTheme();
  const settings = useSettingsStore(s => s.settings);
  const gridIntensity = settings?.usage?.gridIntensityGPerKwh ?? DEFAULT_GRID_INTENSITY_G_PER_KWH;

  const [range, setRange] = useState<RangeKey>('7d');
  const [measure, setMeasure] = useState<Measure>('cost');
  const [dimension, setDimension] = useState<UsageDimension>('agent');
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [powerStatus, setPowerStatus] = useState<{ available: boolean; sources: string[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const activeRange = RANGES.find(r => r.key === range)!;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [result, power] = await Promise.all([
        window.electron.getUsageSummary({
          ...(activeRange.ms ? { startTime: Date.now() - activeRange.ms } : {}),
          bucket: activeRange.bucket,
        }),
        window.electron.getPowerStatus(),
      ]);
      if (result.success && result.summary) setSummary(result.summary);
      if (power.success && power.status) setPowerStatus(power.status);
    } finally {
      setLoading(false);
    }
  }, [activeRange.ms, activeRange.bucket]);

  useEffect(() => { void load(); }, [load]);

  const totals = summary?.totals;

  /**
   * The time series, stacked by provider.
   *
   * Built by re-querying nothing: the series and the provider breakdown come
   * from the same call, so a per-bucket-per-provider split would need a second
   * dimension the IPC does not return. Rather than fake one, the stack is a
   * single series — honest, and the provider split lives in the breakdown
   * below where it is exact.
   */
  const chartData = useMemo(() => {
    if (!summary) return [];
    return summary.series.map(bucket => ({
      key: bucket.label,
      value: measureValue(bucket, measure),
      turns: bucket.turns,
    }));
  }, [summary, measure]);

  /** Housekeeping the app chose to do, as opposed to work the user asked for. */
  const backgroundSpend = useMemo(() => {
    if (!summary) return null;
    const rows = summary.byKind.filter(k => isBackgroundKind(k.key));
    if (rows.length === 0) return null;
    const cost = rows.reduce((sum, r) => sum + r.costUsd, 0);
    const turns = rows.reduce((sum, r) => sum + r.turns, 0);
    return { cost, turns, share: totals && totals.costUsd > 0 ? (cost / totals.costUsd) * 100 : 0 };
  }, [summary, totals]);

  const caveats = totals ? rollupCaveats(totals) : [];
  const hitRate = totals ? cacheHitRate(totals) : null;
  const carbon = totals ? energyToCarbonGrams(totals.energyWh, gridIntensity) : 0;
  const dimensionRows = summary
    ? (summary[DIMENSIONS.find(d => d.key === dimension)!.field] as UsageRollup[])
    : [];

  const axisColor = 'var(--text-tertiary)';

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-[var(--text-secondary)]" />
            <h1 className="text-xl font-semibold text-[var(--text-primary)]">System</h1>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>

        {/* Filters in one row above the charts. */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex gap-1">
            {RANGES.map(r => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={cn(
                  'rounded px-2.5 py-1 text-sm transition-colors',
                  range === r.key
                    ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {MEASURES.map(m => (
              <button
                key={m.key}
                onClick={() => setMeasure(m.key)}
                className={cn(
                  'rounded px-2.5 py-1 text-sm transition-colors',
                  measure === m.key
                    ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && !summary ? (
        <div className="flex flex-1 items-center justify-center text-[var(--text-tertiary)]">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : !totals || totals.turns === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <Gauge className="h-8 w-8 text-[var(--text-tertiary)]" />
          <p className="text-[var(--text-secondary)]">No usage recorded in this range.</p>
          <p className="max-w-md text-sm text-[var(--text-tertiary)]">
            Every inference the app runs — chats, channel turns, workflows, and the
            background work it does on your behalf — is recorded here once it completes.
          </p>
        </div>
      ) : (
        <div className="space-y-6 p-4">
          {/* Headline figures */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Spend"
              value={formatCost(totals.costUsd)}
              sub={`${totals.turns.toLocaleString()} ${totals.turns === 1 ? 'inference' : 'inferences'}`}
              caveat={totals.unpricedTurns > 0
                ? `${totals.unpricedTurns.toLocaleString()} unpriced — this is a floor`
                : null}
            />
            <StatTile
              label="Tokens"
              value={formatTokens(totals.inputTokens + totals.outputTokens)}
              sub={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`}
              caveat={hitRate != null && hitRate > 0
                ? `${hitRate.toFixed(0)}% of input served from cache`
                : null}
            />
            <StatTile
              label="Energy"
              value={formatEnergy(totals.energyWh)}
              sub={formatEnergyRange(totals) ?? energyComparison(totals.energyWh)}
              caveat={totals.energyMeasured
                ? 'measured from hardware counters'
                : 'estimated — cloud energy is not observable from here'}
            />
            <StatTile
              label="CO₂e"
              value={formatCarbon(carbon)}
              sub={`at ${gridIntensity} g/kWh`}
              caveat={totals.energyMeasured ? null : 'inherits the energy estimate’s uncertainty'}
            />
          </div>

          {caveats.length > 0 && (
            <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
              <ul className="space-y-1 text-xs text-[var(--text-secondary)]">
                {caveats.map(note => (
                  <li key={note} className="flex items-start gap-1.5">
                    <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-[var(--text-tertiary)]" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* One measure, one axis. */}
          <section className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
            <h2 className="mb-3 text-sm font-medium text-[var(--text-primary)]">
              {MEASURES.find(m => m.key === measure)!.label} over time
            </h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
                  <CartesianGrid stroke="var(--border-primary)" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="key"
                    tick={{ fill: axisColor, fontSize: 11 }}
                    stroke="var(--border-primary)"
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: axisColor, fontSize: 11 }}
                    stroke="var(--border-primary)"
                    tickLine={false}
                    width={64}
                    tickFormatter={(v: number) => formatMeasure(v, measure)}
                  />
                  <Tooltip
                    cursor={{ fill: 'var(--bg-hover)' }}
                    contentStyle={{
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-primary)',
                      borderRadius: 6,
                      color: 'var(--text-primary)',
                      fontSize: 12,
                    }}
                    formatter={(value) => [
                      formatMeasure(typeof value === 'number' ? value : 0, measure),
                      MEASURES.find(m => m.key === measure)!.label,
                    ]}
                  />
                  {/* Slot 1, fixed. This is a single-series chart: the bars
                      are not competing for identity with anything, so hashing
                      the measure name into a hue would only risk landing on
                      green — which reads as a status colour, and status hues
                      are reserved. */}
                  <Bar
                    dataKey="value"
                    radius={[4, 4, 0, 0]}
                    fill={seriesPalette(isDark)[0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Where it went */}
          <section className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-[var(--text-primary)]">Where it went</h2>
              <div className="flex gap-1">
                {DIMENSIONS.map(d => (
                  <button
                    key={d.key}
                    onClick={() => setDimension(d.key)}
                    className={cn(
                      'rounded px-2 py-0.5 text-xs transition-colors',
                      dimension === d.key
                        ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <BreakdownBars
              rows={dimensionRows}
              measure={measure}
              isDark={isDark}
              emptyLabel={`No ${measure} recorded for this breakdown.`}
              labelFor={dimension === 'kind' ? (row => kindLabel(row.key)) : undefined}
            />
          </section>

          {/* Background spend — the surprising kind */}
          {backgroundSpend && backgroundSpend.turns > 0 && (
            <section className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
              <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                <Zap className="h-4 w-4 text-[var(--text-secondary)]" />
                Work you did not ask for
              </h2>
              <p className="mb-3 text-xs text-[var(--text-tertiary)]">
                Titles, summaries, history compaction and shadow memory. Useful, but it
                runs on its own schedule — and it is the spend people are most often
                surprised by.
              </p>
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <div className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">
                  {formatCost(backgroundSpend.cost)}
                </div>
                <div className="text-sm text-[var(--text-secondary)]">
                  {backgroundSpend.share.toFixed(1)}% of spend
                </div>
                <div className="text-sm text-[var(--text-secondary)]">
                  {backgroundSpend.turns.toLocaleString()} inferences
                </div>
              </div>
            </section>
          )}

          {/* How the energy figures were arrived at */}
          <section className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
            <h2 className="mb-2 text-sm font-medium text-[var(--text-primary)]">About these numbers</h2>
            <ul className="space-y-1.5 text-xs text-[var(--text-secondary)]">
              <li>
                <strong className="text-[var(--text-primary)]">Cost</strong> is the provider's own
                figure where one is reported, and token counts times a price table otherwise.
                Prices change without notice; correct them in Settings ▸ Usage.
              </li>
              <li>
                <strong className="text-[var(--text-primary)]">Cloud energy is an estimate</strong>,
                not a measurement. No API reports the joules a datacenter burned. These figures
                come from published per-token estimates and are shown as ranges because the
                published figures disagree by roughly threefold.
              </li>
              <li>
                <strong className="text-[var(--text-primary)]">Local energy can be measured</strong>
                {' '}on Linux via RAPL and nvidia-smi.{' '}
                {powerStatus?.available
                  ? `Currently sampling (${powerStatus.sources.join(', ')}).`
                  : 'Not currently sampling — enable it in Settings ▸ Usage.'}
              </li>
              <li>
                <strong className="text-[var(--text-primary)]">CO₂e</strong> multiplies energy by a
                grid carbon intensity. The default is a world average, which is wrong for almost
                everyone by up to an order of magnitude — set your region's figure in Settings.
              </li>
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
