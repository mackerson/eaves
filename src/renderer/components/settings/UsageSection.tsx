import { useCallback, useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useSettingsStore, useToastStore } from '@/stores';
import { DEFAULT_GRID_INTENSITY_G_PER_KWH } from '@shared/energy';
import { RotateCcw, TriangleAlert } from 'lucide-react';

/**
 * The inputs to the cost and energy model, made editable.
 *
 * This exists because every table the app ships with is wrong in a way only
 * the user can fix. Provider prices change on the provider's schedule and this
 * app releases on its own; a grid's carbon intensity varies tenfold by region;
 * a proxied or self-hosted endpoint has rates nobody here can know. Leaving
 * those as hardcoded constants does not make them accurate, it just makes them
 * unfixable — and a number the user cannot correct is one they cannot trust.
 */

interface PricingRow {
  key: string;
  provider: string;
  model: string;
  turns: number;
  promptCostPer1M: number | null;
  completionCostPer1M: number | null;
  source: 'user' | 'builtin' | 'local' | 'none';
}

/** Some well-known grids, so the field is not a blank box demanding research. */
const GRID_PRESETS: Array<{ label: string; value: number }> = [
  { label: 'World average', value: 475 },
  { label: 'France (nuclear-heavy)', value: 56 },
  { label: 'Nordics', value: 90 },
  { label: 'EU average', value: 250 },
  { label: 'US average', value: 385 },
  { label: 'Coal-heavy grid', value: 700 },
];

function SourceBadge({ source }: { source: PricingRow['source'] }) {
  if (source === 'user') {
    return <span className="shrink-0 rounded bg-[var(--bg-active)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">yours</span>;
  }
  if (source === 'builtin') {
    return <span className="shrink-0 text-xs text-[var(--text-tertiary)]">built in</span>;
  }
  // Free, not unknown. Runs on the user's own hardware, so its money cost
  // really is zero and no override is needed to make the totals correct.
  if (source === 'local') {
    return <span className="shrink-0 text-xs text-[var(--text-tertiary)]">free (local)</span>;
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--text-secondary)]">
      <TriangleAlert className="h-3 w-3" />
      unpriced
    </span>
  );
}

