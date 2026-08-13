import Database from 'better-sqlite3';
import { getDatabase } from '../services/database';
import { MemoryEntryRow, CountRow } from './row-types';

/**
 * Storage layer for the core default `memory-backend`. Key/value + free-form JSON
 * metadata, with an FTS5 index (`memory_fts`) over value+key for ranked search.
 * The higher-level `CoreMemoryBackend` service maps this onto the
 * MemoryBackendAPI contract.
 */
export class MemoryEntryRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  /** Upsert by key. Preserves original created_at on rewrite; bumps updated_at. */
  upsert(key: string, value: string, metadata: string | null, agentId: string | null): MemoryEntryRow {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memory_entries (key, value, metadata, agent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        metadata = excluded.metadata,
        agent_id = excluded.agent_id,
        updated_at = excluded.updated_at
    `).run(key, value, metadata, agentId, now, now);
    return this.getByKey(key)!;
  }

  getByKey(key: string): MemoryEntryRow | null {
    return (this.db.prepare(`SELECT * FROM memory_entries WHERE key = ?`).get(key) as MemoryEntryRow | undefined) ?? null;
  }

  deleteByKey(key: string): boolean {
    return this.db.prepare(`DELETE FROM memory_entries WHERE key = ?`).run(key).changes > 0;
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) as count FROM memory_entries`).get() as CountRow).count;
  }

  /**
   * List entries whose key matches a `*`-wildcard pattern (glob), bounded by
   * `limit`. Returns the matched slice plus the true total so callers can tell
   * it was truncated — the core store never returns an unbounded full dump.
   */
  listByPattern(pattern: string | undefined, limit: number, offset = 0): { rows: MemoryEntryRow[]; total: number } {
    if (!pattern || pattern === '*') {
      const total = this.count();
      const rows = this.db.prepare(
        `SELECT * FROM memory_entries ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ).all(limit, offset) as MemoryEntryRow[];
      return { rows, total };
    }
    // Glob (`*`) → SQL LIKE (`%`). Escape LIKE metacharacters in the literal
    // portion so a user key containing % or _ isn't treated as a wildcard.
    const like = pattern.replace(/[%_\\]/g, m => `\\${m}`).replace(/\*/g, '%');
    const total = (this.db.prepare(
      `SELECT COUNT(*) as count FROM memory_entries WHERE key LIKE ? ESCAPE '\\'`,
    ).get(like) as CountRow).count;
    const rows = this.db.prepare(
      `SELECT * FROM memory_entries WHERE key LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ).all(like, limit, offset) as MemoryEntryRow[];
    return { rows, total };
  }

  /**
   * Ranked full-text search over value+key via FTS5 (bm25, lower = better).
   * The query is sanitized into a safe MATCH expression (per-token prefix
   * search), so arbitrary user input can't inject FTS5 syntax.
   */
  search(query: string, limit: number): Array<MemoryEntryRow & { score: number }> {
    const match = toFtsMatch(query);
    if (!match) return [];
    try {
      return this.db.prepare(`
        SELECT m.*, bm25(memory_fts) AS score
        FROM memory_fts f
        JOIN memory_entries m ON m.rowid = f.rowid
        WHERE memory_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `).all(match, limit) as Array<MemoryEntryRow & { score: number }>;
    } catch {
      // Defensive: a malformed MATCH shouldn't crash recall. Fall back to empty.
      return [];
    }
  }

  // ── Vector index (sqlite-vec, memory_vec) — hybrid-search support ──────────
  // The vec0 table is created at runtime because its dimensions depend on the
  // active embedder; memory_vec_meta records the bound (signature, dims).

  private vecTableExists(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_vec'`).get();
  }

  getVecMeta(): { signature: string | null; dims: number | null } {
    const row = this.db.prepare(`SELECT signature, dims FROM memory_vec_meta WHERE id = 1`).get() as
      { signature: string | null; dims: number | null } | undefined;
    return { signature: row?.signature ?? null, dims: row?.dims ?? null };
  }

  /**
   * Ensure the vec0 table matches (signature, dims). On a mismatch it rebuilds —
   * dropping all vectors, since embeddings from a different model/space are
   * incomparable. Returns true if it (re)built, so the caller can backfill.
   */
  ensureVecTable(signature: string, dims: number): boolean {
    const meta = this.getVecMeta();
    if (this.vecTableExists() && meta.signature === signature && meta.dims === dims) return false;
    this.db.exec(`DROP TABLE IF EXISTS memory_vec`);
    this.db.exec(`CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[${dims}])`);
    this.db.prepare(
      `INSERT INTO memory_vec_meta (id, signature, dims) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET signature = excluded.signature, dims = excluded.dims`,
    ).run(signature, dims);
    return true;
  }

  private rowidForKey(key: string): number | null {
    const r = this.db.prepare(`SELECT rowid FROM memory_entries WHERE key = ?`).get(key) as { rowid: number } | undefined;
    return r?.rowid ?? null;
  }

  upsertVectorForKey(key: string, embedding: number[]): void {
    if (!this.vecTableExists()) return;
    const rowid = this.rowidForKey(key);
    if (rowid == null) return;
    const buf = Buffer.from(new Float32Array(embedding).buffer);
    this.db.prepare(`DELETE FROM memory_vec WHERE rowid = ?`).run(BigInt(rowid));
    this.db.prepare(`INSERT INTO memory_vec(rowid, embedding) VALUES (?, ?)`).run(BigInt(rowid), buf);
  }

  /** KNN over the vector index → nearest keys with distance (lower = closer). */
  vectorSearch(embedding: number[], limit: number): Array<{ key: string; distance: number }> {
    if (!this.vecTableExists()) return [];
    const buf = Buffer.from(new Float32Array(embedding).buffer);
    return this.db.prepare(`
      SELECT m.key AS key, k.distance AS distance
      FROM (SELECT rowid, distance FROM memory_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?) k
      JOIN memory_entries m ON m.rowid = k.rowid
      ORDER BY k.distance
    `).all(buf, limit) as Array<{ key: string; distance: number }>;
  }

  /** Keys of entries missing a vector (for backfill), newest first. */
  keysNeedingVector(limit: number): string[] {
    const sql = this.vecTableExists()
      ? `SELECT m.key AS key FROM memory_entries m WHERE m.rowid NOT IN (SELECT rowid FROM memory_vec) ORDER BY m.updated_at DESC LIMIT ?`
      : `SELECT key FROM memory_entries ORDER BY updated_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(limit) as Array<{ key: string }>).map(r => r.key);
  }
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression: split on
 * non-word runs, drop empties, and quote each token as a prefix term
 * (`"tok"*`), OR-ed together. OR (not the default implicit AND) so a multi-word
 * query matches on *partial* overlap — "short concise answers" should hit a doc
 * with "concise answers" even without "short". bm25 still ranks docs matching
 * more (and rarer) terms higher, so recall improves without wrecking order.
 * Quoting neutralizes FTS5 operators; `*` gives forgiving prefix matching.
 * Returns '' when there are no usable tokens.
 */
export function toFtsMatch(query: string): string {
  const tokens = query
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"*`);
  return tokens.join(' OR ');
}
