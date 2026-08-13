import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { Deadline, DeadlinePriority } from '../types';
import { getDatabase } from '../services/database';
import { EventTableRow } from './EventRepository';
import { buildUpdateFields } from '../utils/buildUpdateFields';

/**
 * Deadlines are a subtype of the unified `events` table (`type = 'deadline'`).
 * Column mapping: `dueDate` <-> `start_time`, `priority` <-> `priority`,
 * `isHard` <-> `is_hard`.
 */
export class DeadlineRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Get all deadlines across all projects
   */
  getAll(): Deadline[] {
    const rows = this.db.prepare(
      "SELECT * FROM events WHERE type = 'deadline' ORDER BY start_time ASC"
    ).all() as EventTableRow[];
    return rows.map(this.mapRowToDeadline);
  }

  getById(id: string): Deadline | null {
    const row = this.db.prepare(
      "SELECT * FROM events WHERE id = ? AND type = 'deadline'"
    ).get(id) as EventTableRow | undefined;
    if (!row) return null;
    return this.mapRowToDeadline(row);
  }

  /**
   * Get all deadlines for a specific project
   */
  getByProjectId(projectId: string): Deadline[] {
    const rows = this.db.prepare(
      "SELECT * FROM events WHERE project_id = ? AND type = 'deadline' ORDER BY start_time ASC"
    ).all(projectId) as EventTableRow[];
    return rows.map(this.mapRowToDeadline);
  }

  /**
   * Get deadlines by priority
   * @param priority - Filter by deadline priority
   * @param projectId - Optional project filter
   */
  getByPriority(priority: DeadlinePriority, projectId?: string): Deadline[] {
    let query = "SELECT * FROM events WHERE type = 'deadline' AND priority = ?";
    const params: (string | number)[] = [priority];

    if (projectId) {
      query += ' AND project_id = ?';
      params.push(projectId);
    }

    query += ' ORDER BY start_time ASC';
    const rows = this.db.prepare(query).all(...params) as EventTableRow[];
    return rows.map(this.mapRowToDeadline);
  }

  /**
   * Get deadlines within a date range
   * @param startDate - Unix timestamp for range start
   * @param endDate - Unix timestamp for range end
   * @param projectId - Optional project filter
   */
  getByDateRange(startDate: number, endDate: number, projectId?: string): Deadline[] {
    let query = "SELECT * FROM events WHERE type = 'deadline' AND start_time >= ? AND start_time <= ?";
    const params: (string | number)[] = [startDate, endDate];

    if (projectId) {
      query += ' AND project_id = ?';
      params.push(projectId);
    }

    query += ' ORDER BY start_time ASC';
    const rows = this.db.prepare(query).all(...params) as EventTableRow[];
    return rows.map(this.mapRowToDeadline);
  }

  /**
   * Get hard deadlines only
   * @param projectId - Optional project filter
   */
  getHardDeadlines(projectId?: string): Deadline[] {
    let query = "SELECT * FROM events WHERE type = 'deadline' AND is_hard = 1";
    const params: string[] = [];

    if (projectId) {
      query += ' AND project_id = ?';
      params.push(projectId);
    }

    query += ' ORDER BY start_time ASC';
    const rows = this.db.prepare(query).all(...params) as EventTableRow[];
    return rows.map(this.mapRowToDeadline);
  }

  create(deadline: Omit<Deadline, 'id' | 'createdAt' | 'updatedAt'>): Deadline {
    const id = `deadline-${randomUUID()}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO events (
        id, project_id, title, description, start_time,
        is_all_day, type, priority, is_hard, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 0, 'deadline', ?, ?, ?, ?)
    `).run(
      id,
      deadline.projectId,
      deadline.title,
      deadline.description || null,
      deadline.dueDate,
      deadline.priority,
      deadline.isHard ? 1 : 0,
      now,
      now
    );

    return {
      id,
      ...deadline,
      createdAt: now,
      updatedAt: now,
    };
  }

  update(id: string, updates: Partial<Omit<Deadline, 'id' | 'createdAt' | 'updatedAt'>>): Deadline | null {
    const { clauses, params } = buildUpdateFields(updates, {
      title: 'title',
      description: { column: 'description', transform: 'nullable' },
      dueDate: 'start_time',
      priority: 'priority',
      isHard: { column: 'is_hard', transform: 'boolInt' },
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
   * Delete a deadline
   * Returns true if deleted, false if not found
   */
  delete(id: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM events WHERE id = ? AND type = 'deadline'"
    ).run(id);
    return result.changes > 0;
  }

  /**
   * Map a database row to a Deadline object
   */
  private mapRowToDeadline(row: EventTableRow): Deadline {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description || undefined,
      dueDate: row.start_time,
      priority: (row.priority || 'medium') as DeadlinePriority,
      isHard: Boolean(row.is_hard),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? 0,
    };
  }
}