export function UsageSection() {
  const usage = useSettingsStore(s => s.settings.usage);
  const updateSettings = useSettingsStore(s => s.updateSettings);
  const showToast = useToastStore(s => s.showToast);

  const [pricing, setPricing] = useState<PricingRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { prompt: string; completion: string }>>({});
  const [power, setPower] = useState<{ available: boolean; sources: string[]; platformSupported: boolean } | null>(null);
  const [grid, setGrid] = useState(String(usage?.gridIntensityGPerKwh ?? DEFAULT_GRID_INTENSITY_G_PER_KWH));

  const loadPricing = useCallback(async () => {
    const [result, powerResult] = await Promise.all([
      window.electron.getUsagePricing(),
      window.electron.getPowerStatus(),
    ]);
    if (result.success && result.pricing) setPricing(result.pricing);
    if (powerResult.success && powerResult.status) setPower(powerResult.status);
  }, []);

  useEffect(() => { void loadPricing(); }, [loadPricing]);

  const save = async (patch: Record<string, unknown>) => {
    try {
      await updateSettings({ usage: { ...usage, ...patch } });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed', 'error');
    }
  };

  const commitPrice = async (row: PricingRow) => {
    const draft = drafts[row.key];
    if (!draft) return;

    const prompt = parseFloat(draft.prompt);
    const completion = parseFloat(draft.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) {
      showToast('Both rates must be non-negative numbers', 'error');
      return;
    }

    const overrides = { ...(usage?.pricingOverrides ?? {}) };
    overrides[row.key] = { promptCostPer1M: prompt, completionCostPer1M: completion };
    await save({ pricingOverrides: overrides });
    setDrafts(d => {
      const next = { ...d };
      delete next[row.key];
      return next;
    });
    void loadPricing();
  };

  const clearOverride = async (key: string) => {
    const overrides = { ...(usage?.pricingOverrides ?? {}) };
    delete overrides[key];
    await save({ pricingOverrides: overrides });
    void loadPricing();
  };

  // Only cloud models with no rate. A local model has no rate because it
  // needs none — folding it in here would warn the user that their totals
  // are short by an amount that is genuinely zero.
  const unpriced = pricing.filter(r => r.source === 'none');

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold">Usage accounting</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          What the System view uses to turn tokens into dollars, watt-hours and carbon.
          Nothing here changes how agents run — only how their cost is reported.
        </p>
      </div>

      {/* Pricing */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Model pricing</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            USD per million tokens. Built-in rates ship with the app and go stale; anything you
            set here wins. A price set on an individual agent is narrower still and wins over both.
          </p>
        </div>

        {unpriced.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
            <span className="text-[var(--text-secondary)]">
              {unpriced.length === 1 ? 'One model has' : `${unpriced.length} models have`} no price.
              Their turns are counted but contribute nothing to any spend total, so every figure
              that includes them is a floor. Setting a rate below fixes it from here on.
            </span>
          </div>
        )}

        {pricing.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No models used yet. Rates appear here once agents have run.
          </p>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-2 px-1 text-xs text-[var(--text-tertiary)]">
              <span className="flex-1">Model</span>
              <span className="w-24 text-right">Input</span>
              <span className="w-24 text-right">Output</span>
              <span className="w-20" />
            </div>
            {pricing.map(row => {
              const draft = drafts[row.key];
              const promptValue = draft?.prompt ?? (row.promptCostPer1M?.toString() ?? '');
              const completionValue = draft?.completion ?? (row.completionCostPer1M?.toString() ?? '');
              const dirty = draft != null;

              return (
                <div
                  key={row.key}
                  className="flex flex-wrap items-center gap-2 rounded px-1 py-1.5 hover:bg-[var(--bg-hover)]"
                >
                  <div className="min-w-[12rem] flex-1 basis-full sm:basis-0">
                    <div className="truncate text-sm" title={row.key}>{row.model}</div>
                    <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                      <span className="truncate">{row.provider}</span>
                      <SourceBadge source={row.source} />
                    </div>
                  </div>
                  <Input
                    className="w-24 text-right"
                    inputMode="decimal"
                    placeholder="—"
                    value={promptValue}
                    onChange={e => setDrafts(d => ({
                      ...d,
                      [row.key]: { prompt: e.target.value, completion: completionValue },
                    }))}
                  />
                  <Input
                    className="w-24 text-right"
                    inputMode="decimal"
                    placeholder="—"
                    value={completionValue}
                    onChange={e => setDrafts(d => ({
                      ...d,
                      [row.key]: { prompt: promptValue, completion: e.target.value },
                    }))}
                  />
                  <div className="flex w-20 justify-end gap-1">
                    {dirty && (
                      <Button size="sm" variant="outline" onClick={() => void commitPrice(row)}>
                        Save
                      </Button>
                    )}
                    {!dirty && row.source === 'user' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Revert to the built-in rate"
                        onClick={() => void clearOverride(row.key)}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Carbon */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Grid carbon intensity</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Grams of CO₂e per kilowatt-hour where your electricity comes from — and, for cloud
            models, where the datacenter's does. This is the single widest input in the model: a
            nuclear grid and a coal one differ more than tenfold, so the world-average default is
            wrong for almost everybody.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            className="w-32"
            inputMode="decimal"
            value={grid}
            onChange={e => setGrid(e.target.value)}
            onBlur={() => {
              const value = parseFloat(grid);
              if (Number.isFinite(value) && value >= 0) void save({ gridIntensityGPerKwh: value });
              else setGrid(String(usage?.gridIntensityGPerKwh ?? DEFAULT_GRID_INTENSITY_G_PER_KWH));
            }}
          />
          <span className="text-sm text-muted-foreground">g CO₂e / kWh</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {GRID_PRESETS.map(preset => (
            <button
              key={preset.label}
              className="rounded border border-[var(--border-primary)] px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              onClick={() => { setGrid(String(preset.value)); void save({ gridIntensityGPerKwh: preset.value }); }}
            >
              {preset.label} ({preset.value})
            </button>
          ))}
        </div>
      </section>

      {/* Measured power */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Measure local power draw</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            For models running on this machine, read real power draw instead of estimating it.
            Samples CPU package energy via RAPL and GPU board power via nvidia-smi, once a second,
            and reports each turn's draw above the machine's idle baseline. Linux only — macOS
            requires root for this and Windows requires per-vendor SDKs.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            id="measure-power"
            type="checkbox"
            className="h-4 w-4"
            checked={!!usage?.measureLocalPower}
            disabled={power != null && !power.platformSupported}
            onChange={e => void save({ measureLocalPower: e.target.checked })}
          />
          <Label htmlFor="measure-power" className="cursor-pointer">
            Sample hardware power counters
          </Label>
        </div>
        <p className="text-xs text-[var(--text-tertiary)]">
          {power == null
            ? 'Checking…'
            : !power.platformSupported
              ? 'Not available on this platform — local energy will be estimated.'
              : power.available
                ? `Sampling now via ${power.sources.join(' and ')}.`
                : usage?.measureLocalPower
                  ? 'Enabled, but no readable counters were found. RAPL is root-only on some distributions. Restart the app after changing this.'
                  : 'Off — local energy is estimated. Takes effect on restart.'}
        </p>
      </section>
    </div>
  );
}
