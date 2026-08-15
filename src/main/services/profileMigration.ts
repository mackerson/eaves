import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * One-time move of the on-disk profile from the Enclave name to the Eaves one.
 *
 * `app.getPath('userData')` is derived from the package name, so the rename
 * silently pointed every install at an empty directory: the app would come up
 * looking like a fresh install with the user's conversations, agents, plugins
 * and API keys still sitting under the old path.
 *
 * This runs at the top of main, before the single-instance lock and before the
 * logger opens a file — both of which write into userData and would otherwise
 * populate the destination before we get to it.
 */

const LEGACY_APP_DIR = 'enclave';
const LEGACY_DATA_DIR = 'enclave-data';
const LEGACY_DB = 'enclave.db';
const LEGACY_ATTACHMENTS = 'enclave-attachments';

const DATA_DIR = 'eaves-data';
const DB = 'eaves.db';
const ATTACHMENTS = 'eaves-attachments';

/**
 * SQLite derives the WAL and shared-memory filenames from the database
 * filename, so they have to travel with it and under the matching name. Moving
 * `enclave.db` alone orphans its `-wal`, discarding every transaction
 * committed since the last checkpoint — which for a profile closed uncleanly
 * is the entire recent history, silently.
 */
const DB_SIDECARS = ['', '-wal', '-shm'];

/** Rename, falling back to a copy when src and dst are on different filesystems. */
function move(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/**
 * @returns a human-readable summary when a migration happened, else null.
 *          Deliberately returns rather than logs: the logger itself lives in
 *          userData, so the caller reports this once logging is safe.
 */
export function migrateLegacyProfile(): string | null {
  const userData = app.getPath('userData');
  const legacyProfile = path.join(path.dirname(userData), LEGACY_APP_DIR);

  // Already migrated, or a genuinely fresh install. Keying on the database
  // rather than on the directory matters: Chromium may have created userData
  // before this runs, so directory existence proves nothing.
  if (fs.existsSync(path.join(userData, DATA_DIR, DB))) return null;
  if (!fs.existsSync(path.join(legacyProfile, LEGACY_DATA_DIR, LEGACY_DB))) return null;

  if (!fs.existsSync(userData)) {
    // The whole profile in one move, which keeps the Chromium state (localStorage,
    // cookies, window bounds) attached to the data it belongs with.
    move(legacyProfile, userData);
  } else {
    // Destination already exists, so merge entry by entry. Anything already
    // present at the destination wins — it was written by this build and is
    // newer than whatever the old profile holds.
    for (const entry of fs.readdirSync(legacyProfile)) {
      const dst = path.join(userData, entry);
      if (fs.existsSync(dst)) continue;
      move(path.join(legacyProfile, entry), dst);
    }
  }

  const dataDir = path.join(userData, LEGACY_DATA_DIR);
  if (fs.existsSync(dataDir)) move(dataDir, path.join(userData, DATA_DIR));

  const renamedDataDir = path.join(userData, DATA_DIR);
  for (const suffix of DB_SIDECARS) {
    const src = path.join(renamedDataDir, `${LEGACY_DB}${suffix}`);
    if (fs.existsSync(src)) move(src, path.join(renamedDataDir, `${DB}${suffix}`));
  }

  const attachments = path.join(renamedDataDir, LEGACY_ATTACHMENTS);
  if (fs.existsSync(attachments)) move(attachments, path.join(renamedDataDir, ATTACHMENTS));

  migratePluginConfigIds(userData);

  return `Migrated profile from ${legacyProfile} to ${userData}`;
}

/**
 * Plugin configuration is keyed by plugin id but lives in a JSON file rather
 * than the database, so migration 77's id remap does not reach it. Left alone,
 * a plugin comes back with its stored settings — including any API keys the
 * user entered — orphaned under its old id.
 *
 * Rewrites keys only. Values are the plugin's own data and are never inspected.
 */
function migratePluginConfigIds(userData: string): void {
  const configPath = path.join(userData, 'plugin-configs.json');
  if (!fs.existsSync(configPath)) return;

  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  const remapped: Record<string, unknown> = {};
  let changed = false;

  for (const [id, value] of Object.entries(parsed)) {
    if (id.startsWith('com.enclave.')) {
      remapped[`com.eaves.${id.slice('com.enclave.'.length)}`] = value;
      changed = true;
    } else {
      remapped[id] = value;
    }
  }

  if (changed) fs.writeFileSync(configPath, JSON.stringify(remapped, null, 2), 'utf-8');
}
