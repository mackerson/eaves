import { getMemoryEntryRepository, getSettingsRepository } from '../repositories';
import { getServiceRegistry, ServiceAPI } from './ServiceRegistry';
import { logger } from './logger';
import { resolveEmbedder, type Embedder } from './embeddings';
import { isVecAvailable } from './database';
import type {
  MemoryBackendAPI,
  MemoryStoreParams,
  MemoryStoreResult,
  MemoryRetrieveResult,
  MemorySearchParams,
  MemorySearchResponse,
  MemoryListResult,
  MemoryDeleteResult,
  MemoryMetadata,
  MemoryEntry,
} from '../../shared/types';
import type { MemoryEntryRow } from '../repositories/row-types';

/**
 * Core default `memory-backend` — a SQLite + FTS5 implementation of the
 * MemoryBackendAPI contract that ships in-process (no plugin, no external
 * service). Registered as the overridable *fallback* floor at startup: it's the
 * memory store when no plugin backend is present, and any real plugin backend
 * (openmemory, an Obsidian-via-MCP bridge, …) takes over when registered.
 * Storage layer: `MemoryEntryRepository`.
 */

/** Default and hard-max `list` page size — the core store never returns an unbounded dump. */
const LIST_CAP = 100;
const MAX_LIST_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 10;
const CORE_BACKEND_ID = 'core';

/** Semantic-vs-lexical weight when BOTH signals fire. Semantic-leaning because
 *  recall is the point of memory search; FTS is the exact-token backstop. */
const SEMANTIC_WEIGHT = 0.65;

export interface FusedHit { key: string; score: number; matchedOn: 'hybrid' | 'vector' | 'fts' }

/** Min-max to [0,1]. All-equal (incl. a single item) → all 1.0 (equally good). */
function minMaxNormalize(m: Map<string, number>): Map<string, number> {
  if (m.size === 0) return m;
  const vals = [...m.values()];
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min;
  const out = new Map<string, number>();
  for (const [k, v] of m) out.set(k, span === 0 ? 1 : (v - min) / span);
  return out;
}

/**
 * Weighted min-max score fusion. Each signal is normalized to [0,1] within the
 * candidate pool (higher = better), then combined. Unlike reciprocal-rank
 * fusion — which keeps only rank and, on a small corpus, collapses every hit
 * into a ~0.03 blur — this preserves the *gradient*: a strong match scores near
 * 1, a weak one near 0, so the returned score reflects real relative confidence.
 *
 * NB: min-max is intra-query relative, not cross-query calibrated. The pool's
 * best item always lands near 1.0, so the absolute score is NOT a relevance
 * threshold (an off-topic query still has a "top" hit near 1.0). Use it for
 * ordering and for confidence *within* one result set, never as a `score > X`
 * gate across queries.
 */
export function fuseScores(
  ftsScore: Map<string, number>,   // bm25, lower = better
  vecDist: Map<string, number>,    // vector distance, lower = closer
): FusedHit[] {
  const hasFts = ftsScore.size > 0;
  const hasVec = vecDist.size > 0;
  // Renormalize weights onto whichever signals actually fired, so a single-signal
  // query still tops out near 1.0 instead of being scaled down by its weight.
  const wV = hasVec ? (hasFts ? SEMANTIC_WEIGHT : 1) : 0;
  const wF = hasFts ? (hasVec ? 1 - SEMANTIC_WEIGHT : 1) : 0;

  // Flip lower-is-better signals to higher-is-better before normalizing.
  const normFts = minMaxNormalize(new Map([...ftsScore].map(([k, v]) => [k, -v])));
  const normVec = minMaxNormalize(new Map([...vecDist].map(([k, v]) => [k, -v])));

  const keys = new Set([...ftsScore.keys(), ...vecDist.keys()]);
  return [...keys].map(key => {
    const inFts = ftsScore.has(key), inVec = vecDist.has(key);
    const score = wV * (normVec.get(key) ?? 0) + wF * (normFts.get(key) ?? 0);
    const matchedOn: FusedHit['matchedOn'] = inFts && inVec ? 'hybrid' : inVec ? 'vector' : 'fts';
    return { key, score, matchedOn };
  }).sort((a, b) => b.score - a.score);
}

