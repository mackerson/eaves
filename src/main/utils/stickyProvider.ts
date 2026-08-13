import type { MessageMetrics } from '../../shared/types';

/**
 * Sticky-provider resolution for OpenRouter prompt-cache continuity.
 *
 * Returns the upstream backend (e.g. 'GMICloud') that served the most recent
 * assistant turn in this conversation, so the next request can prefer that same
 * backend and keep the prompt cache warm. OpenRouter otherwise load-balances
 * across backends, and caches don't transfer between them — so without this,
 * every turn re-primes the cache and pays full freight on the prompt.
 *
 * Returns undefined for non-OpenRouter agents, or when no prior assistant turn
 * recorded a served provider (e.g. the first turn). The pin is applied softly
 * (allow_fallbacks: true) in ai.ts, so a stale or missing pin never blocks a
 * request — it just means an occasional cold turn, and the next turn re-pins to
 * whoever actually served.
 */
export function resolveStickyProvider(
  messages: ReadonlyArray<{ senderType?: string; metrics?: MessageMetrics | null }>,
  provider: string,
): string | undefined {
  if (provider !== 'openrouter') return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.senderType === 'agent' && m.metrics?.servedProvider) {
      return m.metrics.servedProvider;
    }
  }
  return undefined;
}
