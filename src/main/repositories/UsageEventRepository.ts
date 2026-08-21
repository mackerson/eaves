import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { getDatabase } from '../services/database';
import { CountRow } from './row-types';
import {
  CostBasis,
  UsageBucket,
  UsageDimension,
  UsageEvent,
  UsageFilter,
  UsageRollup,
} from '../../shared/types';

export interface CreateUsageEventInput {
  timestamp: number;
  agentId?: string | null;
  agentName?: string | null;
  projectId?: string | null;
  containerId?: string | null;
  kind: string;
  provider: string;
  model: string;
  servedProvider?: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  costBasis: CostBasis;
  energyWh: number | null;
  energyLowWh: number | null;
  energyHighWh: number | null;
  energyBasis: 'measured' | 'estimated' | null;
  durationMs?: number | null;
  usageIsTotal: boolean;
}

interface UsageEventRow {
  id: string;
  timestamp: number;
  agent_id: string | null;
  agent_name: string | null;
  project_id: string | null;
  container_id: string | null;
  kind: string;
  provider: string;
  model: string;
  served_provider: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  cost_basis: string;
  energy_wh: number | null;
  energy_low_wh: number | null;
  energy_high_wh: number | null;
  energy_basis: string | null;
  duration_ms: number | null;
  usage_is_total: number;
}

interface RollupRow {
  key: string | null;
  label: string | null;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  energy_wh: number | null;
  energy_low_wh: number | null;
  energy_high_wh: number | null;
  unpriced_turns: number;
  partial_turns: number;
  estimated_energy_turns: number;
}

/**
 * The SELECT list every rollup shares.
 *
 * Two things here are deliberate and easy to get wrong if this is ever
 * rewritten:
 *
 *   - `SUM(cost_usd)` skips NULLs, which is what we want arithmetically (an
 *     unknown price must not be treated as zero dollars) but leaves the total
 *     silently short. `unpriced_turns` counts exactly those rows so the UI can
 *     say "plus N unpriced turns" instead of presenting a floor as a total.
 *   - `estimated_energy_turns` counts rows whose energy was estimated. A
 *     bucket is only 'measured' when that count is zero; see sumEnergy.
 */
const ROLLUP_AGGREGATES = `
  COUNT(*) AS turns,
  COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(u.cached_tokens), 0) AS cached_tokens,
  COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(u.cost_usd), 0) AS cost_usd,
  COALESCE(SUM(u.energy_wh), 0) AS energy_wh,
  COALESCE(SUM(u.energy_low_wh), 0) AS energy_low_wh,
  COALESCE(SUM(u.energy_high_wh), 0) AS energy_high_wh,
  SUM(CASE WHEN u.cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_turns,
  SUM(CASE WHEN u.usage_is_total = 0 THEN 1 ELSE 0 END) AS partial_turns,
  SUM(CASE WHEN u.energy_basis IS NULL OR u.energy_basis = 'estimated' THEN 1 ELSE 0 END) AS estimated_energy_turns
`;

/**
 * How each dimension names its buckets.
 *
 * Agent and project group by *id* but display a name, because names collide
 * and ids do not — two agents called "Researcher" are two rows, not one. The
 * agent label comes from the ledger's own snapshotted `agent_name` rather than
 * a join against `agents`, so a deleted agent's spend keeps its name instead
 * of collapsing into a nameless bucket.
 */
const DIMENSIONS: Record<UsageDimension, { key: string; label: string; join?: string }> = {
  agent: { key: "COALESCE(u.agent_id, 'unattributed')", label: "COALESCE(u.agent_name, 'Unattributed')" },
  provider: { key: 'u.provider', label: 'u.provider' },
  model: { key: 'u.model', label: 'u.model' },
  // LEFT JOIN, not INNER: a ledger row outlives the project it was spent
  // under, and an inner join would drop that history from the breakdown
  // entirely rather than showing it under its id.
  project: {
    key: "COALESCE(u.project_id, 'none')",
    label: "COALESCE(p.name, u.project_id, 'No project')",
    join: 'LEFT JOIN projects p ON p.id = u.project_id',
  },
  kind: { key: 'u.kind', label: 'u.kind' },
};