function parseMetadata(raw: string | null): MemoryMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function rowToEntry(row: MemoryEntryRow): MemoryEntry {
  return { key: row.key, value: row.value, metadata: parseMetadata(row.metadata) };
}

class CoreMemoryBackend implements MemoryBackendAPI {
  private get repo() {
    return getMemoryEntryRepository();
  }

  async store({ key, value, metadata = {} }: MemoryStoreParams): Promise<MemoryStoreResult> {
    if (!key || value === undefined || value === null) {
      return { success: false, key, message: 'key and value are required' };
    }
    const existing = this.repo.getByKey(key);
    const storedAt = existing ? parseMetadata(existing.metadata).storedAt ?? Date.now() : Date.now();
    const updatedAt = Date.now();
    const merged: MemoryMetadata = { ...metadata, storedAt, updatedAt };
    const agentId = typeof merged.agentId === 'string' ? merged.agentId : null;

    this.repo.upsert(key, String(value), JSON.stringify(merged), agentId);
    // Embed asynchronously — the write (and FTS) is durable immediately; the
    // vector backfills in the background so a store never blocks on an API call.
    void this.embedKey(key, String(value));
    return { success: true, key, message: 'Memory stored', storedAt };
  }

  /** Resolve the active embedder from settings (null ⇒ semantic search off). */
  private activeEmbedder(): Embedder | null {
    if (!isVecAvailable()) return null;
    return resolveEmbedder(getSettingsRepository().get());
  }

