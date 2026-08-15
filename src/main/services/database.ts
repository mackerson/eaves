import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { config } from 'dotenv';
import { logger } from './logger';
import { encryptAPIKey } from './encryption';
import { runMigrations } from './migrations';

/**
 * Packaged builds must never take configuration from the ambient environment:
 * `process.cwd()` is wherever the user happened to launch the app from, so a
 * stray `.env` there could otherwise substitute provider credentials. Matches
 * the guard in SettingsRepository.devEnvKeyOverrides.
 */
function isPackagedBuild(): boolean {
  try { return !!app?.isPackaged; } catch { return false; }
}

// Load environment variables. `.env.local` (dev, gitignored) overrides `.env`
// so a developer can supply a known-good key without touching the encrypted
// store — consumed as a dev-only override in SettingsRepository.
if (!isPackagedBuild()) {
  config();
  config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
}

/**
 * Resolved on demand, not at module load.
 *
 * `app.getPath` needs a live Electron app, so computing these eagerly meant
 * that merely *importing* this module — or anything that imports a repository
 * — required Electron. That put an Electron dependency on plain Node code
 * (tests, the seed loader) which never opens the app database at all.
 *
 * Nothing here is cached: the only caller opens the database once and holds
 * the handle.
 */
const dataDir = () => path.join(app.getPath('userData'), 'eaves-data');
const dbPath = () => path.join(dataDir(), 'eaves.db');
const DEFAULT_HUMAN_COLOR = '#2563eb';

let db: Database.Database | null = null;
let vecAvailable = false;
let restoreInProgress = false;

/** Whether the sqlite-vec extension loaded — gates vector (semantic) search. */
export function isVecAvailable(): boolean {
  return vecAvailable;
}

/**
 * Absolute path to the sqlite-vec loadable extension, outside the asar.
 *
 * `sqliteVec.load()` resolves `sqlite-vec-<platform>-<arch>/vec0.<ext>` and
 * hands it to `loadExtension`, i.e. `dlopen` — a native call that does not go
 * through Electron's asar-aware `fs` shim and so cannot read a path inside
 * app.asar. `asarUnpack` in the build config puts the real file on disk next
 * door under app.asar.unpacked, but `require.resolve` still reports the packed
 * path, so rewrite it. Without both halves every packaged build silently fell
 * through to the FTS-only fallback below, permanently.
 *
 * `.node` addons (better-sqlite3) don't need this — electron-builder unpacks
 * them by default and Node's loader already redirects them.
 */
export function resolveVecExtensionPath(): string {
  const resolved = sqliteVec.getLoadablePath();
  return resolved.includes(`app.asar${path.sep}`)
    ? resolved.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    : resolved;
}

