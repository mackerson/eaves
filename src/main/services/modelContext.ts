import { getProviderAdapter } from './providers';
import { resolveProviderCredential } from '../utils/providerCredential';
import { readModelContextCache, writeModelContextCache } from './modelContextCache';
import { logger } from './logger';
import type { ModelContextInfo } from '../../shared/providers';

export { getCachedModelContext } from './modelContextCache';

/**
 * Live context-window detection for local models.
 *
 * Cloud models have well-known, fixed context windows (the static table in
 * shared/pricing covers them). Local models served by LM Studio / Ollama do
 * not — the window depends on the checkpoint *and* how the server loaded it,
 * so we ask the running server. Results are cached (see modelContextCache) so
 * the budget path and the agent editor don't re-probe localhost on every
 * message/keystroke.
 */

const inflight = new Map<string, Promise<ModelContextInfo | null>>();

/**
 * Resolve the endpoint we'll probe / look up in the cache for this provider.
 * Threaded into both the cache key match and the budget read so a baseURL
 * change (or a multi-host setup) doesn't serve another instance's window.
 */
export function resolveDetectEndpoint(provider: string, baseURLOverride?: string): string | undefined {
  const { apiKey, baseURL } = resolveProviderCredential(provider, baseURLOverride);
  return baseURL ?? apiKey;
}

/**
 * Detect (or return cached) context-window metadata for a model. Resolves the
 * provider's stored credential itself, dedupes concurrent probes for the same
 * model, and caches both hits and misses (with a shorter TTL for misses so a
 * user starting the server mid-session recovers quickly). Never throws —
 * adapter errors fall through to a cached null.
 */
export async function detectModelContext(
  provider: string,
  modelId: string,
  baseURLOverride?: string,
): Promise<ModelContextInfo | null> {
  if (!provider || !modelId) return null;

  const endpoint = resolveDetectEndpoint(provider, baseURLOverride);

  const cached = readModelContextCache(provider, modelId, endpoint);
  if (cached !== undefined) return cached;

  const cacheKey = `${provider}::${modelId}::${endpoint ?? ''}`;
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const adapter = getProviderAdapter(provider);
  if (!adapter?.detectContext) {
    writeModelContextCache(provider, modelId, null, endpoint);
    return null;
  }

  const probe = (async () => {
    try {
      const { apiKey, baseURL } = resolveProviderCredential(provider, baseURLOverride);
      const info = await adapter.detectContext!(modelId, { apiKey, baseURL });
      writeModelContextCache(provider, modelId, info, endpoint);
      if (info) {
        logger.debug('[modelContext] Detected context window', {
          provider, modelId, endpoint,
          contextWindow: info.contextWindow,
          max: info.maxContextLength,
          loaded: info.loadedContextLength,
        });
      }
      return info;
    } catch (err) {
      // Adapter implementations promise to swallow network errors, but a
      // future adapter (or an unexpected JSON.parse on a non-JSON 5xx body)
      // could still throw. Cache the failure under the short MISS TTL so the
      // next message doesn't pay the connect-timeout latency again.
      logger.debug('[modelContext] probe threw, caching as miss', {
        provider, modelId, endpoint,
        error: err instanceof Error ? err.message : String(err),
      });
      writeModelContextCache(provider, modelId, null, endpoint);
      return null;
    }
  })().finally(() => inflight.delete(cacheKey));

  inflight.set(cacheKey, probe);
  return probe;
}