/**
 * SQLite strftime formats per bucket width. Computed in the query rather than
 * in JS so an empty range costs one statement instead of a full row scan.
 *
 * `'unixepoch', 'localtime'` matters: a "day" is the user's day. Bucketing in
 * UTC puts an evening turn into tomorrow for anyone west of Greenwich, which
 * makes "today's spend" disagree with the sidebar for half the planet.
 */
const BUCKET_FORMATS: Record<UsageBucket, string> = {
  hour: '%Y-%m-%dT%H:00',
  day: '%Y-%m-%d',
  week: '%Y-W%W',
};

export class UsageEventRepository {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  create(input: CreateUsageEventInput): UsageEvent {
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO usage_events (
        id, timestamp, agent_id, agent_name, project_id, container_id, kind,
        provider, model, served_provider,
        input_tokens, output_tokens, cached_tokens, cache_write_tokens,
        cost_usd, cost_basis,
        energy_wh, energy_low_wh, energy_high_wh, energy_basis,
        duration_ms, usage_is_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.timestamp,
      input.agentId ?? null,
      input.agentName ?? null,
      input.projectId ?? null,
      input.containerId ?? null,
      input.kind,
      input.provider,
      input.model,
      input.servedProvider ?? null,
      input.inputTokens,
      input.outputTokens,
      input.cachedTokens,
      input.cacheWriteTokens,
      input.costUsd,
      input.costBasis,
      input.energyWh,
      input.energyLowWh,
      input.energyHighWh,
      input.energyBasis,
      input.durationMs ?? null,
      input.usageIsTotal ? 1 : 0,
    );

    return {
      id,
      timestamp: input.timestamp,
      agentId: input.agentId ?? undefined,
      agentName: input.agentName ?? undefined,
      projectId: input.projectId ?? undefined,
      containerId: input.containerId ?? undefined,
      kind: input.kind,
      provider: input.provider,
      model: input.model,
      servedProvider: input.servedProvider ?? undefined,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedTokens: input.cachedTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      costUsd: input.costUsd,
      costBasis: input.costBasis,
      energyWh: input.energyWh,
      energyLowWh: input.energyLowWh,
      energyHighWh: input.energyHighWh,
      energyBasis: input.energyBasis,
      durationMs: input.durationMs ?? undefined,
      usageIsTotal: input.usageIsTotal,
    };
  }

  private toEvent(row: UsageEventRow): UsageEvent {
    return {
      id: row.id,
      timestamp: row.timestamp,
      agentId: row.agent_id ?? undefined,
      agentName: row.agent_name ?? undefined,
      projectId: row.project_id ?? undefined,
      containerId: row.container_id ?? undefined,
      kind: row.kind,
      provider: row.provider,
      model: row.model,
      servedProvider: row.served_provider ?? undefined,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedTokens: row.cached_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      costUsd: row.cost_usd,
      costBasis: row.cost_basis as CostBasis,
      energyWh: row.energy_wh,
      energyLowWh: row.energy_low_wh,
      energyHighWh: row.energy_high_wh,
      energyBasis: (row.energy_basis as UsageEvent['energyBasis']) ?? null,
      durationMs: row.duration_ms ?? undefined,
      usageIsTotal: row.usage_is_total === 1,
    };
  }

