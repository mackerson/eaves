import Database from 'better-sqlite3';
import { Routine } from '../types';
import { getDatabase } from '../services/database';
import { RoutineRow } from './row-types';

export class RoutineRepository {
  private db: Database.Database;

  /**
   * @param db Injected for tests and the seed loader; production callers use
   * the singletons in ./index.ts and get the app database.
   */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  /**
   * Get all routines for a project
   */
  getByProjectId(projectId: string): Routine[] {
    const rows = this.db.prepare(`
      SELECT id, project_id, name, description, workflow_id, cron_schedule, enabled,
             last_run, next_run, pinned, last_status, last_error, consecutive_failures,
             created_at, updated_at
      FROM routines
      WHERE project_id = ?
      ORDER BY created_at DESC
    `).all(projectId) as RoutineRow[];

    return rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      description: row.description ?? undefined,
      workflowId: row.workflow_id,
      cronSchedule: row.cron_schedule,
      enabled: Boolean(row.enabled),
      lastRun: row.last_run ?? undefined,
      nextRun: row.next_run ?? undefined,
      pinned: Boolean(row.pinned),
      lastStatus: row.last_status ?? undefined,
      lastError: row.last_error ?? undefined,
      consecutiveFailures: row.consecutive_failures ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getById(id: string): Routine | null {
    const row = this.db.prepare(`
      SELECT id, project_id, name, description, workflow_id, cron_schedule, enabled,
             last_run, next_run, pinned, last_status, last_error, consecutive_failures,
             created_at, updated_at
      FROM routines
      WHERE id = ?
    `).get(id) as RoutineRow | undefined;

    if (!row) return null;

    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      description: row.description ?? undefined,
      workflowId: row.workflow_id,
      cronSchedule: row.cron_schedule,
      enabled: Boolean(row.enabled),
      lastRun: row.last_run ?? undefined,
      nextRun: row.next_run ?? undefined,
      pinned: Boolean(row.pinned),
      lastStatus: row.last_status ?? undefined,
      lastError: row.last_error ?? undefined,
      consecutiveFailures: row.consecutive_failures ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Get routines that need to run (enabled and nextRun <= now)
   */
  getDueRoutines(): Routine[] {
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT id, project_id, name, description, workflow_id, cron_schedule, enabled,
             last_run, next_run, pinned, last_status, last_error, consecutive_failures,
             created_at, updated_at
      FROM routines
      WHERE enabled = 1 AND next_run <= ?
      ORDER BY next_run ASC
    `).all(now) as RoutineRow[];

    return rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      description: row.description ?? undefined,
      workflowId: row.workflow_id,
      cronSchedule: row.cron_schedule,
      enabled: Boolean(row.enabled),
      lastRun: row.last_run ?? undefined,
      nextRun: row.next_run ?? undefined,
      pinned: Boolean(row.pinned),
      lastStatus: row.last_status ?? undefined,
      lastError: row.last_error ?? undefined,
      consecutiveFailures: row.consecutive_failures ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Run outcome is owned by the scheduler (see recordRun), never by callers. */
  create(
    data: Omit<
      Routine,
      'id' | 'createdAt' | 'updatedAt' | 'pinned' | 'lastStatus' | 'lastError' | 'consecutiveFailures'
    >
  ): Routine {
    const id = `routine-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO routines (id, project_id, name, description, workflow_id, cron_schedule,
                            enabled, last_run, next_run, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.projectId,
      data.name,
      data.description || null,
      data.workflowId || null,
      data.cronSchedule,
      data.enabled ? 1 : 0,
      data.lastRun || null,
      data.nextRun || null,
      now,
      now
    );

    return this.getById(id)!;
  }

  update(id: string, data: Partial<Omit<Routine, 'id' | 'projectId' | 'createdAt'>>): Routine | null {
    const routine = this.getById(id);
    if (!routine) return null;

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      params.push(data.name);
    }
    if (data.description !== undefined) {
      updates.push('description = ?');
      params.push(data.description);
    }
    if (data.pinned !== undefined) {
      updates.push('pinned = ?');
      params.push(data.pinned ? 1 : 0);
    }
    if (data.workflowId !== undefined) {
      updates.push('workflow_id = ?');
      params.push(data.workflowId);
    }
    if (data.cronSchedule !== undefined) {
      updates.push('cron_schedule = ?');
      params.push(data.cronSchedule);
    }
    if (data.enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(data.enabled ? 1 : 0);
    }
    if (data.lastRun !== undefined) {
      updates.push('last_run = ?');
      params.push(data.lastRun);
    }
    if (data.nextRun !== undefined) {
      updates.push('next_run = ?');
      params.push(data.nextRun);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(Date.now());
      params.push(id);

      this.db.prepare(`
        UPDATE routines
        SET ${updates.join(', ')}
        WHERE id = ?
      `).run(...params);
    }

    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM routines WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * Update routine run times (for scheduler)
   */
  updateRunTimes(id: string, lastRun: number, nextRun: number): boolean {
    const result = this.db.prepare(`
      UPDATE routines
      SET last_run = ?, next_run = ?, updated_at = ?
      WHERE id = ?
    `).run(lastRun, nextRun, Date.now(), id);

    return result.changes > 0;
  }

  /**
   * Record run times together with the outcome. Callers should prefer this over
   * updateRunTimes so a routine that keeps failing is visible without having to
   * reconstruct it from the activity feed.
   */
  recordRun(
    id: string,
    lastRun: number,
    nextRun: number,
    outcome: { status: 'success' | 'failure'; error?: string }
  ): boolean {
    const failed = outcome.status === 'failure';
    const result = this.db.prepare(`
      UPDATE routines
      SET last_run = ?,
          next_run = ?,
          last_status = ?,
          last_error = ?,
          consecutive_failures = CASE WHEN ? THEN consecutive_failures + 1 ELSE 0 END,
          updated_at = ?
      WHERE id = ?
    `).run(
      lastRun,
      nextRun,
      outcome.status,
      failed ? (outcome.error ?? null) : null,
      failed ? 1 : 0,
      Date.now(),
      id
    );

    return result.changes > 0;
  }
}
