import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeFolderName } from './sandbox/pathContainment';

/**
 * One-time move of the on-disk profile from the Enclave name to the Eaves one.
 *
 * `app.getPath('userData')` is derived from the package name, so the rename
 * silently pointed every install at an empty directory: the app would come up
 * looking like a fresh install with the user's conversations, agents, plugins
 * and API keys still sitting under the old path.
 *
 * This runs as early in main as it can, but it cannot be genuinely first:
 * module-level side effects in anything main imports happen before any
 * statement in main does, and Electron itself writes into userData during
 * startup. So the destination existing is the normal case, not the exception,
 * and the merge below is what actually makes this correct — not the ordering.
 */

const LEGACY_APP_DIR = 'enclave';
const LEGACY_DATA_DIR = 'enclave-data';
const LEGACY_DB = 'enclave.db';
const LEGACY_ATTACHMENTS = 'enclave-attachments';

const DATA_DIR = 'eaves-data';
const DB = 'eaves.db';
const ATTACHMENTS = 'eaves-attachments';

/** Plugin ids the project owns. A third-party id is never ours to rewrite. */
const LEGACY_ID_PREFIX = 'com.enclave.';
const ID_PREFIX = 'com.eaves.';

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
 * Merge `src` into an existing `dst`, recursing into directories.
 *
 * The destination is rarely empty in practice. Electron starts writing into
 * userData before this runs — the crash reporter creates `Crashpad/`, the
 * logger creates `logs/` — and an all-or-nothing skip on those top-level
 * entries stranded the entire history they contain at the old path.
 *
 * Recursing means a directory the destination happens to have already is still
 * populated from the old profile, while individual files that exist at the
 * destination are left alone: those were written by this build, and the point
 * is to fill gaps, never to overwrite live state.
 */
function mergeInto(src: string, dst: string): void {
  for (const entry of fs.readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dst, entry);

    if (!fs.existsSync(to)) {
      move(from, to);
      continue;
    }

    // lstat, not stat: a symlink to a directory is not a directory to recurse
    // into. The profile has several (SingletonLock and friends), and following
    // one would merge into wherever it happens to point.
    if (fs.lstatSync(from).isDirectory() && fs.lstatSync(to).isDirectory()) {
      mergeInto(from, to);
    }
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
    mergeInto(legacyProfile, userData);
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
  migrateInstalledPluginIds(userData);

  return `Migrated profile from ${legacyProfile} to ${userData}`;
}

/**
 * Rewrite the id an installed plugin declares in its own manifest.
 *
 * Migration 77 remaps plugin ids in the database, but a marketplace-installed
 * plugin also carries its id in `plugin.json`, and discovery reads it from
 * there. Renaming only one side leaves the plugin loading under its old id
 * while its grants, storage and — most visibly — its enabled flag sit under
 * the new one, so a plugin the user had disabled comes back enabled with none
 * of its settings.
 *
 * Worse, discovery dedupes by id, so an installed `com.enclave.x` and a
 * bundled `com.eaves.x` are two different plugins and both load. That is the
 * same failure `removeLegacyCollapsedInstall` exists to prevent.
 *
 * The install directory is derived from the id, so it moves too.
 */
function migrateInstalledPluginIds(userData: string): void {
  const pluginsDir = path.join(userData, 'plugins');
  if (!fs.existsSync(pluginsDir)) return;

  for (const entry of fs.readdirSync(pluginsDir)) {
    const dir = path.join(pluginsDir, entry);
    const manifestPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;

    let manifest: { id?: unknown };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      continue; // unreadable manifest: not provably ours, so leave it alone
    }

    const id = manifest.id;
    if (typeof id !== 'string' || !id.startsWith(LEGACY_ID_PREFIX)) continue;

    const newId = `${ID_PREFIX}${id.slice(LEGACY_ID_PREFIX.length)}`;
    manifest.id = newId;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const newDir = path.join(pluginsDir, sanitizeFolderName(newId));
    if (newDir !== dir && !fs.existsSync(newDir)) move(dir, newDir);
  }
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
    if (id.startsWith(LEGACY_ID_PREFIX)) {
      remapped[`${ID_PREFIX}${id.slice(LEGACY_ID_PREFIX.length)}`] = value;
      changed = true;
    } else {
      remapped[id] = value;
    }
  }

  if (changed) fs.writeFileSync(configPath, JSON.stringify(remapped, null, 2), 'utf-8');
}
