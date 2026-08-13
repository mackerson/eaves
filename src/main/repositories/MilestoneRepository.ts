import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { Milestone } from '../types';
import { getDatabase } from '../services/database';
import { EventTableRow } from './EventRepository';
import { buildUpdateFields } from '../utils/buildUpdateFields';

/**
 * Milestones are a subtype of the unified `events` table (`type = 'milestone'`).
 * Column mapping: `targetDate` <-> `start_time`, `status` <-> `status`.
 */
export class MilestoneRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Get all milestones across all projects
   */
  getAll(): Milestone[] {
    const rows = this.db.prepare(
      "SELECT * FROM events WHERE type = 'milestone' ORDER BY start_time ASC"
    ).all() as EventTableRow[];
    return rows.map(this.mapRowToMilestone);
  }

  getById(id: string): Milestone | null {
    const row = this.db.prepare(
      "SELECT * FROM events WHERE id = ? AND type = 'milestone'"
    ).get(id) as EventTableRow | undefined;
    if (!row) return null;
    return this.mapRowToMilestone(row);
  }

  /**
   * Get all milestones for a specific project
   */
  getByProjectId(projectId: string): Milestone[] {
    const rows = this.db.prepare(
      "SELECT * FROM events WHERE project_id = ? AND type = 'milestone' ORDER BY start_time ASC"
    ).all(projectId) as EventTableRow[];
    return rows.map(this.mapRowToMilestone);
  }

  /**
   * Get milestones by status
   * @param status - Filter by milestone status
   * @param projectId - Optional project filter
   */
  getByStatus(status: 'upcoming' | 'achieved' | 'missed', projectId?: string): Milestone[] {
    let query = "SELECT * FROM events WHERE type = 'milestone' AND status = ?";
    const params: string[] = [status];

    if (projectId) {
      query += ' AND project_id = ?';
      params.push(projectId);
    }

    query += ' ORDER BY start_time ASC';
    const rows = this.db.prepare(query).all(...params) as EventTableRow[];
    return rows.map(this.mapRowToMilestone);
  }

  /**
   * Get milestones within a date range
   * @param startDate - Unix timestamp for range start
   * @param endDate - Unix timestamp for range end
   * @param projectId - Optional project filter
   */
  getByDateRange(startDate: number, endDate: number, projectId?: string): Milestone[] {
    let query = "SELECT * FROM events WHERE type = 'milestone' AND start_time >= ? AND start_time <= ?";
    const params: (string | number)[] = [startDate, endDate];

    if (projectId) {
      query += ' AND project_id = ?';
      params.push(projectId);
    }

    query += ' ORDER BY start_time ASC';
    const rows = this.db.prepare(query).all(...params) as EventTableRow[];
    return rows.map(this.mapRowToMilestone);
  }

  create(milestone: Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>): Milestone {
    const id = `milestone-${randomUUID()}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO events (
        id, project_id, title, description, start_time,
        is_all_day, type, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 0, 'milestone', ?, ?, ?)
    `).run(
      id,
      milestone.projectId,
      milestone.title,
      milestone.description || null,
      milestone.targetDate,
      milestone.status,
      now,
      now
    );

    return {
      id,
      ...milestone,
      createdAt: now,
      updatedAt: now,
    };
  }

  update(id: string, updates: Partial<Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>>): Milestone | null {
    const { clauses, params } = buildUpdateFields(updates, {
      title: 'title',
      description: { column: 'description', transform: 'nullable' },
      targetDate: 'start_time',
      status: 'status',
    });

    if (clauses.length === 0) {
      return this.getById(id);
    }

    clauses.push('updated_at = ?');
    params.push(Date.now());

    params.push(id);
    this.db.prepare(`UPDATE events SET ${clauses.join(', ')} WHERE id = ?`).run(...params);

    return this.getById(id);
  }

  /**
   * Delete a milestone
   * Returns true if deleted, false if not found
   */
  delete(id: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM events WHERE id = ? AND type = 'milestone'"
    ).run(id);
    return result.changes > 0;
  }

  /**
   * Map a database row to a Milestone object
   */
  private mapRowToMilestone(row: EventTableRow): Milestone {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description || undefined,
      targetDate: row.start_time,
      status: (row.status || 'upcoming') as 'upcoming' | 'achieved' | 'missed',
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? 0,
    };
  }
}
