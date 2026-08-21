/**
 * Energy and carbon accounting for inference.
 *
 * The honest framing first, because every number this module produces is
 * downstream of it:
 *
 * For a **cloud** turn, the energy is not observable from here. Nothing in the
 * API response says how many joules the datacenter burned, and nobody outside
 * the provider knows the serving hardware, batch size, or utilisation. What we
 * have is a handful of published figures — Google's reported median for a
 * Gemini text prompt, Epoch AI's estimate for GPT-4o, a few academic
 * measurements of open models on known hardware — which agree on the order of
 * magnitude and disagree on nearly everything else. So cloud energy here is an
 * *estimate with a stated range*, and the range is wide on purpose. It is
 * useful for "which of my agents is the expensive one" and for order-of-
 * magnitude awareness. It is not useful for a sustainability report, and the
 * UI must never let it look like one.
 *
 * For a **local** turn, the energy is genuinely measurable — the model runs on
 * hardware we can read counters from. See PowerSampler in the main process.
 * Those figures are marked 'measured' and must never be silently pooled with
 * estimated ones; a total mixing the two is reported as estimated, because a
 * total is only as sound as its weakest term.
 *
 * Every value carries its provenance for exactly that reason.
 */

type EnergyProvenance = 'measured' | 'estimated';

export interface EnergyEstimate {
  /** Point estimate, watt-hours. */
  wh: number;
  /** Low end of the plausible range, watt-hours. */
  whLow: number;
  /** High end of the plausible range, watt-hours. */
  whHigh: number;
  provenance: EnergyProvenance;
}

/**
 * Serving-size classes. Energy per token tracks active parameter count and
 * serving hardware far more than it tracks any published benchmark, so models
 * are bucketed rather than given individual coefficients — a per-model table
 * would imply a precision that does not exist.
 */
export type ModelClass = 'small' | 'medium' | 'large' | 'frontier' | 'local';

/**
 * Watt-hours per 1,000 tokens, split by phase.
 *
 * Prefill (reading the prompt) is heavily parallel and cheap per token;
 * decode (generating) is memory-bandwidth bound and serial, so it costs
 * roughly an order of magnitude more per token. Long-context turns are
 * dominated by prefill purely on volume, which is why the two are separated
 * rather than folded into one per-token figure.
 *
 * `spread` is the multiplicative uncertainty applied in both directions to
 * produce the range. 3 means "somewhere between a third and triple this",
 * which is an accurate statement of how well anyone outside a provider knows
 * these numbers.
 */
interface EnergyCoefficients {
  prefillWhPer1k: number;
  decodeWhPer1k: number;
  spread: number;
}

const COEFFICIENTS: Record<ModelClass, EnergyCoefficients> = {
  // Haiku-class and the mini/flash tiers. Small enough to serve many streams
  // per accelerator.
  small: { prefillWhPer1k: 0.006, decodeWhPer1k: 0.06, spread: 3 },
  medium: { prefillWhPer1k: 0.015, decodeWhPer1k: 0.15, spread: 3 },
  // Sonnet-class and GPT-4o-class. Anchored so a ~500-token answer with a
  // ~2k-token prompt lands near 0.2 Wh, consistent with both Google's reported
  // median and Epoch's GPT-4o estimate.
  large: { prefillWhPer1k: 0.03, decodeWhPer1k: 0.32, spread: 3 },
  // Opus-class. Larger active parameter counts and, for reasoning models, a
  // great many more decode tokens than the visible answer implies.
  frontier: { prefillWhPer1k: 0.06, decodeWhPer1k: 0.7, spread: 3.5 },
  // Only a fallback: a local turn should be measured, not estimated. These are
  // for a consumer GPU when sampling is unavailable, and the spread is wider
  // because "the user's machine" covers a Pi and a threadripper alike.
  local: { prefillWhPer1k: 0.02, decodeWhPer1k: 0.25, spread: 5 },
};

/**
 * Datacenter overhead — cooling, power conversion, networking — as a
 * multiplier on the compute itself. Hyperscalers report fleet-wide PUE around
 * 1.1; the global average is nearer 1.5. Only applied to cloud turns: for a
 * local model the wall measurement already includes the whole machine.
 */
const CLOUD_PUE = 1.15;

/**
 * Grams of CO2e per kWh. The default is roughly the world average grid.
 * Overridable in settings because it is the single input with the widest
 * legitimate variation — a French or Quebecois grid is under 60, an
 * Appalachian one is over 700, and using a world average for either produces
 * a figure that is wrong by an order of magnitude in a knowable direction.
 */
