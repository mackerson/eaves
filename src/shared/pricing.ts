/**
 * Token pricing per model (USD per 1M tokens).
 * Prices sourced from provider pricing pages.
 * Local models (ollama, lmstudio) are free.
 */

interface ModelPricing {
  promptCostPer1M: number;
  completionCostPer1M: number;
}

const anthropicPricing: Record<string, ModelPricing> = {
  // Claude 5 family
  'claude-fable-5': { promptCostPer1M: 10, completionCostPer1M: 50 },
  'claude-mythos-5': { promptCostPer1M: 10, completionCostPer1M: 50 },
  'claude-opus-5': { promptCostPer1M: 5, completionCostPer1M: 25 },
  // Sonnet 5 carries a reduced introductory rate ($2/$10) through 2026-08-31.
  // The standard rate is listed instead: a date-bounded discount encoded here
  // would silently overstate cost the day it lapses, and overstating today is
  // the safer direction for a number people budget against.
  'claude-sonnet-5': { promptCostPer1M: 3, completionCostPer1M: 15 },
  // Claude 4.6-4.8 — note these are NOT priced like Opus 4.0 below.
  'claude-opus-4-8': { promptCostPer1M: 5, completionCostPer1M: 25 },
  'claude-opus-4-7': { promptCostPer1M: 5, completionCostPer1M: 25 },
  'claude-opus-4-6': { promptCostPer1M: 5, completionCostPer1M: 25 },
  'claude-sonnet-4-6': { promptCostPer1M: 3, completionCostPer1M: 15 },
  'claude-haiku-4-5': { promptCostPer1M: 1, completionCostPer1M: 5 },
  // Claude 4.x / Opus
  'claude-opus-4-20250514': { promptCostPer1M: 15, completionCostPer1M: 75 },
  'claude-opus-4-1-20250805': { promptCostPer1M: 15, completionCostPer1M: 75 },
  'claude-opus-4-5-20251101': { promptCostPer1M: 5, completionCostPer1M: 25 },
  'claude-sonnet-4-5-20250929': { promptCostPer1M: 3, completionCostPer1M: 15 },
  'claude-sonnet-4-20250514': { promptCostPer1M: 3, completionCostPer1M: 15 },
  // Claude 3.5
  'claude-3-5-sonnet-20241022': { promptCostPer1M: 3, completionCostPer1M: 15 },
  'claude-3-5-sonnet-20240620': { promptCostPer1M: 3, completionCostPer1M: 15 },
  'claude-3-5-haiku-20241022': { promptCostPer1M: 0.80, completionCostPer1M: 4 },
  // Claude 3
  'claude-3-opus-20240229': { promptCostPer1M: 15, completionCostPer1M: 75 },
  'claude-3-sonnet-20240229': { promptCostPer1M: 3, completionCostPer1M: 15 },
  'claude-3-haiku-20240307': { promptCostPer1M: 0.25, completionCostPer1M: 1.25 },
};

const openaiPricing: Record<string, ModelPricing> = {
  // GPT-4o
  'gpt-4o': { promptCostPer1M: 2.50, completionCostPer1M: 10 },
  'gpt-4o-2024-11-20': { promptCostPer1M: 2.50, completionCostPer1M: 10 },
  'gpt-4o-mini': { promptCostPer1M: 0.15, completionCostPer1M: 0.60 },
  // GPT-4 Turbo
  'gpt-4-turbo': { promptCostPer1M: 10, completionCostPer1M: 30 },
  'gpt-4-turbo-preview': { promptCostPer1M: 10, completionCostPer1M: 30 },
  // GPT-4
  'gpt-4': { promptCostPer1M: 30, completionCostPer1M: 60 },
  // GPT-3.5
  'gpt-3.5-turbo': { promptCostPer1M: 0.50, completionCostPer1M: 1.50 },
  // o1 / o3
  'o1': { promptCostPer1M: 15, completionCostPer1M: 60 },
  'o1-mini': { promptCostPer1M: 3, completionCostPer1M: 12 },
  'o3-mini': { promptCostPer1M: 1.10, completionCostPer1M: 4.40 },
};

