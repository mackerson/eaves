import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';
import { MemoryEntryRepository, toFtsMatch } from '../repositories/MemoryEntryRepository';
import { getCoreMemoryBackend, fuseScores } from './CoreMemoryBackend';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./database', () => ({ getDatabase: vi.fn(), isVecAvailable: () => false }));
// Route the backend's repo getter to a fresh repo bound to the per-test DB.
vi.mock('../repositories', () => ({ getMemoryEntryRepository: vi.fn() }));

const backend = getCoreMemoryBackend();

beforeEach(async () => {
  const db = new Database(':memory:');
  runMigrations(db, 0);
  const { getDatabase } = await import('./database');
  vi.mocked(getDatabase).mockReturnValue(db);
  const { getMemoryEntryRepository } = await import('../repositories');
  vi.mocked(getMemoryEntryRepository).mockReturnValue(new MemoryEntryRepository());
});

describe('toFtsMatch', () => {
  it('quotes tokens as prefix terms, OR-joined, neutralizing FTS operators', () => {
    expect(toFtsMatch('daniel webster')).toBe('"daniel"* OR "webster"*');
    expect(toFtsMatch('a OR b')).toBe('"a"* OR "OR"* OR "b"*'); // literal OR token quoted, not an operator
    expect(toFtsMatch('  ')).toBe('');
    expect(toFtsMatch('quote"inside')).toBe('"quote"* OR "inside"*');
  });
});

describe('CoreMemoryBackend contract', () => {
  it('store → retrieve round-trips value + metadata and stamps storedAt/updatedAt', async () => {
    const r = await backend.store({ key: 'k1', value: 'hello world', metadata: { tags: ['t'], agentId: 'a1' } });
    expect(r.success).toBe(true);
    expect(r.storedAt).toBeTypeOf('number');

    const got = await backend.retrieve('k1');
    expect(got).toMatchObject({ success: true, key: 'k1', value: 'hello world' });
    expect(got.metadata?.tags).toEqual(['t']);
    expect(got.metadata?.storedAt).toBe(r.storedAt);
    expect(got.metadata?.updatedAt).toBeTypeOf('number');
  });

  it('upsert preserves the original storedAt on rewrite', async () => {
    const first = await backend.store({ key: 'k', value: 'v1' });
    const second = await backend.store({ key: 'k', value: 'v2' });
    expect(second.storedAt).toBe(first.storedAt);
    const got = await backend.retrieve('k');
    expect(got.value).toBe('v2');
  });

  it('retrieve/delete report misses without throwing', async () => {
    expect(await backend.retrieve('nope')).toMatchObject({ success: false });
    expect(await backend.delete('nope')).toMatchObject({ success: false });
    await backend.store({ key: 'x', value: 'y' });
    expect(await backend.delete('x')).toMatchObject({ success: true });
    expect(await backend.retrieve('x')).toMatchObject({ success: false });
  });

  it('search is FTS-ranked and prefix-matching', async () => {
    await backend.store({ key: 'note-daniel', value: 'Daniel Webster works on beaked whale acoustics' });
    await backend.store({ key: 'note-weather', value: 'marine forecast and almanac copy' });
    const res = await backend.search({ query: 'daniel' });
    expect(res.success).toBe(true);
    expect(res.results.map(r => r.key)).toContain('note-daniel');
    expect(res.results.every(r => r.key !== 'note-weather')).toBe(true);
    expect(res.results[0].matchedOn).toBe('fts');
    expect(res.results[0].score).toBeTypeOf('number');
  });

  it('search filters by tags', async () => {
    await backend.store({ key: 'a', value: 'whale research', metadata: { tags: ['work'] } });
    await backend.store({ key: 'b', value: 'whale watching trip', metadata: { tags: ['personal'] } });
    const res = await backend.search({ query: 'whale', tags: ['work'] });
    expect(res.results.map(r => r.key)).toEqual(['a']);
  });

  it('list is bounded and reports the true total', async () => {
    for (let i = 0; i < 150; i++) await backend.store({ key: `agent:a1:${i}`, value: `v${i}` });
    await backend.store({ key: 'other', value: 'x' });

    const all = await backend.list();
    expect(all.count).toBe(100);          // LIST_CAP — never an unbounded dump
    expect(all.total).toBe(151);          // true count surfaced so callers know it truncated
    expect(all.memories).toHaveLength(100);

    const scoped = await backend.list('agent:a1:*');
    expect(scoped.total).toBe(150);
    expect(scoped.keys.every(k => k.startsWith('agent:a1:'))).toBe(true);
  });

  it('list honors limit + offset for paging (non-overlapping pages, true total)', async () => {
    for (let i = 0; i < 5; i++) await backend.store({ key: `k${i}`, value: `v${i}` });
    const page1 = await backend.list(undefined, { limit: 2, offset: 0 });
    const page2 = await backend.list(undefined, { limit: 2, offset: 2 });
    const page3 = await backend.list(undefined, { limit: 2, offset: 4 });
    expect([page1.count, page2.count, page3.count]).toEqual([2, 2, 1]);
    expect(page1.total).toBe(5);
    // Pages tile the set with no overlap and cover everything.
    const all = new Set([...page1.keys, ...page2.keys, ...page3.keys]);
    expect(all.size).toBe(5);
  });

  it('list glob does not treat literal LIKE metachars as wildcards', async () => {
    await backend.store({ key: '50%_off', value: 'x' });
    await backend.store({ key: '5000ff', value: 'y' });
    const res = await backend.list('50%_*'); // % and _ are literal here; only * is a wildcard
    expect(res.keys).toEqual(['50%_off']);
  });

  it('health reports the live count', async () => {
    await backend.store({ key: 'k', value: 'v' });
    const h = await backend.health();
    expect(h).toMatchObject({ connected: true, status: 'healthy', memoryCount: 1, backend: 'core' });
  });
});

