import Database from 'better-sqlite3';
import { getDatabase } from '../services/database';
import { PluginGrantRow } from './row-types';
import { safeJsonParse } from '../utils/safeJson';

export interface PluginGrant {
  permissions: string[];
  version: string | null;
  consentedAt: number;
}

/**
 * Records the user's pre-install permission consent for an installed plugin —
 * the grants shown and approved at install time (marketplace V1). V1 uses this
 * as the consent record / audit trail; enforcing it at load (instead of the raw
 * manifest) is V3. See `MarketplaceService.ts` for the install flow.
 */
export class PluginGrantsRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  get(pluginId: string): PluginGrant | null {
    const row = this.db
      .prepare('SELECT permissions, version, consented_at FROM plugin_grants WHERE plugin_id = ?')
      .get(pluginId) as PluginGrantRow | undefined;
    if (!row) return null;
    return {
      permissions: safeJsonParse<string[]>(row.permissions, []),
      version: row.version,
      consentedAt: row.consented_at,
    };
  }

  set(pluginId: string, permissions: string[], version: string | null, consentedAt: number): void {
    this.db.prepare(`
      INSERT INTO plugin_grants (plugin_id, permissions, version, consented_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_id)
      DO UPDATE SET permissions = excluded.permissions, version = excluded.version, consented_at = excluded.consented_at
    `).run(pluginId, JSON.stringify(permissions), version, consentedAt);
  }

  delete(pluginId: string): void {
    this.db.prepare('DELETE FROM plugin_grants WHERE plugin_id = ?').run(pluginId);
  }
}
