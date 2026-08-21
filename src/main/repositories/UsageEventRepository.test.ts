import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations } from '../services/migrations';
import { UsageEventRepository, CreateUsageEventInput } from './UsageEventRepository';

let db: Database.Database;
let repo: UsageEventRepository;

const BASE: CreateUsageEventInput = {
  timestamp: 1_700_000_000_000,
  agentId: 'a-1',
  agentName: 'Atlas',
  projectId: null,
  containerId: 'c-1',
  kind: 'chat',
  provider: 'anthropic',
  model: 'claude-opus-5',
  inputTokens: 1000,
  outputTokens: 500,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.02,
  costBasis: 'estimated',
  energyWh: 0.2,
  energyLowWh: 0.1,
  energyHighWh: 0.6,
  energyBasis: 'estimated',
  durationMs: 4000,
  usageIsTotal: true,
};

const add = (overrides: Partial<CreateUsageEventInput> = {}) => repo.create({ ...BASE, ...overrides });

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, 0);
  repo = new UsageEventRepository(db);
});

describe('UsageEventRepository: totals', () => {
  it('sums tokens and cost across rows', () => {
    add();
    add({ costUsd: 0.03, inputTokens: 2000, outputTokens: 1000 });

    const totals = repo.totals();
    expect(totals.turns).toBe(2);
    expect(totals.inputTokens).toBe(3000);
    expect(totals.outputTokens).toBe(1500);
    expect(totals.costUsd).toBeCloseTo(0.05);
  });

  // The distinction the whole schema exists to preserve: an unknown price is
  // not zero dollars. SUM skips the NULL, and the count of skipped rows is
  // what lets a UI say "plus N unpriced" instead of presenting a floor.
  it('excludes unpriced rows from the total and counts them separately', () => {
    add({ costUsd: 0.02, costBasis: 'estimated' });
    add({ costUsd: null, costBasis: 'unknown' });

    const totals = repo.totals();
    expect(totals.costUsd).toBeCloseTo(0.02);
    expect(totals.turns).toBe(2);
    expect(totals.unpricedTurns).toBe(1);
  });

  // A local turn is genuinely free, which is a different fact from unpriced
  // and must not inflate the unpriced count.
  it('treats a zero-cost local turn as priced', () => {
    add({ provider: 'ollama', model: 'llama3', costUsd: 0, costBasis: 'local' });
    expect(repo.totals().unpricedTurns).toBe(0);
  });

  // A turn that ended before the SDK's summed usage arrived reports a floor.
  it('counts turns whose usage never settled', () => {
    add({ usageIsTotal: true });
    add({ usageIsTotal: false });
    expect(repo.totals().partialTurns).toBe(1);
  });

  it('reports an empty slice as zero rather than throwing', () => {
    const totals = repo.totals();
    expect(totals.turns).toBe(0);
    expect(totals.costUsd).toBe(0);
    // Nothing measured, so nothing to claim was measured.
    expect(totals.energyMeasured).toBe(false);
  });
});

describe('UsageEventRepository: energy provenance', () => {
  it('marks a bucket measured only when every row in it was', () => {
    add({ energyBasis: 'measured' });
    expect(repo.totals().energyMeasured).toBe(true);

    add({ energyBasis: 'estimated' });
    expect(repo.totals().energyMeasured).toBe(false);
  });

  it('treats a missing basis as estimated', () => {
    add({ energyBasis: null });
    expect(repo.totals().energyMeasured).toBe(false);
  });

  it('carries both bounds through the sum', () => {
    add({ energyWh: 1, energyLowWh: 0.5, energyHighWh: 2 });
    add({ energyWh: 3, energyLowWh: 1.5, energyHighWh: 6 });

    const totals = repo.totals();
    expect(totals.energyWh).toBeCloseTo(4);
    expect(totals.energyLowWh).toBeCloseTo(2);
    expect(totals.energyHighWh).toBeCloseTo(8);
  });
});