describe('fuseScores (weighted min-max fusion)', () => {
  // bm25 + vector distance are both lower-is-better; helpers keep the intent readable.
  const fts = (o: Record<string, number>) => new Map(Object.entries(o));
  const vec = (o: Record<string, number>) => new Map(Object.entries(o));

  it('preserves a gradient instead of RRF-flattening (top ≫ tail on a small pool)', () => {
    // Same shape as the live 5-memory set: a clear winner should not blur to ~0.03.
    const out = fuseScores(fts({ a: -5, b: -1, c: -0.2 }), vec({ a: 0.1, b: 0.6, c: 0.9 }));
    expect(out[0].key).toBe('a');
    expect(out[0].score).toBeGreaterThan(0.9);        // strong match lands near 1…
    expect(out[out.length - 1].score).toBeLessThan(0.15); // …weak one near 0 (RRF gave ~0.032 vs ~0.033)
  });

  it('single-signal (embedder off) still tops out near 1.0, not scaled by its weight', () => {
    const out = fuseScores(fts({ a: -4, b: -1 }), new Map());
    expect(out.map(h => h.matchedOn)).toEqual(['fts', 'fts']);
    expect(out[0].score).toBeCloseTo(1, 5); // wF renormalizes to 1 when vector is absent
  });

  it('labels overlap vs single-list membership', () => {
    const out = fuseScores(fts({ a: -3, b: -2 }), vec({ a: 0.2, c: 0.4 }));
    const byKey = Object.fromEntries(out.map(h => [h.key, h.matchedOn]));
    expect(byKey).toEqual({ a: 'hybrid', b: 'fts', c: 'vector' });
  });

  it('is semantic-leaning: the vector winner beats a lexical-only winner', () => {
    // a tops FTS, b tops vector; with SEMANTIC_WEIGHT=0.65, b should win.
    const out = fuseScores(fts({ a: -9, b: -1 }), vec({ a: 0.9, b: 0.1 }));
    expect(out[0].key).toBe('b');
  });

  it('empty on no signal', () => {
    expect(fuseScores(new Map(), new Map())).toEqual([]);
  });
});
