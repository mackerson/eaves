import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { User } from '../types';
import { getDatabase } from '../services/database';
import { buildUpdateFields } from '../utils/buildUpdateFields';
import { UserRow } from './row-types';

export class UserRepository {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db || getDatabase();
  }

  getAll(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      color: row.color ?? '',
      isCurrent: row.is_current === 1,
      createdAt: row.created_at,
    }));
  }

  getById(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      color: row.color ?? '',
      isCurrent: row.is_current === 1,
      createdAt: row.created_at,
    };
  }

  getCurrent(): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE is_current = 1').get() as UserRow | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      color: row.color ?? '',
      isCurrent: true,
      createdAt: row.created_at,
    };
  }

  create(user: Omit<User, 'id' | 'createdAt' | 'isCurrent'>): User {
    const id = randomUUID();
    const createdAt = Date.now();

    this.db.prepare(`
      INSERT INTO users (id, name, color, is_current, created_at)
      VALUES (?, ?, ?, 0, ?)
    `).run(id, user.name, user.color, createdAt);

    return {
      id,
      name: user.name,
      color: user.color,
      isCurrent: false,
      createdAt,
    };
  }

  update(id: string, updates: Partial<Pick<User, 'name' | 'color'>>): User | null {
    const { clauses, params } = buildUpdateFields(updates, {
      name: 'name',
      color: 'color',
    });

    if (clauses.length === 0) return this.getById(id);

    params.push(id);
    this.db.prepare(`UPDATE users SET ${clauses.join(', ')} WHERE id = ?`).run(...params);

    const updated = this.getById(id);
    if (updated) {
      this.syncUserContext(updated);
    }
    return updated;
  }

  /**
   * Delete a user (cannot delete current user)
   */
  delete(id: string): boolean {
    // Don't allow deleting the current user
    const user = this.getById(id);
    if (user?.isCurrent) {
      throw new Error('Cannot delete the current user');
    }

    // Drop their channel memberships in the same transaction. Deleting only
    // the users row left channel_participants pointing at an id that no longer
    // resolves, so the deleted user stayed listed in every channel they had
    // joined — and @mention resolution still matched them.
    //
    // Messages are deliberately kept. They carry denormalised
    // sender_display_name/sender_color precisely so history survives the
    // sender, and erasing a conversation is not what "delete this user" means.
    const changes = this.db.transaction(() => {
      this.db.prepare(
        "DELETE FROM channel_participants WHERE participant_id = ? AND participant_type = 'human'"
      ).run(id);
      return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes;
    })();

    return changes > 0;
  }

  /**
   * Switch to a different user
   */
  switchTo(id: string): User | null {
    const user = this.getById(id);
    if (!user) {
      return null;
    }

    // One transaction, not three independent writes. The window between
    // clearing is_current and setting it again is a state with *no* current
    // user, in which getCurrent() returns null and every caller that assumes
    // a user — create-chat, message senders — fails. A crash there left it
    // that way permanently.
    this.db.transaction(() => {
      this.db.prepare('UPDATE users SET is_current = 0').run();
      this.db.prepare('UPDATE users SET is_current = 1 WHERE id = ?').run(id);
      this.db.prepare('UPDATE settings SET current_user_id = ? WHERE id = 1').run(id);
    })();

    return this.getById(id);
  }

  /**
   * Sync user context across channels and messages
   * Updates display name and color for all existing messages and participants
   */
  private syncUserContext(user: User): void {
    this.db.prepare(`
      UPDATE channel_participants
      SET display_name = ?, color = ?
      WHERE participant_id = ? AND participant_type = 'human'
    `).run(user.name, user.color, user.id);

    this.db.prepare(`
      UPDATE messages
      SET sender_display_name = ?, sender_color = ?
      WHERE sender_id = ? AND sender_type = 'human'
    `).run(user.name, user.color, user.id);
  }
}