describe('UsageEventRepository: breakdowns', () => {
  it('groups by agent id, not by name', () => {
    // Two different agents that happen to share a name are two rows.
    add({ agentId: 'a-1', agentName: 'Researcher', costUsd: 0.01 });
    add({ agentId: 'a-2', agentName: 'Researcher', costUsd: 0.02 });

    const rows = repo.breakdown('agent');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.key).sort()).toEqual(['a-1', 'a-2']);
  });

  it('orders by cost, largest first', () => {
    add({ provider: 'anthropic', costUsd: 0.01 });
    add({ provider: 'openai', costUsd: 0.05 });

    expect(repo.breakdown('provider').map(r => r.key)).toEqual(['openai', 'anthropic']);
  });

  // The ledger outlives the agent it names — that is why agent_name is
  // snapshotted rather than joined. Deleting an agent must not erase what it
  // spent, nor collapse it into a nameless bucket.
  it('keeps a deleted agent\'s spend under its recorded name', () => {
    add({ agentId: 'gone', agentName: 'Departed', costUsd: 0.07 });
    // No agents row was ever created for 'gone' — there is no FK to violate.
    const row = repo.breakdown('agent').find(r => r.key === 'gone');
    expect(row?.label).toBe('Departed');
    expect(row?.costUsd).toBeCloseTo(0.07);
  });

  it('buckets unattributed spend rather than dropping it', () => {
    add({ agentId: null, agentName: null });
    const row = repo.breakdown('agent')[0];
    expect(row.key).toBe('unattributed');
    expect(row.label).toBe('Unattributed');
  });

  it('labels a project by name and survives the project being gone', () => {
    db.prepare("INSERT INTO projects (id, name, description, created_at) VALUES ('p-1','Edge Inference','',1)").run();
    add({ projectId: 'p-1', costUsd: 0.03 });
    add({ projectId: 'p-vanished', costUsd: 0.04 });
    add({ projectId: null, costUsd: 0.01 });

    const rows = repo.breakdown('project');
    expect(rows.find(r => r.key === 'p-1')?.label).toBe('Edge Inference');
    // LEFT JOIN, so a row pointing at a project that no longer exists still
    // appears — under its id rather than vanishing from the breakdown.
    expect(rows.find(r => r.key === 'p-vanished')?.label).toBe('p-vanished');
    expect(rows.find(r => r.key === 'none')?.label).toBe('No project');
  });

  it('separates the kinds of work that spent the money', () => {
    add({ kind: 'chat', costUsd: 0.05 });
    add({ kind: 'shadow', costUsd: 0.01 });
    add({ kind: 'compaction', costUsd: 0.02 });

    expect(repo.breakdown('kind').map(r => r.key)).toEqual(['chat', 'compaction', 'shadow']);
  });
});

describe('UsageEventRepository: filtering', () => {
  it('applies the same filter to totals and breakdowns', () => {
    add({ timestamp: 1000, costUsd: 0.01 });
    add({ timestamp: 5000, costUsd: 0.02 });

    const filter = { startTime: 4000 };
    expect(repo.totals(filter).turns).toBe(1);
    // A header that disagrees with the chart under it reads as broken
    // accounting, so both must be served by the same WHERE.
    const breakdownTotal = repo.breakdown('provider', filter).reduce((s, r) => s + r.costUsd, 0);
    expect(breakdownTotal).toBeCloseTo(repo.totals(filter).costUsd);
  });

  it('filters by project, agent, provider and kind', () => {
    add({ projectId: 'p-1', agentId: 'a-1', provider: 'anthropic', kind: 'chat' });
    add({ projectId: 'p-2', agentId: 'a-2', provider: 'openai', kind: 'shadow' });

    expect(repo.totals({ projectId: 'p-1' }).turns).toBe(1);
    expect(repo.totals({ agentId: 'a-2' }).turns).toBe(1);
    expect(repo.totals({ provider: 'openai' }).turns).toBe(1);
    expect(repo.totals({ kinds: ['shadow'] }).turns).toBe(1);
    expect(repo.totals({ kinds: ['chat', 'shadow'] }).turns).toBe(2);
  });
});

