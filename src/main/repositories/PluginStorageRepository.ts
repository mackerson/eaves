import Database from 'better-sqlite3';
import { getDatabase } from '../services/database';
import { PluginStorageRow } from './row-types';
import { logger } from '../services/logger';

// Namespaced key-value storage for plugins — each plugin gets its own namespace
export class PluginStorageRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  get<T>(pluginId: string, key: string): T | null {
    const row = this.db.prepare('SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?')
      .get(pluginId, key) as PluginStorageRow | undefined;

    if (!row) return null;

    try {
      return JSON.parse(row.value) as T;
    } catch {
      logger.debug(`[PluginStorage] Non-JSON value for ${pluginId}:${key}, returning raw`);
      return row.value as T;
    }
  }

  set<T>(pluginId: string, key: string, value: T): void {
    const now = Date.now();
    const valueStr = typeof value === 'string' ? value : JSON.stringify(value);

    this.db.prepare(`
      INSERT INTO plugin_storage (plugin_id, key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(pluginId, key, valueStr, now, now);
  }

  delete(pluginId: string, key: string): boolean {
    const result = this.db.prepare('DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?')
      .run(pluginId, key);
    return result.changes > 0;
  }

  getAllKeys(pluginId: string): string[] {
    const rows = this.db.prepare('SELECT key FROM plugin_storage WHERE plugin_id = ?')
      .all(pluginId) as Pick<PluginStorageRow, 'key'>[];
    return rows.map(row => row.key);
  }

  getAll<T>(pluginId: string): Record<string, T> {
    const rows = this.db.prepare('SELECT key, value FROM plugin_storage WHERE plugin_id = ?')
      .all(pluginId) as PluginStorageRow[];

    const result: Record<string, T> = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch {
        logger.debug(`[PluginStorage] Non-JSON value for ${pluginId}:${row.key}, returning raw`);
        result[row.key] = row.value as T;
      }
    }
    return result;
  }

  clear(pluginId: string): void {
    this.db.prepare('DELETE FROM plugin_storage WHERE plugin_id = ?').run(pluginId);
  }
}
