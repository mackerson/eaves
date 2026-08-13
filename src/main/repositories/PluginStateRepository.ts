import Database from 'better-sqlite3';
import { getDatabase } from '../services/database';
import { PluginStateRow } from './row-types';

/**
 * Persists plugin enabled/disabled state across restarts.
 */
export class PluginStateRepository {
  private db: Database.Database;

  /**
   * @param db Injected for tests and the seed loader; production callers use
   * the singletons in ./index.ts and get the app database.
   */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  isEnabled(pluginId: string): boolean | null {
    const row = this.db.prepare('SELECT enabled FROM plugin_state WHERE plugin_id = ?')
      .get(pluginId) as PluginStateRow | undefined;
    if (!row) return null;
    return row.enabled === 1;
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    this.db.prepare(`
      INSERT INTO plugin_state (plugin_id, enabled)
      VALUES (?, ?)
      ON CONFLICT(plugin_id)
      DO UPDATE SET enabled = excluded.enabled
    `).run(pluginId, enabled ? 1 : 0);
  }

  /** Remove the persisted enabled/disabled row (used on uninstall). */
  delete(pluginId: string): void {
    this.db.prepare('DELETE FROM plugin_state WHERE plugin_id = ?').run(pluginId);
  }

  getAll(): Map<string, boolean> {
    const rows = this.db.prepare('SELECT plugin_id, enabled FROM plugin_state')
      .all() as PluginStateRow[];
    const map = new Map<string, boolean>();
    for (const row of rows) {
      map.set(row.plugin_id, row.enabled === 1);
    }
    return map;
  }
}
