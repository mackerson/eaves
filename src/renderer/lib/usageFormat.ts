import type { UsageRollup } from '@/types';
import { describeEnergy, PHONE_CHARGE_WH } from '@shared/energy';

/**
 * Display helpers for the system view.
 *
 * Kept apart from the components because these encode judgements about honesty
 * rather than layout, and those judgements should be testable and reused
 * identically everywhere a figure appears. The recurring theme: a number whose
 * uncertainty is not shown reads as a measurement, so the formatting is where
 * the caveats get attached rather than being left to whoever writes the JSX.
 */

/**
 * Money, at a precision that matches how small these figures get. Sub-cent
 * amounts are the common case for a single turn, and rounding them to $0.00
 * makes a real cost look like a free one.
 */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(2)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toLocaleString();
}

export function formatEnergy(wh: number): string {
  return describeEnergy(wh);
}

export function formatCarbon(grams: number): string {
  if (grams < 1) return `${(grams * 1000).toFixed(0)} mg`;
  if (grams < 1000) return `${grams.toFixed(1)} g`;
  return `${(grams / 1000).toFixed(2)} kg`;
}

/**
 * Scale, for readers who do not think in watt-hours. Deliberately one
 * comparison and a boring one — "equal to driving X miles" invites a precision
 * these estimates cannot support.
 */
export function energyComparison(wh: number): string | null {
  if (wh < PHONE_CHARGE_WH * 0.1) return null;
  const charges = wh / PHONE_CHARGE_WH;
  if (charges < 1) return `about ${Math.round(charges * 100)}% of a phone charge`;
  if (charges < 100) return `about ${charges.toFixed(charges < 10 ? 1 : 0)} phone charges`;
  return `about ${Math.round(charges).toLocaleString()} phone charges`;
}

/**
 * The caveats attached to a figure, in plain words.
 *
 * Returned as a list rather than baked into the number because the number
 * should stay readable — the honest thing is to show the total *and* say what
 * it is missing, not to refuse to show one or to silently show a floor.
 */
export function rollupCaveats(rollup: UsageRollup): string[] {
  const notes: string[] = [];

  if (rollup.unpricedTurns > 0) {
    notes.push(
      `${rollup.unpricedTurns.toLocaleString()} ${rollup.unpricedTurns === 1 ? 'turn has' : 'turns have'} ` +
      `no pricing data and contribute nothing to this total — it is a floor, not a total`
    );
  }

  if (rollup.partialTurns > 0) {
    notes.push(
      `${rollup.partialTurns.toLocaleString()} ${rollup.partialTurns === 1 ? 'turn' : 'turns'} ` +
      `ended before final usage arrived, so their token counts are floors`
    );
  }

  return notes;
}

/**
 * Render an energy range. A point estimate shown alone implies a precision
 * nobody outside a provider has, so the range travels with it.
 */
export function formatEnergyRange(rollup: UsageRollup): string | null {
  if (rollup.energyMeasured) return null;
  if (rollup.energyWh === 0) return null;
  return `${describeEnergy(rollup.energyLowWh)} – ${describeEnergy(rollup.energyHighWh)}`;
}

/** Cache hit rate as a percentage of all input tokens read. */
export function cacheHitRate(rollup: UsageRollup): number | null {
  const readable = rollup.inputTokens + rollup.cachedTokens;
  if (readable === 0) return null;
  return (rollup.cachedTokens / readable) * 100;
}

/** Human label for a spend `kind`. */
const KIND_LABELS: Record<string, string> = {
  chat: 'Chat',
  channel: 'Channels',
  workflow: 'Workflows',
  compaction: 'History compaction',
  'note-metadata': 'Note metadata',
  'chat-title': 'Conversation titles',
  shadow: 'Shadow memory',
  'transcript-summary': 'Transcript summaries',
  unknown: 'Unattributed',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * Whether a kind is work the user asked for, as opposed to housekeeping the
 * app decided to do. The split is the most actionable thing on the screen:
 * background spend is the kind people are surprised by, and it is also the
 * kind they can switch off.
 */
const FOREGROUND_KINDS = new Set(['chat', 'channel', 'workflow']);

export function isBackgroundKind(kind: string): boolean {
  return !FOREGROUND_KINDS.has(kind);
}
