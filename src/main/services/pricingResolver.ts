import { getSettingsRepository } from '../repositories';
import { getModelPricing } from '../../shared/pricing';
import { logger } from './logger';

/**
 * Resolves which price applies to a given (provider, model).
 *
 * Three sources, narrowest first:
 *
 *   1. the agent's own `promptCostPer1M` / `completionCostPer1M`
 *   2. a user override in settings, keyed `"<provider>:<model>"`
 *   3. the built-in table in shared/pricing.ts
 *
 * The ordering is the point. An agent override is a statement about one agent
 * and must beat a statement about every agent using that model, which in turn
 * must beat a table this app shipped with and cannot keep current. Provider
 * prices move on the provider's schedule, not on ours; without layer 2 the
 * only remedy for a stale rate is editing every agent by hand.
 */

export interface ResolvedPricing {
  promptCostPer1M: number;
  completionCostPer1M: number;
  source: 'agent' | 'user' | 'builtin';
}

/**
 * Settings live in SQLite and this is consulted once per inference. One
 * single-row read per LLM call is not worth caching against — but it *is*
 * worth not doing inside a loop, hence the explicit key builder for callers
 * that price many rows at once.
 */
export function pricingKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export function resolvePricing(
  provider: string,
  model: string,
  agentPricing?: { promptCostPer1M?: number | null; completionCostPer1M?: number | null },
): ResolvedPricing | null {
  if (agentPricing?.promptCostPer1M != null || agentPricing?.completionCostPer1M != null) {
    return {
      promptCostPer1M: agentPricing.promptCostPer1M ?? 0,
      completionCostPer1M: agentPricing.completionCostPer1M ?? 0,
      source: 'agent',
    };
  }

  const override = readUserOverrides()[pricingKey(provider, model)];
  if (override) {
    return {
      promptCostPer1M: override.promptCostPer1M,
      completionCostPer1M: override.completionCostPer1M,
      source: 'user',
    };
  }

  const builtin = getModelPricing(provider, model);
  if (!builtin) return null;
  return { ...builtin, source: 'builtin' };
}

/** Every user-set price override, for the settings UI and bulk pricing. */
export function readUserOverrides(): Record<string, { promptCostPer1M: number; completionCostPer1M: number }> {
  try {
    return getSettingsRepository().get().usage?.pricingOverrides ?? {};
  } catch (error) {
    // Pricing must never be the reason a turn fails. An unreadable settings
    // row means "no overrides", which falls back to the built-in table.
    logger.warn('[Pricing] Could not read user price overrides', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}