describe('UsageEventRepository: series', () => {
  it('buckets by day in local time, oldest first', () => {
    // Two points a week apart, well away from a midnight boundary.
    const day = 24 * 60 * 60 * 1000;
    const noon = new Date(2024, 0, 15, 12, 0, 0).getTime();
    add({ timestamp: noon });
    add({ timestamp: noon + 7 * day });

    const series = repo.series('day');
    expect(series).toHaveLength(2);
    expect(series[0].key < series[1].key).toBe(true);
  });

  // Bucketing in UTC would put an evening turn into tomorrow for anyone west
  // of Greenwich, so "today" in this view would disagree with the sidebar.
  it('puts a late-evening local turn in the local day', () => {
    const lateEvening = new Date(2024, 5, 10, 23, 30, 0);
    add({ timestamp: lateEvening.getTime() });
    expect(repo.series('day')[0].key).toBe('2024-06-10');
  });

  it('collapses same-day turns into one bucket', () => {
    const morning = new Date(2024, 2, 3, 9, 0, 0).getTime();
    add({ timestamp: morning, costUsd: 0.01 });
    add({ timestamp: morning + 3 * 60 * 60 * 1000, costUsd: 0.02 });

    const series = repo.series('day');
    expect(series).toHaveLength(1);
    expect(series[0].turns).toBe(2);
    expect(series[0].costUsd).toBeCloseTo(0.03);
  });

  it('splits the same turns across hourly buckets', () => {
    const morning = new Date(2024, 2, 3, 9, 0, 0).getTime();
    add({ timestamp: morning });
    add({ timestamp: morning + 3 * 60 * 60 * 1000 });
    expect(repo.series('hour')).toHaveLength(2);
  });
});

describe('UsageEventRepository: rows', () => {
  it('round-trips a row through storage', () => {
    const created = add({ servedProvider: 'GMICloud', cachedTokens: 900, cacheWriteTokens: 100 });
    const [read] = repo.list();

    expect(read.id).toBe(created.id);
    expect(read.servedProvider).toBe('GMICloud');
    expect(read.cachedTokens).toBe(900);
    expect(read.cacheWriteTokens).toBe(100);
    expect(read.usageIsTotal).toBe(true);
    expect(read.costBasis).toBe('estimated');
  });

  it('preserves a null cost as null rather than zero', () => {
    add({ costUsd: null, costBasis: 'unknown' });
    expect(repo.list()[0].costUsd).toBeNull();
  });

  it('lists newest first and paginates', () => {
    add({ timestamp: 1000 });
    add({ timestamp: 2000 });
    add({ timestamp: 3000 });

    expect(repo.list().map(e => e.timestamp)).toEqual([3000, 2000, 1000]);
    expect(repo.list({ limit: 2 }).map(e => e.timestamp)).toEqual([3000, 2000]);
    // OFFSET without LIMIT is a syntax error in SQLite unless a limit is
    // supplied; the repository fills in -1.
    expect(repo.list({ offset: 2 }).map(e => e.timestamp)).toEqual([1000]);
  });

  it('reports the distinct models actually used, most-used first', () => {
    add({ provider: 'anthropic', model: 'claude-opus-5' });
    add({ provider: 'anthropic', model: 'claude-opus-5' });
    add({ provider: 'openai', model: 'gpt-4o' });

    expect(repo.distinctModels()).toEqual([
      { provider: 'anthropic', model: 'claude-opus-5', turns: 2 },
      { provider: 'openai', model: 'gpt-4o', turns: 1 },
    ]);
  });

  it('reports how far back the ledger reaches', () => {
    expect(repo.earliestTimestamp()).toBeNull();
    add({ timestamp: 5000 });
    add({ timestamp: 2000 });
    expect(repo.earliestTimestamp()).toBe(2000);
  });
});

describe('UsageEventRepository: retention', () => {
  // There is no automatic pruning on this table, unlike activities. Deletion
  // is only ever an explicit user act.
  it('clears only rows older than the cutoff', () => {
    add({ timestamp: 1000 });
    add({ timestamp: 9000 });

    expect(repo.clearBefore(5000)).toBe(1);
    expect(repo.getCount()).toBe(1);
    expect(repo.list()[0].timestamp).toBe(9000);
  });
});