export function getDatabase(): Database.Database {
  // A restore replaces eaves.db on disk. Because closing the DB just nulls
  // this singleton, any caller landing in that window would transparently
  // reopen the old file — re-running migrations and creating a fresh WAL —
  // and then have it overwritten underneath a live handle. Timer-driven
  // services (routines, sync, activity persistence, the backup timer itself)
  // are all live at that moment, so the window is real. Fail closed: a
  // logged error from a routine tick is recoverable, a half-replaced database
  // is not.
  if (restoreInProgress) {
    throw new Error('Database is being restored from a backup — restart Eaves to continue');
  }
  if (!db) {
    // Ensure the data directory exists before creating the database
    fs.mkdirSync(dataDir(), { recursive: true });
    db = new Database(dbPath());
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Defense-in-depth against write contention (e.g. a transient overlap with a
    // second instance or the backup copy): wait up to 5s for a lock instead of
    // throwing SQLITE_BUSY immediately (better-sqlite3 default busy_timeout is 0,
    // which drops the write with no retry). The single-instance lock is the real
    // guard; this keeps legitimate momentary locks from surfacing as errors.
    db.pragma('busy_timeout = 5000');
    // Load sqlite-vec (loadable extension) for hybrid vector search. Defensive:
    // if the platform binary is missing/unloadable, memory search degrades to
    // FTS-only rather than crashing DB init.
    try {
      db.loadExtension(resolveVecExtensionPath());
      vecAvailable = true;
      logger.info('[Database] sqlite-vec loaded — semantic search available');
    } catch (err) {
      vecAvailable = false;
      logger.warn('[Database] sqlite-vec unavailable — vector search disabled, FTS only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    initializeSchema();
  }
  return db;
}

function initializeSchema(): void {
  const db = getDatabase();

  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  logger.info('[Database] Current schema version:', currentVersion);

  // Schema creation lives entirely in migrations.ts; this only runs migrations
  // and seeds initial data.
  runMigrations(db, currentVersion);

  const now = Date.now();
  const userName = process.env.USER_NAME || 'User';

  db.prepare(`
    INSERT OR IGNORE INTO settings (id, user_name, created_at, updated_at)
    VALUES (1, ?, ?, ?)
  `).run(userName, now, now);

  // Seed API keys from environment — env vars map to provider ids via the
  // conventional NAME_API_KEY pattern. Merges into any existing JSON so a
  // repeated init doesn't clobber user-entered keys.
  //
  // Development only. In a packaged build this would let an exported shell var
  // (or a `.env` in the launch directory) silently and permanently override the
  // key the user typed in Settings, since the merge below prefers env values.
  const envMapping: Array<[envVar: string, providerId: string]> = isPackagedBuild() ? [] : [
    ['ANTHROPIC_API_KEY', 'anthropic'],
    ['OPENAI_API_KEY', 'openai'],
    ['GOOGLE_API_KEY', 'google'],
    ['OPENROUTER_API_KEY', 'openrouter'],
    ['OLLAMA_API_KEY', 'ollama'],
    ['LMSTUDIO_API_KEY', 'lmstudio'],
  ];
  const envKeys: Record<string, string> = {};
  for (const [envVar, providerId] of envMapping) {
    const value = process.env[envVar];
    if (value) {
      // safeStorage throws when no OS keyring is available (headless Linux).
      // Skipping the seed is correct there; failing here would abort the whole
      // schema init and leave the app unable to boot.
      try {
        const encrypted = encryptAPIKey(value);
        if (encrypted) envKeys[providerId] = encrypted;
      } catch (error) {
        logger.warn('Could not encrypt env-seeded API key; skipping', { providerId, error });
      }
    }
  }
  if (Object.keys(envKeys).length > 0) {
    const row = db.prepare('SELECT api_keys_json FROM settings WHERE id = 1')
      .get() as { api_keys_json: string | null } | undefined;
    let existing: Record<string, string> = {};
    if (row?.api_keys_json) {
      try { existing = JSON.parse(row.api_keys_json) as Record<string, string>; } catch { existing = {}; }
    }
    const merged = { ...existing, ...envKeys };
    db.prepare('UPDATE settings SET api_keys_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(merged), Date.now());
  }

  // Ensure there's exactly one current user. Chat creation requires
  // is_current=1; without it, the chat IPC handlers fail with "No current user".
  // Idempotent: only seeds when no user is currently flagged.
  const currentUserCount = db.prepare(
    'SELECT COUNT(*) as count FROM users WHERE is_current = 1'
  ).get() as { count: number };
  if (currentUserCount.count === 0) {
    const defaultUserId = `user-${now}`;
    db.prepare(`
      INSERT INTO users (id, name, color, is_current, created_at)
      VALUES (?, ?, ?, 1, ?)
    `).run(defaultUserId, userName, DEFAULT_HUMAN_COLOR, now);
    logger.info('Seeded default current user', { id: defaultUserId, name: userName });
  }

  // Create default project and channel on first run (agent creation is handled by OOBE)
  const projectCount = db.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number };
  if (projectCount.count === 0) {
    const defaultProjectId = `project-${now}`;
    db.prepare(`
      INSERT INTO projects (id, name, description, files, created_at)
      VALUES (?, 'Personal', 'Default workspace for personal tasks and notes', '[]', ?)
    `).run(defaultProjectId, now);

    logger.info('Created default project');

    const generalId = 'general-1';
    db.prepare(`
      INSERT INTO channels (id, name, type, project_id, created_at)
      VALUES (?, 'general', 'public', NULL, ?)
    `).run(generalId, now);

    db.prepare(`
      INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, color, joined_at)
      VALUES (?, 'user', 'human', ?, ?, ?)
    `).run(generalId, userName, DEFAULT_HUMAN_COLOR, now);

    logger.info('Created default #general channel');

    db.prepare(`
      UPDATE settings
      SET current_project_id = ?, current_channel_id = ?
      WHERE id = 1
    `).run(defaultProjectId, generalId);

    logger.info('Default setup complete: project and channel ready, awaiting OOBE');
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Close the DB and lock out reopens for the duration of a restore.
 *
 * Deliberately one-way. A restore is always followed by `app.relaunch()`, and
 * a failed one leaves `eaves.db` possibly half-written — in both cases the
 * correct next state is a fresh process, not a reopened handle. There is no
 * unlock; restarting is the unlock.
 */
export function beginDatabaseRestore(): void {
  restoreInProgress = true;
  closeDatabase();
}
