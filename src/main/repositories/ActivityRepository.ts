import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { getDatabase } from '../services/database';
import { safeJsonParseOptional } from '../utils/safeJson';
import { ActivityRow, CountRow, CategoryRow } from './row-types';
import { Activity, ActivityAudience, ActivityFilter } from '../../shared/types';

export type { Activity, ActivityFilter };

/**
 * Input for creating a new activity
 */
export interface CreateActivityInput {
  type: string;
  category: string;
  source: string;
  /** Defaults to 'system' (fail closed — never leaks into the default feed) */
  audience?: ActivityAudience;
  data?: string | null;
  projectId?: string | null;
  /** The agent that caused this, when a single one did. Null is normal. */
  agentId?: string | null;
  timestamp: number;
}

export class ActivityRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  create(input: CreateActivityInput): Activity {
    const id = randomUUID();
    const createdAt = Date.now();
    const audience = input.audience ?? 'system';

    this.db.prepare(`
      INSERT INTO activities (id, type, category, source, audience, data, project_id, agent_id, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.type,
      input.category,
      input.source,
      audience,
      input.data || null,
      input.projectId || null,
      input.agentId || null,
      input.timestamp,
      createdAt
    );

    return {
      id,
      type: input.type,
      category: input.category,
      source: input.source,
      audience,
      data: input.data ? safeJsonParseOptional(input.data, `activity:${id}:data`) : undefined,
      projectId: input.projectId || undefined,
      agentId: input.agentId || undefined,
      timestamp: input.timestamp,
      createdAt,
    };
  }

  getAll(filter: ActivityFilter = {}): Activity[] {
    let query = 'SELECT * FROM activities WHERE 1=1';
    const params: (string | number)[] = [];

    if (filter.types && filter.types.length > 0) {
      query += ` AND type IN (${filter.types.map(() => '?').join(',')})`;
      params.push(...filter.types);
    }

    if (filter.categories && filter.categories.length > 0) {
      query += ` AND category IN (${filter.categories.map(() => '?').join(',')})`;
      params.push(...filter.categories);
    }

    if (filter.sources && filter.sources.length > 0) {
      query += ` AND source IN (${filter.sources.map(() => '?').join(',')})`;
      params.push(...filter.sources);
    }

    if (filter.audience) {
      query += ' AND audience = ?';
      params.push(filter.audience);
    }

    if (filter.projectId) {
      query += ' AND project_id = ?';
      params.push(filter.projectId);
    }

    if (filter.startTime) {
      query += ' AND timestamp >= ?';
      params.push(filter.startTime);
    }

    if (filter.endTime) {
      query += ' AND timestamp <= ?';
      params.push(filter.endTime);
    }

    query += ' ORDER BY timestamp DESC';

    if (filter.limit) {
      query += ' LIMIT ?';
      params.push(filter.limit);
    }

    if (filter.offset) {
      query += ' OFFSET ?';
      params.push(filter.offset);
    }

    const rows = this.db.prepare(query).all(...params) as ActivityRow[];

    return rows.map(row => ({
      id: row.id,
      type: row.type,
      category: row.category,
      source: row.source,
      audience: row.audience as ActivityAudience,
      data: row.data ? safeJsonParseOptional(row.data, `activity:${row.id}:data`) : undefined,
      projectId: row.project_id || undefined,
      agentId: row.agent_id || undefined,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get count of user-facing activities since a given timestamp.
   * Drives the sidebar badge — system telemetry never counts toward it.
   */
  getRecentCount(since: number): number {
    const result = this.db.prepare(
      "SELECT COUNT(*) as count FROM activities WHERE timestamp >= ? AND audience = 'user'"
    ).get(since) as CountRow;
    return result.count;
  }

  /**
   * Get distinct categories that have activities, optionally scoped to an
   * audience so filter pills match what the feed is showing
   */
  getCategories(audience?: ActivityAudience): string[] {
    const rows = (audience
      ? this.db.prepare('SELECT DISTINCT category FROM activities WHERE audience = ? ORDER BY category').all(audience)
      : this.db.prepare('SELECT DISTINCT category FROM activities ORDER BY category').all()
    ) as CategoryRow[];
    return rows.map(r => r.category);
  }

  getById(id: string): Activity | null {
    const row = this.db.prepare('SELECT * FROM activities WHERE id = ?').get(id) as ActivityRow | undefined;

    if (!row) return null;

    return {
      id: row.id,
      type: row.type,
      category: row.category,
      source: row.source,
      audience: row.audience as ActivityAudience,
      data: row.data ? safeJsonParseOptional(row.data, `activity:${row.id}:data`) : undefined,
      projectId: row.project_id || undefined,
      agentId: row.agent_id || undefined,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    };
  }

  clear(): void {
    this.db.prepare('DELETE FROM activities').run();
  }

  /**
   * Clear activities older than a given timestamp
   * Returns number of deleted rows
   */
  clearBefore(timestamp: number): number {
    const result = this.db.prepare('DELETE FROM activities WHERE timestamp < ?').run(timestamp);
    return result.changes;
  }

  getCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM activities').get() as CountRow;
    return result.count;
  }
}
