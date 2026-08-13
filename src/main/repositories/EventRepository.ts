import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { ScheduleEvent } from '../types';
import { getDatabase } from '../services/database';
import { buildUpdateFields } from '../utils/buildUpdateFields';

/**
 * Shape of a row from the unified `events` table.
 *
 * Milestones and deadlines are `events` subtypes selected by the `type` column
 * (`'event' | 'milestone' | 'deadline'`), with their unique fields folded on as
 * nullable columns: `status` (milestone), `priority` + `is_hard` (deadline).
 */
export interface EventTableRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  start_time: number;
  end_time: number | null;
  location: string | null;
  is_all_day: number | null; // SQLite boolean
  type: string | null;
  status: string | null;
  priority: string | null;
  is_hard: number | null; // SQLite boolean
  created_at: number;
  updated_at: number | null;
}

export class EventRepository {
  private db: Database.Database;

  /**
   * @param db Injected for tests and the seed loader; production callers use
   * the singletons in ./index.ts and get the app database.
   */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  /**
   * Get all events (the 'event' subtype) across all projects
   */
  getAll(): ScheduleEvent[] {
    const rows = this.db.prepare(
      "SELECT * FROM events WHERE type = 'event' ORDER BY start_time ASC"
    ).all() as EventTableRow[];
    return rows.map(this.mapRowToEvent);
  }

  getById(id: string): ScheduleEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventTableRow | undefined;
    if (!row) return null;
    return this.mapRowToEvent(row);
  }

  /**
   * Get all events for a specific project
   */
  getByProjectId(projectId: string): ScheduleEvent[] {
    const rows = this.db.prepare(
      "SELECT * FROM events WHERE project_id = ? AND type = 'event' ORDER BY start_time ASC"
    ).all(projectId) as EventTableRow[];
    return rows.map(this.mapRowToEvent);
  }

  /**
   * Get events within a date range
   * @param startTime - Unix timestamp for range start
   * @param endTime - Unix timestamp for range end
   * @param projectId - Optional project filter
   */
  getByDateRange(startTime: number, endTime: number, projectId?: string): ScheduleEvent[] {
    let query = "SELECT * FROM events WHERE type = 'event' AND start_time >= ? AND start_time <= ?";
    const params: (string | number)[] = [startTime, endTime];

    if (projectId) {
      query += ' AND project_id = ?';
      params.push(projectId);
    }

    query += ' ORDER BY start_time ASC';
    const rows = this.db.prepare(query).all(...params) as EventTableRow[];
    return rows.map(this.mapRowToEvent);
  }

  create(event: Omit<ScheduleEvent, 'id' | 'createdAt' | 'updatedAt'>): ScheduleEvent {
    const id = `event-${randomUUID()}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO events (
        id, project_id, title, description, start_time, end_time,
        location, is_all_day, type, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'event', ?, ?)
    `).run(
      id,
      event.projectId,
      event.title,
      event.description || null,
      event.startTime,
      event.endTime || null,
      event.location || null,
      event.isAllDay ? 1 : 0,
      now,
      now
    );

    return {
      id,
      ...event,
      createdAt: now,
      updatedAt: now,
    };
  }

  update(id: string, updates: Partial<Omit<ScheduleEvent, 'id' | 'createdAt' | 'updatedAt'>>): ScheduleEvent | null {
    const { clauses, params } = buildUpdateFields(updates, {
      title: 'title',
      description: { column: 'description', transform: 'nullable' },
      startTime: 'start_time',
      endTime: { column: 'end_time', transform: 'nullable' },
      location: { column: 'location', transform: 'nullable' },
      isAllDay: { column: 'is_all_day', transform: 'boolInt' },
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
   * Delete an event
   * Returns true if deleted, false if not found
   */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * Map a database row to a ScheduleEvent object
   */
  private mapRowToEvent(row: EventTableRow): ScheduleEvent {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description || undefined,
      startTime: row.start_time,
      endTime: row.end_time || undefined,
      location: row.location || undefined,
      isAllDay: Boolean(row.is_all_day),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? 0,
    };
  }
}
