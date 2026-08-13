/**
 * Shared in-memory SQLite helpers for repository / service tests.
 *
 * Callers still own `vi.mock` for logger + getDatabase (hoisted). Use this
 * only for create/migrate/close so we don't re-copy the preamble five times.
 */
import Database from 'better-sqlite3';
import { runMigrations } from '../main/services/migrations';

export function createTestDatabase(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, 0);
  return db;
}

export function closeTestDatabase(db: Database.Database | null | undefined): void {
  if (db) db.close();
}

/** Minimal agent row so FK-dependent tables (agent_memories, grants, …) accept inserts. */
export function seedAgent(
  db: Database.Database,
  id = 'agent-1',
  overrides: Partial<{ name: string; provider: string; model: string; color: string }> = {},
): string {
  db.prepare(`
    INSERT INTO agents (id, name, description, provider, model, color, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.name ?? 'Tester',
    '',
    overrides.provider ?? 'openrouter',
    overrides.model ?? 'test-model',
    overrides.color ?? '#2563eb',
    Date.now(),
  );
  return id;
}

/** Minimal channel row for grant/container FKs. */
export function seedChannel(
  db: Database.Database,
  id = 'channel-1',
  overrides: Partial<{ name: string; type: string }> = {},
): string {
  db.prepare(`
    INSERT INTO channels (id, name, type, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, overrides.name ?? 'Test Channel', overrides.type ?? 'public', Date.now());
  return id;
}

/** Minimal project row when conversation_folders.project_id FK is used. */
export function seedProject(
  db: Database.Database,
  id = 'proj-1',
  name = 'Test Project',
): string {
  db.prepare(`
    INSERT INTO projects (id, name, description, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, name, '', Date.now());
  return id;
}