export const DEFAULT_GRID_INTENSITY_G_PER_KWH = 475;

/** Ordered longest-prefix-first so `claude-3-5-haiku` is not read as `claude-3`. */
const CLASS_RULES: Array<[RegExp, ModelClass]> = [
  [/^claude-(3-5-)?haiku|^claude-haiku/, 'small'],
  [/^claude-(fable|mythos|opus)/, 'frontier'],
  [/^claude-sonnet|^claude-3-5-sonnet|^claude-3-sonnet/, 'large'],
  [/^gpt-4o-mini|^o1-mini|^o3-mini|^gpt-3\.5/, 'small'],
  [/^o1$|^o1-|^o3$|^o3-/, 'frontier'],
  [/^gpt-4o|^gpt-4/, 'large'],
  [/^gemini-[\d.]+-flash/, 'small'],
  [/^gemini-[\d.]+-pro/, 'large'],
];

/**
 * Bucket a model into a serving class. Local providers short-circuit: what
 * matters there is whose hardware it ran on, not which family the weights
 * came from.
 */
export function classifyModel(provider: string, model: string): ModelClass {
  if (provider === 'ollama' || provider === 'lmstudio') return 'local';
  for (const [pattern, cls] of CLASS_RULES) {
    if (pattern.test(model)) return cls;
  }
  // Unknown cloud model. 'medium' rather than 'frontier': an unknown model is
  // more often a small or mid-tier one someone wired up themselves than it is
  // a flagship, and overstating every unrecognised model would quietly inflate
  // the whole estimate.
  return 'medium';
}

/**
 * Estimate the energy of one cloud turn from its token counts.
 *
 * Cache reads still cost energy — the tokens are re-read from a KV cache in
 * memory rather than recomputed, which is cheaper but not free. They are
 * counted as prefill at a reduced weight rather than dropped, because dropping
 * them would make a warm-cache agent look like it consumed nothing.
 */
export function estimateTurnEnergy(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
): EnergyEstimate {
  const cls = classifyModel(provider, model);
  const c = COEFFICIENTS[cls];
  const pue = cls === 'local' ? 1 : CLOUD_PUE;

  const prefillWh = ((inputTokens + cachedTokens * 0.2) / 1000) * c.prefillWhPer1k;
  const decodeWh = (outputTokens / 1000) * c.decodeWhPer1k;
  const wh = (prefillWh + decodeWh) * pue;

  return {
    wh,
    whLow: wh / c.spread,
    whHigh: wh * c.spread,
    provenance: 'estimated',
  };
}

/** Convert watt-hours to grams of CO2e at a given grid intensity. */
export function energyToCarbonGrams(wh: number, gridIntensityGPerKwh: number): number {
  return (wh / 1000) * gridIntensityGPerKwh;
}

/**
 * Sum energy across turns.
 *
 * The provenance rule is the point of this function: a total is 'measured'
 * only if every term was. One estimated turn in a thousand measured ones makes
 * the total an estimate, and labelling it otherwise would launder a guess into
 * a fact.
 */
export function sumEnergy(parts: EnergyEstimate[]): EnergyEstimate {
  const total: EnergyEstimate = { wh: 0, whLow: 0, whHigh: 0, provenance: 'measured' };
  if (parts.length === 0) return { ...total, provenance: 'estimated' };
  for (const p of parts) {
    total.wh += p.wh;
    total.whLow += p.whLow;
    total.whHigh += p.whHigh;
    if (p.provenance === 'estimated') total.provenance = 'estimated';
  }
  return total;
}

/**
 * Everyday equivalences, for the one job a raw watt-hour figure does badly:
 * conveying scale to someone who does not think in watt-hours.
 *
 * Deliberately few, and deliberately boring. Equivalences are where energy
 * reporting usually goes wrong — "equal to driving X miles" invites a
 * precision the underlying estimate cannot support, so these are for reading
 * as "about a phone charge", not for quoting.
 */
export function describeEnergy(wh: number): string {
  if (wh < 1) return `${(wh * 1000).toFixed(0)} mWh`;
  if (wh < 1000) return `${wh.toFixed(1)} Wh`;
  return `${(wh / 1000).toFixed(2)} kWh`;
}

/** A typical smartphone battery, for scale. */
export const PHONE_CHARGE_WH = 12;
