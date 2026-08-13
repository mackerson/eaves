import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { getDatabase } from '../services/database';
import { ConversationFolder } from '../types';

interface FolderRow {
  id: string;
  project_id: string | null;
  name: string;
  position: number;
  created_at: number;
}

/**
 * Flat folders grouping conversations (chats + channels) in the list panel.
 * Membership lives on channels.folder_id; deleting a folder clears membership
 * rather than cascading, so conversations always survive.
 */
export class ConversationFolderRepository {
  private db: Database.Database;

  /**
   * @param db Injected for tests and the seed loader; production callers use
   * the singletons in ./index.ts and get the app database.
   */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  private mapRow(row: FolderRow): ConversationFolder {
    return {
      id: row.id,
      projectId: row.project_id ?? undefined,
      name: row.name,
      position: row.position,
      createdAt: row.created_at,
    };
  }

  getAll(projectId?: string): ConversationFolder[] {
    const rows = (projectId
      ? this.db.prepare(
          'SELECT * FROM conversation_folders WHERE project_id = ? OR project_id IS NULL ORDER BY position ASC, name ASC'
        ).all(projectId)
      : this.db.prepare(
          'SELECT * FROM conversation_folders ORDER BY position ASC, name ASC'
        ).all()) as FolderRow[];
    return rows.map((r) => this.mapRow(r));
  }

  create(folder: { name: string; projectId?: string }): ConversationFolder {
    const id = `cfolder-${randomUUID()}`;
    const createdAt = Date.now();
    const position = (this.db.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM conversation_folders'
    ).get() as { next: number }).next;

    this.db.prepare(`
      INSERT INTO conversation_folders (id, project_id, name, position, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, folder.projectId ?? null, folder.name, position, createdAt);

    return { id, projectId: folder.projectId, name: folder.name, position, createdAt };
  }

  rename(id: string, name: string): boolean {
    const result = this.db.prepare('UPDATE conversation_folders SET name = ? WHERE id = ?')
      .run(name, id);
    return result.changes > 0;
  }

  /** Deletes the folder and ungroups its conversations (folder_id → NULL). */
  delete(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare('UPDATE channels SET folder_id = NULL WHERE folder_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM conversation_folders WHERE id = ?').run(id);
      return result.changes > 0;
    })();
  }
}