  /** Embed one entry into the vector index (best-effort). */
  private async embedKey(key: string, value: string): Promise<void> {
    const embedder = this.activeEmbedder();
    if (!embedder) return;
    try {
      const [vec] = await embedder.embed([value]);
      if (!vec?.length) return;
      this.repo.ensureVecTable(embedder.signature, vec.length);
      this.repo.upsertVectorForKey(key, vec);
    } catch (err) {
      logger.debug('[CoreMemoryBackend] embed failed (non-fatal)', { key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Embed entries missing a vector, in batches. Run on enable / embedder change
   * / startup. Bounded per call so it's resumable. Returns how many it embedded.
   */
  async backfillVectors(max = 200): Promise<number> {
    const embedder = this.activeEmbedder();
    if (!embedder) return 0;
    let done = 0;
    while (done < max) {
      const keys = this.repo.keysNeedingVector(Math.min(32, max - done));
      if (keys.length === 0) break;
      const rows = keys.map(k => this.repo.getByKey(k)).filter((r): r is MemoryEntryRow => !!r);
      try {
        const vecs = await embedder.embed(rows.map(r => r.value));
        if (vecs[0]?.length) this.repo.ensureVecTable(embedder.signature, vecs[0].length);
        rows.forEach((r, i) => { if (vecs[i]?.length) this.repo.upsertVectorForKey(r.key, vecs[i]); });
        done += rows.length;
      } catch (err) {
        logger.warn('[CoreMemoryBackend] backfill batch failed, stopping', { error: err instanceof Error ? err.message : String(err) });
        break;
      }
    }
    if (done > 0) logger.info(`[CoreMemoryBackend] backfilled ${done} vector(s) via ${embedder.signature}`);
    return done;
  }

  async retrieve(key: string): Promise<MemoryRetrieveResult> {
    const row = this.repo.getByKey(key);
    if (!row) return { success: false, key, message: 'Memory not found' };
    return { success: true, key, value: row.value, metadata: parseMetadata(row.metadata) };
  }

  async search({ query, limit = DEFAULT_SEARCH_LIMIT, tags }: MemorySearchParams): Promise<MemorySearchResponse> {
    if (!query) return { success: false, query: query ?? '', count: 0, results: [], message: 'query is required' };

    // Candidate pool from each signal (over-fetch so fusion + tag-filter can reach `limit`).
    const pool = Math.max(limit * 4, 40);
    const ftsRows = this.repo.search(query, pool);
    const ftsScore = new Map(ftsRows.map(r => [r.key, r.score])); // bm25, lower = better

    // Vector (semantic) signal — only when an embedder is configured + loadable.
    const vecDist = new Map<string, number>(); // sqlite-vec distance, lower = closer
    const embedder = this.activeEmbedder();
    if (embedder) {
      try {
        const [qVec] = await embedder.embed([query]);
        if (qVec?.length) {
          for (const h of this.repo.vectorSearch(qVec, pool)) vecDist.set(h.key, h.distance);
        }
      } catch (err) {
        logger.debug('[CoreMemoryBackend] vector search failed; FTS only', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Weighted min-max fusion — preserves the similarity gradient RRF discarded.
    const scored = fuseScores(ftsScore, vecDist);

    const results: MemorySearchResponse['results'] = [];
    for (const s of scored) {
      const row = this.repo.getByKey(s.key);
      if (!row) continue;
      const meta = parseMetadata(row.metadata);
      if (tags?.length && !tags.some(t => (meta.tags ?? []).includes(t))) continue;
      results.push({ key: s.key, value: row.value, metadata: meta, score: s.score, matchedOn: s.matchedOn });
      if (results.length >= limit) break;
    }
    return { success: true, query, count: results.length, results };
  }

  async list(pattern?: string, options?: { limit?: number; offset?: number }): Promise<MemoryListResult> {
    const limit = Math.min(Math.max(options?.limit ?? LIST_CAP, 1), MAX_LIST_LIMIT);
    const offset = Math.max(options?.offset ?? 0, 0);
    const { rows, total } = this.repo.listByPattern(pattern, limit, offset);
    const memories: MemoryEntry[] = rows.map(rowToEntry);
    return { success: true, count: memories.length, keys: memories.map(m => m.key), memories, total };
  }

  async delete(key: string): Promise<MemoryDeleteResult> {
    const deleted = this.repo.deleteByKey(key);
    return deleted
      ? { success: true, key, message: 'Memory deleted' }
      : { success: false, key, message: 'Memory not found' };
  }

  async health(): Promise<{ connected: boolean; status: string; [key: string]: unknown }> {
    return { connected: true, status: 'healthy', memoryCount: this.repo.count(), backend: CORE_BACKEND_ID };
  }
}

let instance: CoreMemoryBackend | null = null;

/** The singleton core backend (for direct use / tests). */
export function getCoreMemoryBackend(): MemoryBackendAPI {
  if (!instance) instance = new CoreMemoryBackend();
  return instance;
}

/** Backfill missing vectors on the core backend (config change / startup). */
export function backfillCoreVectors(max?: number): Promise<number> {
  const b = getCoreMemoryBackend() as unknown as { backfillVectors(max?: number): Promise<number> };
  return b.backfillVectors(max);
}

/**
 * Register the core backend as the fallback `memory-backend` provider. Call once
 * at startup, BEFORE plugins load, so a plugin backend still overrides it (see
 * the `isFallback` handling in ServiceRegistry).
 */
export function registerCoreMemoryBackend(): void {
  getServiceRegistry().register(CORE_BACKEND_ID, 'memory-backend', getCoreMemoryBackend() as unknown as ServiceAPI, {
    version: '1.0',
    features: ['metadata', 'tags', 'text-search', 'fts', 'pattern-filter'],
    isFallback: true,
    description: 'Core default memory backend (SQLite + FTS5)',
  });
  logger.info('[CoreMemoryBackend] Registered as fallback memory-backend provider');
}
