import type { ModelContextInfo } from '../../shared/providers';

/**
 * Lightweight, dependency-free cache for live-detected model context windows.
 *
 * Kept separate from modelContext.ts (which pulls in provider adapters and the
 * settings repository) so the sync budget path — resolveContextWindow in
 * contextBudget.ts — can read it without dragging Electron/repository imports
 * into unit tests.
 *
 * Each entry carries the endpoint the probe ran against; callers that know
 * which endpoint they're targeting (chat/channel paths after credential
 * resolution) can ask for a strict match, so swapping LM Studio hosts or
 * changing the stored baseURL doesn't serve stale data from another instance.
 */

interface CacheEntry {
  /** null = probed and the model wasn't found / server unreachable. */
  info: ModelContextInfo | null;
  /** Endpoint the probe ran against (undefined for cloud or no-endpoint probes). */
  endpoint?: string;
  at: number;
}

const cache = new Map<string, CacheEntry>();

// Hits live for 5 minutes — local servers can be reloaded with a different
// context length at any time, but probing localhost every message is wasteful.
export const MODEL_CONTEXT_HIT_TTL_MS = 5 * 60 * 1000;
// Negative probes expire fast so a user starting LM Studio mid-session
// recovers within seconds rather than carrying the conservative 4096 default
// for five minutes.
export const MODEL_CONTEXT_MISS_TTL_MS = 30 * 1000;

function key(provider: string, modelId: string): string {
  return `${provider}::${modelId}`;
}

function ttlFor(info: ModelContextInfo | null): number {
  return info ? MODEL_CONTEXT_HIT_TTL_MS : MODEL_CONTEXT_MISS_TTL_MS;
}

/**
 * Read a cached entry. When `endpoint` is provided, returns undefined (miss)
 * if the stored entry's endpoint doesn't match — protects against multi-host
 * setups where two servers loaded the same model at different windows.
 * Returns `null` for a still-fresh cached miss, `undefined` for no-entry /
 * expired / endpoint-mismatch.
 */
export function readModelContextCache(
  provider: string,
  modelId: string,
  endpoint?: string,
): ModelContextInfo | null | undefined {
  const entry = cache.get(key(provider, modelId));
  if (!entry) return undefined;
  if (Date.now() - entry.at > ttlFor(entry.info)) return undefined;
  if (endpoint !== undefined && entry.endpoint !== endpoint) return undefined;
  return entry.info;
}

export function writeModelContextCache(
  provider: string,
  modelId: string,
  info: ModelContextInfo | null,
  endpoint?: string,
): void {
  cache.set(key(provider, modelId), { info, endpoint, at: Date.now() });
}

/** Synchronous read for the budget path. Returns null on miss/expiry/cached-miss. */
export function getCachedModelContext(
  provider: string,
  modelId: string,
  endpoint?: string,
): ModelContextInfo | null {
  return readModelContextCache(provider, modelId, endpoint) ?? null;
}