  /**
   * Build the shared WHERE clause. Every read path goes through this so a
   * filter added here reaches the totals, the series and every breakdown at
   * once — the failure mode otherwise is a view whose breakdowns quietly
   * disagree with its own header.
   */
  private where(filter: UsageFilter): { sql: string; params: (string | number)[] } {
    const clauses: string[] = ['1=1'];
    const params: (string | number)[] = [];

    if (filter.startTime != null) {
      clauses.push('u.timestamp >= ?');
      params.push(filter.startTime);
    }
    if (filter.endTime != null) {
      clauses.push('u.timestamp <= ?');
      params.push(filter.endTime);
    }
    if (filter.projectId) {
      clauses.push('u.project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.agentId) {
      clauses.push('u.agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.provider) {
      clauses.push('u.provider = ?');
      params.push(filter.provider);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      clauses.push(`u.kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }

    return { sql: clauses.join(' AND '), params };
  }

  private toRollup(row: RollupRow, fallbackKey = 'all'): UsageRollup {
    return {
      key: row.key ?? fallbackKey,
      label: row.label ?? fallbackKey,
      turns: row.turns,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedTokens: row.cached_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      costUsd: row.cost_usd ?? 0,
      energyWh: row.energy_wh ?? 0,
      energyLowWh: row.energy_low_wh ?? 0,
      energyHighWh: row.energy_high_wh ?? 0,
      unpricedTurns: row.unpriced_turns,
      partialTurns: row.partial_turns,
      energyMeasured: row.turns > 0 && row.estimated_energy_turns === 0,
    };
  }

  /** Grand totals for the filtered slice. */
  totals(filter: UsageFilter = {}): UsageRollup {
    const { sql, params } = this.where(filter);
    const row = this.db.prepare(
      `SELECT NULL AS key, NULL AS label, ${ROLLUP_AGGREGATES} FROM usage_events u WHERE ${sql}`
    ).get(...params) as RollupRow;
    return this.toRollup(row, 'total');
  }

  /** Breakdown by one dimension, largest cost first. */
  breakdown(dimension: UsageDimension, filter: UsageFilter = {}, limit = 50): UsageRollup[] {
    const dim = DIMENSIONS[dimension];
    const { sql, params } = this.where(filter);
    const rows = this.db.prepare(`
      SELECT ${dim.key} AS key, ${dim.label} AS label, ${ROLLUP_AGGREGATES}
      FROM usage_events u
      ${dim.join ?? ''}
      WHERE ${sql}
      GROUP BY ${dim.key}
      ORDER BY cost_usd DESC, turns DESC
      LIMIT ?
    `).all(...params, limit) as RollupRow[];
    return rows.map(r => this.toRollup(r));
  }

  /** Time series over the filtered slice, oldest bucket first. */
  series(bucket: UsageBucket, filter: UsageFilter = {}): UsageRollup[] {
    const format = BUCKET_FORMATS[bucket];
    const { sql, params } = this.where(filter);
    const expr = `strftime('${format}', u.timestamp / 1000, 'unixepoch', 'localtime')`;
    const rows = this.db.prepare(`
      SELECT ${expr} AS key, ${expr} AS label, ${ROLLUP_AGGREGATES}
      FROM usage_events u
      WHERE ${sql}
      GROUP BY ${expr}
      ORDER BY key ASC
    `).all(...params) as RollupRow[];
    return rows.map(r => this.toRollup(r));
  }

  /** Raw rows, newest first — the drill-down behind an aggregate. */
  list(filter: UsageFilter = {}): UsageEvent[] {
    const { sql, params } = this.where(filter);
    let query = `SELECT u.* FROM usage_events u WHERE ${sql} ORDER BY u.timestamp DESC`;
    const bound = [...params];

    if (filter.limit) {
      query += ' LIMIT ?';
      bound.push(filter.limit);
    }
    if (filter.offset) {
      // SQLite requires LIMIT before OFFSET; -1 means "no limit".
      if (!filter.limit) query += ' LIMIT -1';
      query += ' OFFSET ?';
      bound.push(filter.offset);
    }

    const rows = this.db.prepare(query).all(...bound) as UsageEventRow[];
    return rows.map(r => this.toEvent(r));
  }

  /**
   * Every (provider, model) pair the workspace has actually used, most-used
   * first. Drives the pricing editor, which should show the models the user
   * has models for — not a catalogue of everything the app has heard of.
   */
  distinctModels(): Array<{ provider: string; model: string; turns: number }> {
    return this.db.prepare(`
      SELECT provider, model, COUNT(*) AS turns
      FROM usage_events
      GROUP BY provider, model
      ORDER BY turns DESC
    `).all() as Array<{ provider: string; model: string; turns: number }>;
  }

  /** Timestamp of the oldest row, so the UI can say how far back "all time" reaches. */
  earliestTimestamp(): number | null {
    const row = this.db.prepare('SELECT MIN(timestamp) AS ts FROM usage_events').get() as { ts: number | null };
    return row.ts ?? null;
  }

  getCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM usage_events').get() as CountRow;
    return result.count;
  }

  /**
   * Delete rows older than a timestamp. Only ever called from an explicit user
   * action — there is no automatic retention on this table, unlike
   * `activities`. Pruning a billing record on a timer is how a year-over-year
   * comparison silently becomes impossible.
   */
  clearBefore(timestamp: number): number {
    return this.db.prepare('DELETE FROM usage_events WHERE timestamp < ?').run(timestamp).changes;
  }

  clear(): void {
    this.db.prepare('DELETE FROM usage_events').run();
  }
}
