import Database from 'better-sqlite3';
import { Workflow } from '../types';
import { getDatabase } from '../services/database';
import { safeJsonParse } from '../utils/safeJson';
import { WorkflowRow } from './row-types';

// Every column rowToWorkflow reads. An omission here does not fail — the row
// cast makes the missing field `undefined`, which quietly becomes a default —
// so this list and that mapper have to move together.
const SELECT_COLUMNS = `
  id, project_id, name, description, dag_definition, enabled, pinned,
  review_status, created_by, created_at, updated_at
`;

function rowToWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? undefined,
    dagDefinition: safeJsonParse(row.dag_definition, { nodes: [], edges: [] }, `workflow:${row.id}:dagDefinition`),
    enabled: Boolean(row.enabled),
    pinned: Boolean(row.pinned),
    reviewStatus: row.review_status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkflowRepository {
  private db: Database.Database;

  /**
   * @param db Injected for tests and the seed loader; production callers use
   * the singletons in ./index.ts and get the app database.
   */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  /**
   * Get all workflows for a project
   */
  getByProjectId(projectId: string): Workflow[] {
    const rows = this.db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM workflows
      WHERE project_id = ?
      ORDER BY created_at DESC
    `).all(projectId) as WorkflowRow[];

    return rows.map(rowToWorkflow);
  }

  getById(id: string): Workflow | null {
    const row = this.db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM workflows
      WHERE id = ?
    `).get(id) as WorkflowRow | undefined;

    return row ? rowToWorkflow(row) : null;
  }

  /**
   * Count workflows pending human review across all projects.
   * Used by the sidebar badge.
   */
  countPendingReview(projectId?: string): number {
    const row = projectId
      ? this.db.prepare(`SELECT COUNT(*) as c FROM workflows WHERE review_status = 'pending' AND project_id = ?`).get(projectId) as { c: number }
      : this.db.prepare(`SELECT COUNT(*) as c FROM workflows WHERE review_status = 'pending'`).get() as { c: number };
    return row.c;
  }

  /** `pinned` is a UI affordance toggled after creation, never set at create time. */
  create(data: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt' | 'pinned'>): Workflow {
    const id = `workflow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();
    const createdBy = data.createdBy ?? 'user';
    // Fail closed: a workflow whose reviewStatus is unspecified is NOT runnable
    // until a human approves it. Scheduled routines only fire 'approved'
    // workflows (RoutineScheduler review gate), and the code node runs arbitrary
    // JS/Python/shell — so an unreviewed workflow must never auto-run. Trusted
    // callers (the UI, the agent tool) pass an explicit status.
    const reviewStatus = data.reviewStatus ?? 'pending';

    this.db.prepare(`
      INSERT INTO workflows (id, project_id, name, description, dag_definition, enabled, review_status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.projectId,
      data.name,
      data.description || null,
      JSON.stringify(data.dagDefinition),
      data.enabled ? 1 : 0,
      reviewStatus,
      createdBy,
      now,
      now
    );

    return this.getById(id)!;
  }

  update(id: string, data: Partial<Omit<Workflow, 'id' | 'projectId' | 'createdAt'>>): Workflow | null {
    const workflow = this.getById(id);
    if (!workflow) return null;

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
    if (data.dagDefinition !== undefined) {
      updates.push('dag_definition = ?');
      params.push(JSON.stringify(data.dagDefinition));
    }
    if (data.enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(data.enabled ? 1 : 0);
    }
    if (data.reviewStatus !== undefined) {
      updates.push('review_status = ?');
      params.push(data.reviewStatus);
    }
    if (data.pinned !== undefined) {
      updates.push('pinned = ?');
      params.push(data.pinned ? 1 : 0);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(Date.now());
      params.push(id);

      this.db.prepare(`
        UPDATE workflows
        SET ${updates.join(', ')}
        WHERE id = ?
      `).run(...params);
    }

    return this.getById(id);
  }

  setReviewStatus(id: string, status: 'pending' | 'approved'): Workflow | null {
    return this.update(id, { reviewStatus: status });
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
