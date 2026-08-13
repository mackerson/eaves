import Database from 'better-sqlite3';
import { File } from '../types';
import { getDatabase } from '../services/database';
import { FileRow } from './row-types';

export class FileRepository {
  private db: Database.Database;

  /**
   * @param db Injected for tests and the seed loader; production callers use
   * the singletons in ./index.ts and get the app database.
   */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  /**
   * Get all files for a project
   */
  getByProjectId(projectId: string): File[] {
    const rows = this.db.prepare(`
      SELECT id, project_id, name, path, type, size, mime_type, created_at, updated_at
      FROM files
      WHERE project_id = ?
      ORDER BY created_at DESC
    `).all(projectId) as FileRow[];

    return rows.map((row): File => ({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      path: row.path,
      type: row.type as 'file' | 'directory' | 'repository',
      size: row.size,
      mimeType: row.mime_type ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getById(id: string): File | null {
    const row = this.db.prepare(`
      SELECT id, project_id, name, path, type, size, mime_type, created_at, updated_at
      FROM files
      WHERE id = ?
    `).get(id) as FileRow | undefined;

    if (!row) return null;

    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      path: row.path,
      type: row.type as 'file' | 'directory' | 'repository',
      size: row.size,
      mimeType: row.mime_type ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Look up an attachment within one project.
   *
   * Scoped by project because paths are not globally unique to a project: the
   * same folder can legitimately be attached to more than one. Matching on path
   * alone meant attaching a folder that another project already had returned
   * *that* project's row, and the attach was reported as successful while
   * nothing was attached.
   */
  getByPath(path: string, projectId: string): File | null {
    const row = this.db.prepare(`
      SELECT id, project_id, name, path, type, size, mime_type, created_at, updated_at
      FROM files
      WHERE path = ? AND project_id = ?
    `).get(path, projectId) as FileRow | undefined;

    if (!row) return null;

    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      path: row.path,
      type: row.type as 'file' | 'directory' | 'repository',
      size: row.size,
      mimeType: row.mime_type ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  create(data: Omit<File, 'id' | 'createdAt' | 'updatedAt'>): File {
    const id = `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO files (id, project_id, name, path, type, size, mime_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.projectId,
      data.name,
      data.path,
      data.type,
      data.size || null,
      data.mimeType || null,
      now,
      now
    );

    return this.getById(id)!;
  }

  update(id: string, data: Partial<Omit<File, 'id' | 'projectId' | 'createdAt'>>): File | null {
    const file = this.getById(id);
    if (!file) return null;

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      params.push(data.name);
    }
    if (data.path !== undefined) {
      updates.push('path = ?');
      params.push(data.path);
    }
    if (data.type !== undefined) {
      updates.push('type = ?');
      params.push(data.type);
    }
    if (data.size !== undefined) {
      updates.push('size = ?');
      params.push(data.size);
    }
    if (data.mimeType !== undefined) {
      updates.push('mime_type = ?');
      params.push(data.mimeType);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(Date.now());
      params.push(id);

      this.db.prepare(`
        UPDATE files
        SET ${updates.join(', ')}
        WHERE id = ?
      `).run(...params);
    }

    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
    return result.changes > 0;
  }

  deleteByPath(path: string): boolean {
    const result = this.db.prepare('DELETE FROM files WHERE path = ?').run(path);
    return result.changes > 0;
  }
}