const googlePricing: Record<string, ModelPricing> = {
  // Gemini 2.5
  'gemini-2.5-pro': { promptCostPer1M: 1.25, completionCostPer1M: 10 },
  'gemini-2.5-flash': { promptCostPer1M: 0.15, completionCostPer1M: 0.60 },
  // Gemini 2.0
  'gemini-2.0-flash': { promptCostPer1M: 0.10, completionCostPer1M: 0.40 },
  // Gemini 1.5
  'gemini-1.5-pro': { promptCostPer1M: 1.25, completionCostPer1M: 5 },
  'gemini-1.5-flash': { promptCostPer1M: 0.075, completionCostPer1M: 0.30 },
};

const pricingByProvider: Record<string, Record<string, ModelPricing>> = {
  anthropic: anthropicPricing,
  openai: openaiPricing,
  google: googlePricing,
};

/**
 * Look up pricing for a given provider + model.
 * Tries exact match first, then prefix match for versioned model names.
 */
export function getModelPricing(provider: string, model: string): ModelPricing | null {
  const providerTable = pricingByProvider[provider];
  if (!providerTable) return null;

  // Exact match
  if (providerTable[model]) return providerTable[model];

  // Alias match: "claude-3-5-sonnet-latest" → "claude-3-5-sonnet-20241022".
  //
  // The remainder after the base name must be a date stamp or "latest" — a
  // bare `startsWith` is not safe here, because model families extend their
  // own names. `claude-opus-4-8` starts with `claude-opus-4`, so the old
  // prefix rule silently priced Opus 4.8 at Opus 4.0's $15/$75 instead of
  // $5/$25 — a 3x overstatement presented as a real number. A wrong price is
  // worse than no price: an absent one is visible, an inflated one is not.
  for (const [key, pricing] of Object.entries(providerTable)) {
    const baseKey = key.replace(/-\d{8}$/, '');
    if (!model.startsWith(baseKey)) continue;
    const remainder = model.slice(baseKey.length);
    if (remainder === '' || /^-(\d{8}|latest)$/.test(remainder)) return pricing;
  }

  return null;
}

/**
 * Calculate cost in USD from token counts and model info.
 * Agent-level pricing overrides take precedence over the built-in table.
 * Returns null if pricing is unavailable (local models, unknown models without overrides).
 */
export function calculateCost(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  agentPricing?: { promptCostPer1M?: number; completionCostPer1M?: number },
): number | null {
  // Agent-level overrides take precedence
  const pricing = (agentPricing?.promptCostPer1M != null || agentPricing?.completionCostPer1M != null)
    ? {
        promptCostPer1M: agentPricing.promptCostPer1M ?? 0,
        completionCostPer1M: agentPricing.completionCostPer1M ?? 0,
      }
    : getModelPricing(provider, model);

  if (!pricing) return null;

  const promptCost = (promptTokens / 1_000_000) * pricing.promptCostPer1M;
  const completionCost = (completionTokens / 1_000_000) * pricing.completionCostPer1M;
  return promptCost + completionCost;
}

/** Known context window sizes by model prefix. */
const contextWindows: Record<string, number> = {
  'claude-opus-4': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o3-mini': 200_000,
  // Google Gemini
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  'gemini-1.5-pro': 2_097_152,
  'gemini-1.5-flash': 1_048_576,
};

/**
 * Get context window size for a model. Returns null if unknown.
 */
export function getContextWindow(model: string): number | null {
  // Exact match
  if (contextWindows[model]) return contextWindows[model];

  // Prefix match
  for (const [prefix, size] of Object.entries(contextWindows)) {
    if (model.startsWith(prefix)) return size;
  }

  return null;
}
