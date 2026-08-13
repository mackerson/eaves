import Database from 'better-sqlite3';
import { getDatabase } from '../services/database';
import { logger } from '../services/logger';
import { ToolSessionStateRow } from './row-types';

/**
 * Persists each context's (chat or channel) set of discovery-enabled tools so
 * the agent's tool selections survive app restarts. In-memory session state
 * (ChatService.chatToolStates) stays the hot path; this is the durable backing
 * store, read on cache miss and written whenever the enabled set changes.
 */
export class ToolStateRepository {
  private db: Database.Database;

  /**
   * @param db Injected for tests and the seed loader; production callers use
   * the singletons in ./index.ts and get the app database.
   */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  /**
   * Enabled tool names for a context, or null if no row exists OR the stored
   * JSON is corrupt. Returning null on a corrupt blob (rather than []) lets
   * loadSessionState re-seed defaults instead of silently locking the chat
   * into an empty tool set — corrupt rows are indistinguishable from "fresh
   * context" downstream.
   */
  get(contextId: string): string[] | null {
    const row = this.db.prepare('SELECT enabled_tools FROM tool_session_states WHERE context_id = ?')
      .get(contextId) as ToolSessionStateRow | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.enabled_tools);
      return Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      logger.warn('[ToolStateRepository] corrupt enabled_tools JSON, treating as missing', {
        contextId, error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  set(contextId: string, toolNames: string[]): void {
    this.db.prepare(`
      INSERT INTO tool_session_states (context_id, enabled_tools, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(context_id)
      DO UPDATE SET enabled_tools = excluded.enabled_tools, updated_at = excluded.updated_at
    `).run(contextId, JSON.stringify(toolNames), Date.now());
  }

  delete(contextId: string): void {
    this.db.prepare('DELETE FROM tool_session_states WHERE context_id = ?').run(contextId);
  }
}
